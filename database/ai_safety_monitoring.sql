-- ============================================================================
-- AI SAFETY MONITORING - POSTGRESQL DATABASE
-- PostgreSQL 14+
-- Chay file nay trong Query Tool cua pgAdmin 4 sau khi da chon database.
-- Tat ca doi tuong duoc dat trong schema: safety
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS safety;
SET search_path TO safety, public;

-- ---------------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------------

DO $$ BEGIN
    CREATE TYPE user_status AS ENUM ('pending', 'active', 'locked', 'disabled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE device_status AS ENUM ('online', 'offline', 'warning', 'maintenance', 'disabled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE severity_level AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE event_status AS ENUM ('new', 'acknowledged', 'resolved', 'dismissed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE incident_status AS ENUM ('open', 'investigating', 'resolved', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE alert_status AS ENUM ('pending', 'sent', 'failed', 'acknowledged');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE notification_channel AS ENUM ('in_app', 'email', 'sms', 'webhook');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE delivery_status AS ENUM ('queued', 'processing', 'sent', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. AUTHENTICATION, USERS, RBAC
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organizations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code            varchar(50) NOT NULL,
    name            varchar(200) NOT NULL,
    timezone        varchar(60) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    is_active       boolean NOT NULL DEFAULT true,
    settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT organizations_code_uq UNIQUE (code),
    CONSTRAINT organizations_code_ck CHECK (code ~ '^[A-Za-z0-9_-]+$')
);

CREATE TABLE IF NOT EXISTS users (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email               varchar(320) NOT NULL,
    username            varchar(60),
    full_name           varchar(150) NOT NULL,
    department          varchar(150),
    job_title           varchar(150),
    phone               varchar(30),
    avatar_url          text,
    status              user_status NOT NULL DEFAULT 'pending',
    email_verified_at   timestamptz,
    last_login_at       timestamptz,
    failed_login_count  integer NOT NULL DEFAULT 0,
    locked_until        timestamptz,
    preferences         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    deleted_at          timestamptz,
    CONSTRAINT users_failed_login_ck CHECK (failed_login_count >= 0),
    CONSTRAINT users_email_not_blank_ck CHECK (btrim(email) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq
    ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_uq
    ON users (lower(username)) WHERE username IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS user_credentials (
    user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash       text NOT NULL,
    password_changed_at timestamptz NOT NULL DEFAULT now(),
    must_change_password boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT password_hash_not_blank_ck CHECK (btrim(password_hash) <> '')
);

CREATE TABLE IF NOT EXISTS roles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code            varchar(60) NOT NULL UNIQUE,
    name            varchar(120) NOT NULL,
    description     text,
    is_system       boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code            varchar(100) NOT NULL UNIQUE,
    name            varchar(150) NOT NULL,
    description     text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id   uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS organization_members (
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    is_default      boolean NOT NULL DEFAULT false,
    joined_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_member_default_uq
    ON organization_members (user_id) WHERE is_default = true;

CREATE TABLE IF NOT EXISTS auth_sessions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash  text NOT NULL UNIQUE,
    ip_address          inet,
    user_agent          text,
    device_name         varchar(150),
    expires_at          timestamptz NOT NULL,
    last_used_at        timestamptz,
    revoked_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT auth_sessions_expiry_ck CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
    ON auth_sessions (user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS login_attempts (
    id              bigserial PRIMARY KEY,
    user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
    email_entered   varchar(320) NOT NULL,
    ip_address      inet,
    user_agent      text,
    succeeded       boolean NOT NULL,
    failure_reason  varchar(100),
    attempted_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_attempts_email_time_idx
    ON login_attempts (lower(email_entered), attempted_at DESC);

CREATE TABLE IF NOT EXISTS verification_tokens (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose         varchar(30) NOT NULL,
    token_hash      text NOT NULL UNIQUE,
    expires_at      timestamptz NOT NULL,
    used_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT verification_tokens_purpose_ck
        CHECK (purpose IN ('verify_email', 'reset_password')),
    CONSTRAINT verification_tokens_expiry_ck CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS verification_tokens_user_idx
    ON verification_tokens (user_id, purpose, expires_at DESC);

-- ---------------------------------------------------------------------------
-- 3. LOCATIONS, ZONES, CAMERAS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sites (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    code            varchar(50) NOT NULL,
    name            varchar(200) NOT NULL,
    address         text,
    latitude        numeric(9,6),
    longitude       numeric(9,6),
    timezone        varchar(60) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    is_active       boolean NOT NULL DEFAULT true,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, code),
    UNIQUE (id, organization_id),
    CONSTRAINT sites_latitude_ck CHECK (latitude BETWEEN -90 AND 90),
    CONSTRAINT sites_longitude_ck CHECK (longitude BETWEEN -180 AND 180)
);

CREATE TABLE IF NOT EXISTS zones (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    site_id         uuid NOT NULL,
    code            varchar(50) NOT NULL,
    name            varchar(150) NOT NULL,
    description     text,
    boundary        jsonb,
    is_restricted   boolean NOT NULL DEFAULT false,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, code),
    UNIQUE (id, organization_id),
    CONSTRAINT zones_site_org_fk
        FOREIGN KEY (site_id, organization_id)
        REFERENCES sites(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cameras (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    site_id             uuid NOT NULL,
    zone_id             uuid,
    code                varchar(60) NOT NULL,
    name                varchar(150) NOT NULL,
    stream_url_encrypted text,
    snapshot_url        text,
    status              device_status NOT NULL DEFAULT 'offline',
    manufacturer        varchar(100),
    model               varchar(100),
    ip_address          inet,
    latitude            numeric(9,6),
    longitude           numeric(9,6),
    fps                 numeric(6,2),
    resolution_width    integer,
    resolution_height   integer,
    installed_at        date,
    last_seen_at        timestamptz,
    config              jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_active           boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, code),
    UNIQUE (id, organization_id),
    CONSTRAINT cameras_site_org_fk
        FOREIGN KEY (site_id, organization_id)
        REFERENCES sites(id, organization_id) ON DELETE CASCADE,
    CONSTRAINT cameras_zone_org_fk
        FOREIGN KEY (zone_id, organization_id)
        REFERENCES zones(id, organization_id) ON DELETE SET NULL,
    CONSTRAINT cameras_fps_ck CHECK (fps IS NULL OR fps > 0),
    CONSTRAINT cameras_resolution_ck CHECK (
        (resolution_width IS NULL AND resolution_height IS NULL)
        OR (resolution_width > 0 AND resolution_height > 0)
    )
);

CREATE INDEX IF NOT EXISTS cameras_site_idx ON cameras (site_id, status);
CREATE INDEX IF NOT EXISTS cameras_zone_idx ON cameras (zone_id) WHERE zone_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_site_access (
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    granted_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    granted_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, site_id)
);

-- ---------------------------------------------------------------------------
-- 4. EXISTING INFERENCE PIPELINE (BACKWARD-COMPATIBLE WITH FASTAPI)
-- These public tables intentionally keep the exact names/columns used by
-- backend/app/database/database.py. Do not move them into the safety schema.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.videos (
    id              serial PRIMARY KEY,
    filename        varchar(255) NOT NULL,
    filepath        text NOT NULL UNIQUE,
    split           varchar(20) NOT NULL,
    duration        double precision,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT videos_duration_ck CHECK (duration IS NULL OR duration >= 0)
);

CREATE TABLE IF NOT EXISTS public.models (
    id              serial PRIMARY KEY,
    name            varchar(100) NOT NULL UNIQUE,
    type            varchar(50) NOT NULL,
    version         varchar(50),
    weight_path     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT models_type_ck CHECK (type IN ('detection', 'classification'))
);

CREATE TABLE IF NOT EXISTS public.inference_history (
    id              serial PRIMARY KEY,
    video_id        integer NOT NULL REFERENCES public.videos(id) ON DELETE RESTRICT,
    model_id        integer NOT NULL REFERENCES public.models(id) ON DELETE RESTRICT,
    camera_id       uuid REFERENCES safety.cameras(id) ON DELETE SET NULL,
    requested_by    uuid REFERENCES safety.users(id) ON DELETE SET NULL,
    status          varchar(30) NOT NULL,
    processing_time double precision,
    output_video    text,
    error_message   text,
    metrics         jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT inference_status_ck CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    CONSTRAINT inference_processing_time_ck CHECK (processing_time IS NULL OR processing_time >= 0),
    CONSTRAINT inference_completed_time_ck CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE IF NOT EXISTS public.predictions (
    id              serial PRIMARY KEY,
    inference_id    integer NOT NULL REFERENCES public.inference_history(id) ON DELETE CASCADE,
    class_name      varchar(100) NOT NULL,
    confidence      double precision NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT predictions_confidence_ck CHECK (confidence BETWEEN 0 AND 1)
);

CREATE TABLE IF NOT EXISTS public.detection_results (
    id              serial PRIMARY KEY,
    inference_id    integer NOT NULL REFERENCES public.inference_history(id) ON DELETE CASCADE,
    class_name      varchar(100) NOT NULL,
    confidence      double precision NOT NULL,
    x1              double precision NOT NULL,
    y1              double precision NOT NULL,
    x2              double precision NOT NULL,
    y2              double precision NOT NULL,
    frame_index     integer NOT NULL DEFAULT 0,
    is_violation    boolean NOT NULL DEFAULT false,
    track_id        varchar(100),
    evidence_url    text,
    evidence_basis  varchar(150),
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT detections_confidence_ck CHECK (confidence BETWEEN 0 AND 1),
    CONSTRAINT detections_coordinates_ck CHECK (x2 >= x1 AND y2 >= y1),
    CONSTRAINT detections_frame_ck CHECK (frame_index >= 0)
);

-- Upgrade safely when backend/migrations/001_init.sql was already executed.
ALTER TABLE public.inference_history
    ADD COLUMN IF NOT EXISTS camera_id uuid REFERENCES safety.cameras(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES safety.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS started_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE public.predictions
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.detection_results
    ADD COLUMN IF NOT EXISTS is_violation boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS track_id varchar(100),
    ADD COLUMN IF NOT EXISTS evidence_url text,
    ADD COLUMN IF NOT EXISTS evidence_basis varchar(150),
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_videos_split ON public.videos (split);
CREATE INDEX IF NOT EXISTS idx_inference_video ON public.inference_history (video_id);
CREATE INDEX IF NOT EXISTS idx_inference_model ON public.inference_history (model_id);
CREATE INDEX IF NOT EXISTS idx_inference_status_time
    ON public.inference_history (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_inference ON public.predictions (inference_id);
CREATE INDEX IF NOT EXISTS idx_detections_inference ON public.detection_results (inference_id);
CREATE INDEX IF NOT EXISTS detection_results_violation_idx
    ON public.detection_results (inference_id, is_violation, frame_index);
CREATE INDEX IF NOT EXISTS idx_detections_class_time
    ON public.detection_results (class_name, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. AI MODELS AND DEPLOYMENTS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_models (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code            varchar(80) NOT NULL,
    name            varchar(150) NOT NULL,
    version         varchar(50) NOT NULL,
    task_type       varchar(80) NOT NULL,
    framework       varchar(80),
    artifact_uri    text,
    labels          jsonb NOT NULL DEFAULT '[]'::jsonb,
    metrics         jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (code, version)
);

CREATE TABLE IF NOT EXISTS model_deployments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    camera_id       uuid NOT NULL,
    model_id        uuid NOT NULL REFERENCES ai_models(id) ON DELETE RESTRICT,
    confidence_threshold numeric(5,4) NOT NULL DEFAULT 0.5000,
    config          jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_enabled      boolean NOT NULL DEFAULT true,
    deployed_at     timestamptz NOT NULL DEFAULT now(),
    stopped_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (camera_id, model_id, deployed_at),
    CONSTRAINT deployments_camera_org_fk
        FOREIGN KEY (camera_id, organization_id)
        REFERENCES cameras(id, organization_id) ON DELETE CASCADE,
    CONSTRAINT deployments_confidence_ck
        CHECK (confidence_threshold BETWEEN 0 AND 1),
    CONSTRAINT deployments_time_ck
        CHECK (stopped_at IS NULL OR stopped_at >= deployed_at)
);

CREATE INDEX IF NOT EXISTS model_deployments_camera_idx
    ON model_deployments (camera_id, is_enabled);

-- ---------------------------------------------------------------------------
-- 5. EVENT TYPES AND AI DETECTION EVENTS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS event_types (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code                varchar(80) NOT NULL UNIQUE,
    name                varchar(150) NOT NULL,
    description         text,
    default_severity    severity_level NOT NULL DEFAULT 'medium',
    icon                varchar(100),
    color               varchar(20),
    is_active           boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS safety_events (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    site_id             uuid NOT NULL,
    zone_id             uuid,
    camera_id           uuid NOT NULL,
    event_type_id       uuid NOT NULL REFERENCES event_types(id) ON DELETE RESTRICT,
    deployment_id       uuid REFERENCES model_deployments(id) ON DELETE SET NULL,
    inference_id        integer REFERENCES public.inference_history(id) ON DELETE SET NULL,
    severity            severity_level NOT NULL,
    status              event_status NOT NULL DEFAULT 'new',
    confidence          numeric(5,4),
    title               varchar(250) NOT NULL,
    description         text,
    object_count        integer NOT NULL DEFAULT 1,
    snapshot_url        text,
    video_url           text,
    thumbnail_url       text,
    bounding_boxes      jsonb NOT NULL DEFAULT '[]'::jsonb,
    raw_payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    deduplication_key   varchar(200),
    detected_at         timestamptz NOT NULL,
    acknowledged_at     timestamptz,
    acknowledged_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    resolved_at         timestamptz,
    resolved_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    resolution_note     text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT events_site_org_fk
        FOREIGN KEY (site_id, organization_id)
        REFERENCES sites(id, organization_id) ON DELETE CASCADE,
    CONSTRAINT events_zone_org_fk
        FOREIGN KEY (zone_id, organization_id)
        REFERENCES zones(id, organization_id) ON DELETE SET NULL,
    CONSTRAINT events_camera_org_fk
        FOREIGN KEY (camera_id, organization_id)
        REFERENCES cameras(id, organization_id) ON DELETE CASCADE,
    CONSTRAINT events_confidence_ck CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    CONSTRAINT events_object_count_ck CHECK (object_count >= 0),
    CONSTRAINT events_ack_ck CHECK (acknowledged_at IS NULL OR acknowledged_at >= detected_at),
    CONSTRAINT events_resolve_ck CHECK (resolved_at IS NULL OR resolved_at >= detected_at)
);

CREATE INDEX IF NOT EXISTS events_org_detected_idx
    ON safety_events (organization_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS events_site_detected_idx
    ON safety_events (site_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS events_camera_detected_idx
    ON safety_events (camera_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS events_type_detected_idx
    ON safety_events (event_type_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS events_status_severity_idx
    ON safety_events (organization_id, status, severity, detected_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS events_deduplication_uq
    ON safety_events (organization_id, deduplication_key)
    WHERE deduplication_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_raw_payload_gin_idx
    ON safety_events USING gin (raw_payload);

CREATE TABLE IF NOT EXISTS event_objects (
    id              bigserial PRIMARY KEY,
    event_id        uuid NOT NULL REFERENCES safety_events(id) ON DELETE CASCADE,
    tracking_id     varchar(100),
    class_name      varchar(100) NOT NULL,
    confidence      numeric(5,4),
    bbox_x          numeric(8,6),
    bbox_y          numeric(8,6),
    bbox_width      numeric(8,6),
    bbox_height     numeric(8,6),
    attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT event_objects_confidence_ck CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    CONSTRAINT event_objects_bbox_ck CHECK (
        bbox_x IS NULL OR (
            bbox_x BETWEEN 0 AND 1 AND bbox_y BETWEEN 0 AND 1
            AND bbox_width BETWEEN 0 AND 1 AND bbox_height BETWEEN 0 AND 1
        )
    )
);

CREATE INDEX IF NOT EXISTS event_objects_event_idx ON event_objects (event_id);

-- ---------------------------------------------------------------------------
-- 6. INCIDENT MANAGEMENT
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS incidents (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    site_id             uuid NOT NULL,
    incident_no         bigint GENERATED ALWAYS AS IDENTITY,
    title               varchar(250) NOT NULL,
    description         text,
    severity            severity_level NOT NULL DEFAULT 'medium',
    status              incident_status NOT NULL DEFAULT 'open',
    assigned_to         uuid REFERENCES users(id) ON DELETE SET NULL,
    opened_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    opened_at           timestamptz NOT NULL DEFAULT now(),
    due_at              timestamptz,
    resolved_at         timestamptz,
    closed_at           timestamptz,
    resolution          text,
    root_cause          text,
    corrective_action   text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, incident_no),
    CONSTRAINT incidents_site_org_fk
        FOREIGN KEY (site_id, organization_id)
        REFERENCES sites(id, organization_id) ON DELETE CASCADE,
    CONSTRAINT incidents_due_ck CHECK (due_at IS NULL OR due_at >= opened_at),
    CONSTRAINT incidents_resolved_ck CHECK (resolved_at IS NULL OR resolved_at >= opened_at),
    CONSTRAINT incidents_closed_ck CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

CREATE INDEX IF NOT EXISTS incidents_org_status_idx
    ON incidents (organization_id, status, severity, opened_at DESC);
CREATE INDEX IF NOT EXISTS incidents_assigned_idx
    ON incidents (assigned_to, status) WHERE assigned_to IS NOT NULL;

CREATE TABLE IF NOT EXISTS incident_events (
    incident_id     uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    event_id        uuid NOT NULL REFERENCES safety_events(id) ON DELETE CASCADE,
    linked_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    linked_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (incident_id, event_id),
    UNIQUE (event_id)
);

CREATE TABLE IF NOT EXISTS incident_comments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id     uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
    body            text NOT NULL,
    attachments     jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz,
    CONSTRAINT incident_comments_body_ck CHECK (btrim(body) <> '')
);

CREATE INDEX IF NOT EXISTS incident_comments_incident_idx
    ON incident_comments (incident_id, created_at);

CREATE TABLE IF NOT EXISTS incident_status_history (
    id              bigserial PRIMARY KEY,
    incident_id     uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    old_status      incident_status,
    new_status      incident_status NOT NULL,
    changed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    note            text,
    changed_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 7. ALERT RULES, ALERTS, NOTIFICATIONS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS alert_rules (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                varchar(180) NOT NULL,
    description         text,
    event_type_id       uuid REFERENCES event_types(id) ON DELETE CASCADE,
    site_id             uuid REFERENCES sites(id) ON DELETE CASCADE,
    zone_id             uuid REFERENCES zones(id) ON DELETE CASCADE,
    camera_id           uuid REFERENCES cameras(id) ON DELETE CASCADE,
    minimum_severity    severity_level NOT NULL DEFAULT 'medium',
    minimum_confidence  numeric(5,4) NOT NULL DEFAULT 0.5000,
    cooldown_seconds    integer NOT NULL DEFAULT 60,
    active_from         time,
    active_to           time,
    active_weekdays     smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7]::smallint[],
    condition_config    jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_active           boolean NOT NULL DEFAULT true,
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT alert_rules_confidence_ck CHECK (minimum_confidence BETWEEN 0 AND 1),
    CONSTRAINT alert_rules_cooldown_ck CHECK (cooldown_seconds >= 0),
    CONSTRAINT alert_rules_weekdays_ck CHECK (active_weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[])
);

CREATE INDEX IF NOT EXISTS alert_rules_org_active_idx
    ON alert_rules (organization_id, is_active);

CREATE TABLE IF NOT EXISTS alert_rule_recipients (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_rule_id   uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    channel         notification_channel NOT NULL,
    user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
    destination     text,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT recipients_target_ck CHECK (user_id IS NOT NULL OR btrim(destination) <> '')
);

CREATE TABLE IF NOT EXISTS alerts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    event_id        uuid NOT NULL REFERENCES safety_events(id) ON DELETE CASCADE,
    rule_id         uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
    status          alert_status NOT NULL DEFAULT 'pending',
    title           varchar(250) NOT NULL,
    message         text NOT NULL,
    acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
    acknowledged_at timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_id, rule_id)
);

CREATE INDEX IF NOT EXISTS alerts_org_status_idx
    ON alerts (organization_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_event_uq
    ON alerts (event_id);

CREATE TABLE IF NOT EXISTS notification_deliveries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id        uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    recipient_id    uuid REFERENCES alert_rule_recipients(id) ON DELETE SET NULL,
    channel         notification_channel NOT NULL,
    destination     text NOT NULL,
    status          delivery_status NOT NULL DEFAULT 'queued',
    provider_message_id varchar(200),
    attempt_count   integer NOT NULL DEFAULT 0,
    last_error      text,
    next_retry_at   timestamptz,
    sent_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT delivery_attempt_count_ck CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS deliveries_queue_idx
    ON notification_deliveries (status, next_retry_at, created_at)
    WHERE status IN ('queued', 'failed');

CREATE TABLE IF NOT EXISTS user_notifications (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alert_id        uuid REFERENCES alerts(id) ON DELETE CASCADE,
    title           varchar(250) NOT NULL,
    message         text NOT NULL,
    action_url      text,
    read_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_notifications_unread_idx
    ON user_notifications (user_id, created_at DESC) WHERE read_at IS NULL;

-- ---------------------------------------------------------------------------
-- 8. DEVICE HEALTH, SYSTEM METRICS, AUDIT LOG
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS camera_health_samples (
    id              bigserial PRIMARY KEY,
    camera_id       uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    status          device_status NOT NULL,
    latency_ms      integer,
    fps             numeric(6,2),
    packet_loss_pct numeric(5,2),
    cpu_usage_pct   numeric(5,2),
    gpu_usage_pct   numeric(5,2),
    temperature_c   numeric(5,2),
    details         jsonb NOT NULL DEFAULT '{}'::jsonb,
    sampled_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT camera_health_latency_ck CHECK (latency_ms IS NULL OR latency_ms >= 0),
    CONSTRAINT camera_health_pct_ck CHECK (
        (packet_loss_pct IS NULL OR packet_loss_pct BETWEEN 0 AND 100)
        AND (cpu_usage_pct IS NULL OR cpu_usage_pct BETWEEN 0 AND 100)
        AND (gpu_usage_pct IS NULL OR gpu_usage_pct BETWEEN 0 AND 100)
    )
);

CREATE INDEX IF NOT EXISTS camera_health_camera_time_idx
    ON camera_health_samples (camera_id, sampled_at DESC);

CREATE TABLE IF NOT EXISTS system_metrics (
    id              bigserial PRIMARY KEY,
    organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
    service_name    varchar(100) NOT NULL,
    metric_name     varchar(100) NOT NULL,
    metric_value    double precision NOT NULL,
    unit            varchar(30),
    labels          jsonb NOT NULL DEFAULT '{}'::jsonb,
    recorded_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_metrics_lookup_idx
    ON system_metrics (organization_id, service_name, metric_name, recorded_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
    id              bigserial PRIMARY KEY,
    organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
    actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    action          varchar(100) NOT NULL,
    entity_type     varchar(100) NOT NULL,
    entity_id       text,
    old_data        jsonb,
    new_data        jsonb,
    ip_address      inet,
    user_agent      text,
    request_id      varchar(100),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_org_time_idx
    ON audit_logs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_time_idx
    ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx
    ON audit_logs (entity_type, entity_id, created_at DESC);

-- Bang tong hop de dashboard van nhanh khi du lieu event lon.
CREATE TABLE IF NOT EXISTS daily_event_statistics (
    stat_date           date NOT NULL,
    organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    site_id             uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    event_type_id       uuid NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
    severity            severity_level NOT NULL,
    total_events        bigint NOT NULL DEFAULT 0,
    acknowledged_events bigint NOT NULL DEFAULT 0,
    resolved_events     bigint NOT NULL DEFAULT 0,
    dismissed_events    bigint NOT NULL DEFAULT 0,
    average_confidence  numeric(7,6),
    average_resolution_seconds numeric(14,2),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (stat_date, organization_id, site_id, event_type_id, severity)
);

CREATE INDEX IF NOT EXISTS daily_stats_org_date_idx
    ON daily_event_statistics (organization_id, stat_date DESC);

-- ---------------------------------------------------------------------------
-- 9. COMMON TRIGGERS
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_organizations_updated_at ON organizations;
CREATE TRIGGER trg_organizations_updated_at BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_roles_updated_at ON roles;
CREATE TRIGGER trg_roles_updated_at BEFORE UPDATE ON roles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_sites_updated_at ON sites;
CREATE TRIGGER trg_sites_updated_at BEFORE UPDATE ON sites
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_zones_updated_at ON zones;
CREATE TRIGGER trg_zones_updated_at BEFORE UPDATE ON zones
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_cameras_updated_at ON cameras;
CREATE TRIGGER trg_cameras_updated_at BEFORE UPDATE ON cameras
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_event_types_updated_at ON event_types;
CREATE TRIGGER trg_event_types_updated_at BEFORE UPDATE ON event_types
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_safety_events_updated_at ON safety_events;
CREATE TRIGGER trg_safety_events_updated_at BEFORE UPDATE ON safety_events
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_incidents_updated_at ON incidents;
CREATE TRIGGER trg_incidents_updated_at BEFORE UPDATE ON incidents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_incident_comments_updated_at ON incident_comments;
CREATE TRIGGER trg_incident_comments_updated_at BEFORE UPDATE ON incident_comments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_alert_rules_updated_at ON alert_rules;
CREATE TRIGGER trg_alert_rules_updated_at BEFORE UPDATE ON alert_rules
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_alerts_updated_at ON alerts;
CREATE TRIGGER trg_alerts_updated_at BEFORE UPDATE ON alerts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_notification_deliveries_updated_at ON notification_deliveries;
CREATE TRIGGER trg_notification_deliveries_updated_at BEFORE UPDATE ON notification_deliveries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Tu dong ghi lich su khi trang thai incident thay doi.
CREATE OR REPLACE FUNCTION log_incident_status_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO incident_status_history (incident_id, old_status, new_status)
        VALUES (NEW.id, NULL, NEW.status);
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO incident_status_history (incident_id, old_status, new_status)
        VALUES (NEW.id, OLD.status, NEW.status);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_incident_status_history ON incidents;
CREATE TRIGGER trg_incident_status_history
AFTER INSERT OR UPDATE OF status ON incidents
FOR EACH ROW EXECUTE FUNCTION log_incident_status_change();

-- ---------------------------------------------------------------------------
-- 10. AUTHENTICATION FUNCTIONS
-- ---------------------------------------------------------------------------

-- Dang ky tai khoan. Mat khau duoc bam bang bcrypt, khong luu plaintext.
CREATE OR REPLACE FUNCTION register_user(
    p_email text,
    p_password text,
    p_full_name text,
    p_username text DEFAULT NULL,
    p_department text DEFAULT NULL,
    p_job_title text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = safety, public
AS $$
DECLARE
    v_user_id uuid;
BEGIN
    p_email := lower(btrim(p_email));
    p_full_name := btrim(p_full_name);
    p_username := nullif(btrim(p_username), '');

    IF p_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' THEN
        RAISE EXCEPTION 'Email khong hop le';
    END IF;
    IF length(p_password) < 8 THEN
        RAISE EXCEPTION 'Mat khau phai co it nhat 8 ky tu';
    END IF;
    IF p_full_name = '' THEN
        RAISE EXCEPTION 'Ho ten khong duoc de trong';
    END IF;

    INSERT INTO users (email, username, full_name, department, job_title, status)
    VALUES (
        p_email, p_username, p_full_name,
        nullif(btrim(p_department), ''),
        nullif(btrim(p_job_title), ''),
        'pending'
    )
    RETURNING id INTO v_user_id;

    INSERT INTO user_credentials (user_id, password_hash)
    VALUES (v_user_id, crypt(p_password, gen_salt('bf', 12)));

    RETURN v_user_id;
EXCEPTION
    WHEN unique_violation THEN
        RAISE EXCEPTION 'Email hoac username da ton tai';
END;
$$;

-- Tao token xac thuc email / dat lai mat khau. Token goc chi tra ve mot lan;
-- database chi luu SHA-256 hash. Backend gui token goc qua email.
CREATE OR REPLACE FUNCTION issue_verification_token(
    p_user_id uuid,
    p_purpose text,
    p_valid_for interval DEFAULT interval '30 minutes'
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = safety, public
AS $$
DECLARE v_plain_token text;
BEGIN
    IF p_purpose NOT IN ('verify_email', 'reset_password') THEN
        RAISE EXCEPTION 'Muc dich token khong hop le';
    END IF;
    IF p_valid_for <= interval '0 seconds' OR p_valid_for > interval '24 hours' THEN
        RAISE EXCEPTION 'Thoi han token phai lon hon 0 va khong qua 24 gio';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user_id AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'Khong tim thay nguoi dung';
    END IF;

    UPDATE verification_tokens
       SET used_at = now()
     WHERE user_id = p_user_id AND purpose = p_purpose AND used_at IS NULL;

    v_plain_token := encode(gen_random_bytes(32), 'hex');
    INSERT INTO verification_tokens (user_id, purpose, token_hash, expires_at)
    VALUES (
        p_user_id,
        p_purpose,
        encode(digest(v_plain_token, 'sha256'), 'hex'),
        now() + p_valid_for
    );
    RETURN v_plain_token;
END;
$$;

CREATE OR REPLACE FUNCTION verify_email_token(p_plain_token text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = safety, public
AS $$
DECLARE
    v_token_id uuid;
    v_user_id uuid;
BEGIN
    SELECT id, user_id INTO v_token_id, v_user_id
      FROM verification_tokens
     WHERE token_hash = encode(digest(p_plain_token, 'sha256'), 'hex')
       AND purpose = 'verify_email'
       AND used_at IS NULL
       AND expires_at > now()
     FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Token khong hop le hoac da het han'; END IF;

    UPDATE verification_tokens SET used_at = now() WHERE id = v_token_id;
    UPDATE users
       SET email_verified_at = COALESCE(email_verified_at, now()), status = 'active'
     WHERE id = v_user_id AND status = 'pending';
    RETURN v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION reset_password_with_token(
    p_plain_token text,
    p_new_password text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = safety, public
AS $$
DECLARE
    v_token_id uuid;
    v_user_id uuid;
BEGIN
    IF length(p_new_password) < 8 THEN
        RAISE EXCEPTION 'Mat khau moi phai co it nhat 8 ky tu';
    END IF;

    SELECT id, user_id INTO v_token_id, v_user_id
      FROM verification_tokens
     WHERE token_hash = encode(digest(p_plain_token, 'sha256'), 'hex')
       AND purpose = 'reset_password'
       AND used_at IS NULL
       AND expires_at > now()
     FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Token khong hop le hoac da het han'; END IF;

    UPDATE user_credentials
       SET password_hash = crypt(p_new_password, gen_salt('bf', 12)),
           password_changed_at = now(),
           must_change_password = false
     WHERE user_id = v_user_id;
    UPDATE verification_tokens SET used_at = now() WHERE id = v_token_id;
    UPDATE auth_sessions SET revoked_at = now()
     WHERE user_id = v_user_id AND revoked_at IS NULL;
    UPDATE users
       SET failed_login_count = 0,
           locked_until = NULL,
           status = CASE WHEN status = 'locked' THEN 'active'::user_status ELSE status END
     WHERE id = v_user_id;
    RETURN v_user_id;
END;
$$;

-- Dang nhap: tra ve thong tin co ban, dong thoi khoa 15 phut sau 5 lan sai.
CREATE OR REPLACE FUNCTION authenticate_user(
    p_email text,
    p_password text,
    p_ip_address inet DEFAULT NULL,
    p_user_agent text DEFAULT NULL
)
RETURNS TABLE (
    authenticated boolean,
    user_id uuid,
    email varchar,
    full_name varchar,
    status user_status,
    message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = safety, public
AS $$
DECLARE
    v_user users%ROWTYPE;
    v_password_hash text;
BEGIN
    SELECT u.*
      INTO v_user
      FROM users u
     WHERE lower(u.email) = lower(btrim(p_email))
       AND u.deleted_at IS NULL;

    IF NOT FOUND THEN
        INSERT INTO login_attempts (email_entered, ip_address, user_agent, succeeded, failure_reason)
        VALUES (lower(btrim(p_email)), p_ip_address, p_user_agent, false, 'invalid_credentials');
        RETURN QUERY SELECT false, NULL::uuid, NULL::varchar, NULL::varchar,
                            NULL::user_status, 'Email hoac mat khau khong dung'::text;
        RETURN;
    END IF;

    SELECT c.password_hash
      INTO v_password_hash
      FROM user_credentials c
     WHERE c.user_id = v_user.id;

    IF v_user.status IN ('disabled', 'pending') THEN
        INSERT INTO login_attempts (user_id, email_entered, ip_address, user_agent, succeeded, failure_reason)
        VALUES (v_user.id, v_user.email, p_ip_address, p_user_agent, false, 'account_inactive');
        RETURN QUERY SELECT false, v_user.id, v_user.email, v_user.full_name,
                            v_user.status, 'Tai khoan chua duoc kich hoat hoac da bi vo hieu hoa'::text;
        RETURN;
    END IF;

    IF v_user.locked_until IS NOT NULL AND v_user.locked_until > now() THEN
        INSERT INTO login_attempts (user_id, email_entered, ip_address, user_agent, succeeded, failure_reason)
        VALUES (v_user.id, v_user.email, p_ip_address, p_user_agent, false, 'account_locked');
        RETURN QUERY SELECT false, v_user.id, v_user.email, v_user.full_name,
                            'locked'::user_status, 'Tai khoan dang tam khoa'::text;
        RETURN;
    END IF;

    IF v_password_hash = crypt(p_password, v_password_hash) THEN
        UPDATE users u
           SET failed_login_count = 0,
               locked_until = NULL,
               status = CASE WHEN u.status = 'locked' THEN 'active'::user_status ELSE u.status END,
               last_login_at = now()
         WHERE u.id = v_user.id;

        INSERT INTO login_attempts (user_id, email_entered, ip_address, user_agent, succeeded)
        VALUES (v_user.id, v_user.email, p_ip_address, p_user_agent, true);

        RETURN QUERY SELECT true, v_user.id, v_user.email, v_user.full_name,
                            'active'::user_status, 'Dang nhap thanh cong'::text;
    ELSE
        UPDATE users u
           SET failed_login_count = u.failed_login_count + 1,
               locked_until = CASE WHEN u.failed_login_count + 1 >= 5
                                   THEN now() + interval '15 minutes'
                                   ELSE u.locked_until END,
               status = CASE WHEN u.failed_login_count + 1 >= 5
                             THEN 'locked'::user_status ELSE u.status END
         WHERE u.id = v_user.id;

        INSERT INTO login_attempts (user_id, email_entered, ip_address, user_agent, succeeded, failure_reason)
        VALUES (v_user.id, v_user.email, p_ip_address, p_user_agent, false, 'invalid_credentials');

        RETURN QUERY SELECT false, v_user.id, v_user.email, v_user.full_name,
                            v_user.status, 'Email hoac mat khau khong dung'::text;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION change_password(
    p_user_id uuid,
    p_current_password text,
    p_new_password text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = safety, public
AS $$
DECLARE
    v_hash text;
BEGIN
    IF length(p_new_password) < 8 THEN
        RAISE EXCEPTION 'Mat khau moi phai co it nhat 8 ky tu';
    END IF;

    SELECT password_hash INTO v_hash
      FROM user_credentials WHERE user_id = p_user_id FOR UPDATE;

    IF NOT FOUND OR v_hash <> crypt(p_current_password, v_hash) THEN
        RAISE EXCEPTION 'Mat khau hien tai khong dung';
    END IF;

    UPDATE user_credentials
       SET password_hash = crypt(p_new_password, gen_salt('bf', 12)),
           password_changed_at = now(),
           must_change_password = false
     WHERE user_id = p_user_id;

    UPDATE auth_sessions SET revoked_at = now()
     WHERE user_id = p_user_id AND revoked_at IS NULL;
    RETURN true;
END;
$$;

-- Backend nen tu sinh refresh token ngau nhien, bam SHA-256 va chi luu hash.
CREATE OR REPLACE FUNCTION create_session(
    p_user_id uuid,
    p_refresh_token_hash text,
    p_expires_at timestamptz,
    p_ip_address inet DEFAULT NULL,
    p_user_agent text DEFAULT NULL,
    p_device_name text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = safety, public
AS $$
DECLARE v_session_id uuid;
BEGIN
    IF p_expires_at <= now() THEN
        RAISE EXCEPTION 'Thoi gian het han phai lon hon hien tai';
    END IF;
    INSERT INTO auth_sessions (
        user_id, refresh_token_hash, expires_at, ip_address, user_agent, device_name
    ) VALUES (
        p_user_id, p_refresh_token_hash, p_expires_at, p_ip_address, p_user_agent, p_device_name
    ) RETURNING id INTO v_session_id;
    RETURN v_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION revoke_session(p_session_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = safety, public
AS $$
    UPDATE auth_sessions
       SET revoked_at = now()
     WHERE id = p_session_id AND user_id = p_user_id AND revoked_at IS NULL
    RETURNING true;
$$;

-- ---------------------------------------------------------------------------
-- 11. EVENT / INCIDENT OPERATIONS
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION acknowledge_event(
    p_event_id uuid,
    p_user_id uuid,
    p_note text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = safety, public
AS $$
BEGIN
    UPDATE safety_events
       SET status = 'acknowledged',
           acknowledged_at = COALESCE(acknowledged_at, now()),
           acknowledged_by = p_user_id,
           resolution_note = COALESCE(p_note, resolution_note)
     WHERE id = p_event_id AND status = 'new';
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION resolve_event(
    p_event_id uuid,
    p_user_id uuid,
    p_resolution_note text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = safety, public
AS $$
BEGIN
    UPDATE safety_events
       SET status = 'resolved',
           acknowledged_at = COALESCE(acknowledged_at, now()),
           acknowledged_by = COALESCE(acknowledged_by, p_user_id),
           resolved_at = now(),
           resolved_by = p_user_id,
           resolution_note = p_resolution_note
     WHERE id = p_event_id AND status IN ('new', 'acknowledged');
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION create_incident_from_event(
    p_event_id uuid,
    p_opened_by uuid,
    p_title text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = safety, public
AS $$
DECLARE
    v_event safety_events%ROWTYPE;
    v_incident_id uuid;
BEGIN
    SELECT * INTO v_event FROM safety_events WHERE id = p_event_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Khong tim thay su kien'; END IF;

    SELECT incident_id INTO v_incident_id FROM incident_events WHERE event_id = p_event_id;
    IF FOUND THEN RETURN v_incident_id; END IF;

    INSERT INTO incidents (
        organization_id, site_id, title, description, severity, opened_by
    ) VALUES (
        v_event.organization_id,
        v_event.site_id,
        COALESCE(NULLIF(btrim(p_title), ''), v_event.title),
        v_event.description,
        v_event.severity,
        p_opened_by
    ) RETURNING id INTO v_incident_id;

    INSERT INTO incident_events (incident_id, event_id, linked_by)
    VALUES (v_incident_id, p_event_id, p_opened_by);

    RETURN v_incident_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 12. DASHBOARD VIEWS AND REPORT FUNCTIONS
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_active_users AS
SELECT
    u.id, u.email, u.username, u.full_name, u.phone, u.avatar_url,
    u.status, u.email_verified_at, u.last_login_at, u.created_at
FROM users u
WHERE u.deleted_at IS NULL;

CREATE OR REPLACE VIEW v_camera_overview AS
SELECT
    c.id AS camera_id,
    c.organization_id,
    c.code AS camera_code,
    c.name AS camera_name,
    c.status,
    c.last_seen_at,
    s.id AS site_id,
    s.name AS site_name,
    z.id AS zone_id,
    z.name AS zone_name,
    count(e.id) FILTER (WHERE e.detected_at >= now() - interval '24 hours') AS events_last_24h,
    count(e.id) FILTER (
        WHERE e.detected_at >= now() - interval '24 hours'
          AND e.severity IN ('high', 'critical')
    ) AS severe_events_last_24h
FROM cameras c
JOIN sites s ON s.id = c.site_id
LEFT JOIN zones z ON z.id = c.zone_id
LEFT JOIN safety_events e ON e.camera_id = c.id
GROUP BY c.id, c.organization_id, c.code, c.name, c.status, c.last_seen_at,
         s.id, s.name, z.id, z.name;

CREATE OR REPLACE VIEW v_open_incidents AS
SELECT
    i.id, i.organization_id, i.incident_no, i.title, i.severity, i.status,
    i.site_id, s.name AS site_name,
    i.assigned_to, u.full_name AS assigned_to_name,
    i.opened_at, i.due_at,
    count(ie.event_id) AS linked_event_count
FROM incidents i
JOIN sites s ON s.id = i.site_id
LEFT JOIN users u ON u.id = i.assigned_to
LEFT JOIN incident_events ie ON ie.incident_id = i.id
WHERE i.status IN ('open', 'investigating')
GROUP BY i.id, i.organization_id, i.incident_no, i.title, i.severity, i.status,
         i.site_id, s.name, i.assigned_to, u.full_name, i.opened_at, i.due_at;

-- KPI tong quan theo khoang thoi gian. p_to la moc doc quyen (exclusive).
CREATE OR REPLACE FUNCTION dashboard_summary(
    p_organization_id uuid,
    p_from timestamptz DEFAULT date_trunc('day', now()),
    p_to timestamptz DEFAULT now()
)
RETURNS TABLE (
    total_events bigint,
    new_events bigint,
    critical_events bigint,
    open_incidents bigint,
    online_cameras bigint,
    offline_cameras bigint,
    average_confidence numeric,
    average_resolution_minutes numeric
)
LANGUAGE sql
STABLE
SET search_path = safety, public
AS $$
WITH event_kpi AS (
    SELECT
        count(*) AS total_events,
        count(*) FILTER (WHERE status = 'new') AS new_events,
        count(*) FILTER (WHERE severity = 'critical') AS critical_events,
        avg(confidence) AS average_confidence,
        avg(extract(epoch FROM (resolved_at - detected_at)) / 60.0)
            FILTER (WHERE resolved_at IS NOT NULL) AS average_resolution_minutes
    FROM safety_events
    WHERE organization_id = p_organization_id
      AND detected_at >= p_from AND detected_at < p_to
), incident_kpi AS (
    SELECT count(*) AS open_incidents
    FROM incidents
    WHERE organization_id = p_organization_id
      AND status IN ('open', 'investigating')
), camera_kpi AS (
    SELECT
        count(*) FILTER (WHERE status = 'online' AND is_active) AS online_cameras,
        count(*) FILTER (WHERE status <> 'online' AND is_active) AS offline_cameras
    FROM cameras
    WHERE organization_id = p_organization_id
)
SELECT e.total_events, e.new_events, e.critical_events,
       i.open_incidents, c.online_cameras, c.offline_cameras,
       round(e.average_confidence, 4), round(e.average_resolution_minutes, 2)
FROM event_kpi e CROSS JOIN incident_kpi i CROSS JOIN camera_kpi c;
$$;

-- Du lieu bieu do theo ngay va loai su kien.
CREATE OR REPLACE FUNCTION event_chart_by_day(
    p_organization_id uuid,
    p_from date,
    p_to date
)
RETURNS TABLE (
    event_date date,
    event_type_code varchar,
    event_type_name varchar,
    total bigint,
    critical bigint
)
LANGUAGE sql
STABLE
SET search_path = safety, public
AS $$
    SELECT
        e.detected_at::date,
        et.code,
        et.name,
        count(*),
        count(*) FILTER (WHERE e.severity = 'critical')
    FROM safety_events e
    JOIN event_types et ON et.id = e.event_type_id
    WHERE e.organization_id = p_organization_id
      AND e.detected_at >= p_from::timestamptz
      AND e.detected_at < (p_to + 1)::timestamptz
    GROUP BY e.detected_at::date, et.code, et.name
    ORDER BY e.detected_at::date, et.name;
$$;

-- Cap nhat bang tong hop ngay. Co the goi bang cron moi dem.
CREATE OR REPLACE FUNCTION refresh_daily_event_statistics(
    p_from date DEFAULT current_date - 7,
    p_to date DEFAULT current_date
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = safety, public
AS $$
DECLARE v_count bigint;
BEGIN
    INSERT INTO daily_event_statistics (
        stat_date, organization_id, site_id, event_type_id, severity,
        total_events, acknowledged_events, resolved_events, dismissed_events,
        average_confidence, average_resolution_seconds, updated_at
    )
    SELECT
        e.detected_at::date,
        e.organization_id,
        e.site_id,
        e.event_type_id,
        e.severity,
        count(*),
        count(*) FILTER (WHERE e.acknowledged_at IS NOT NULL),
        count(*) FILTER (WHERE e.status = 'resolved'),
        count(*) FILTER (WHERE e.status = 'dismissed'),
        avg(e.confidence),
        avg(extract(epoch FROM (e.resolved_at - e.detected_at)))
            FILTER (WHERE e.resolved_at IS NOT NULL),
        now()
    FROM safety_events e
    WHERE e.detected_at >= p_from::timestamptz
      AND e.detected_at < (p_to + 1)::timestamptz
    GROUP BY e.detected_at::date, e.organization_id, e.site_id,
             e.event_type_id, e.severity
    ON CONFLICT (stat_date, organization_id, site_id, event_type_id, severity)
    DO UPDATE SET
        total_events = EXCLUDED.total_events,
        acknowledged_events = EXCLUDED.acknowledged_events,
        resolved_events = EXCLUDED.resolved_events,
        dismissed_events = EXCLUDED.dismissed_events,
        average_confidence = EXCLUDED.average_confidence,
        average_resolution_seconds = EXCLUDED.average_resolution_seconds,
        updated_at = now();

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 13. SEED DATA
-- ---------------------------------------------------------------------------

INSERT INTO roles (code, name, description, is_system) VALUES
    ('super_admin', 'Super Admin', 'Toan quyen tren he thong', true),
    ('org_admin', 'Organization Admin', 'Quan tri mot to chuc', true),
    ('safety_manager', 'Safety Manager', 'Quan ly su kien va su co an toan', true),
    ('operator', 'Operator', 'Theo doi va xu ly canh bao', true),
    ('viewer', 'Viewer', 'Chi xem dashboard va bao cao', true)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description;

INSERT INTO permissions (code, name) VALUES
    ('dashboard.view', 'Xem dashboard'),
    ('user.view', 'Xem nguoi dung'),
    ('user.manage', 'Quan ly nguoi dung'),
    ('site.manage', 'Quan ly dia diem va khu vuc'),
    ('camera.view', 'Xem camera'),
    ('camera.manage', 'Quan ly camera'),
    ('event.view', 'Xem su kien'),
    ('event.acknowledge', 'Xac nhan su kien'),
    ('event.resolve', 'Xu ly su kien'),
    ('incident.view', 'Xem su co'),
    ('incident.manage', 'Quan ly su co'),
    ('alert.manage', 'Quan ly quy tac canh bao'),
    ('report.view', 'Xem bao cao'),
    ('audit.view', 'Xem audit log'),
    ('settings.manage', 'Quan ly cau hinh')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

-- Super admin nhan tat ca quyen.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'super_admin'
ON CONFLICT DO NOTHING;

-- Org admin nhan tat ca quyen tru audit he thong cap cao.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'org_admin' AND p.code <> 'audit.view'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN (
    'dashboard.view', 'camera.view', 'event.view', 'event.acknowledge',
    'event.resolve', 'incident.view', 'incident.manage', 'alert.manage', 'report.view'
)
WHERE r.code = 'safety_manager'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN (
    'dashboard.view', 'camera.view', 'event.view', 'event.acknowledge',
    'event.resolve', 'incident.view', 'report.view'
)
WHERE r.code = 'operator'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN (
    'dashboard.view', 'camera.view', 'event.view', 'incident.view', 'report.view'
)
WHERE r.code = 'viewer'
ON CONFLICT DO NOTHING;

INSERT INTO event_types (code, name, description, default_severity, icon, color) VALUES
    ('SUSPECTED_NO_HELMET', 'Nghi ngo khong doi mu bao ho', 'RF-DETR chua quan sat thay mu tai vung dau; can nguoi dung xac minh', 'critical', 'hard-hat', '#DC2626'),
    ('SUSPECTED_NO_VEST', 'Nghi ngo khong mac ao bao ho', 'RF-DETR chua quan sat thay ao tai vung than; can nguoi dung xac minh', 'high', 'vest', '#EA580C'),
    ('SAFE_WALKWAY_VIOLATION', 'Di vao khu vuc nguy hiem', 'VideoMAE: Safe Walkway Violation', 'medium', 'person-walking-arrow-right', '#EAB308'),
    ('UNAUTHORIZED_INTERVENTION', 'Can thiep trai phep', 'VideoMAE: Unauthorized Intervention', 'critical', 'hand', '#DC2626'),
    ('OPENED_PANEL_COVER', 'Nap tu dien dang mo', 'VideoMAE: Opened Panel Cover', 'high', 'bolt', '#EA580C'),
    ('FORKLIFT_OVERLOAD', 'Xe nang cho qua tai', 'VideoMAE: Carrying Overload with Forklift', 'high', 'truck-ramp-box', '#EA580C'),
    ('FALL_DETECTED', 'Phat hien te nga', 'Phat hien nguoi bi te nga', 'critical', 'person-falling', '#DC2626'),
    ('FIRE_SMOKE', 'Lua hoac khoi', 'Phat hien lua hoac khoi bat thuong', 'critical', 'fire', '#DC2626'),
    ('RESTRICTED_AREA', 'Xam nhap khu vuc cam', 'Nguoi xam nhap khu vuc han che', 'high', 'triangle-exclamation', '#EA580C'),
    ('CROWDING', 'Tap trung dong nguoi', 'So nguoi vuot nguong cho phep', 'medium', 'people-group', '#EAB308'),
    ('UNSAFE_BEHAVIOR', 'Hanh vi khong an toan', 'Mo hinh phat hien hanh vi nguy hiem', 'high', 'shield-exclamation', '#DC2626'),
    ('CAMERA_OFFLINE', 'Camera mat ket noi', 'Camera khong gui heartbeat', 'medium', 'video-slash', '#6B7280')
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    default_severity = EXCLUDED.default_severity,
    icon = EXCLUDED.icon,
    color = EXCLUDED.color;

COMMIT;

-- ============================================================================
-- VI DU SU DUNG (BO COMMENT VA DOI DU LIEU TRUOC KHI CHAY)
-- ============================================================================
-- 1) Tao to chuc:
-- INSERT INTO safety.organizations (code, name)
-- VALUES ('COMPANY01', 'Cong ty cua toi') RETURNING id;
--
-- 2) Dang ky user:
-- SELECT safety.register_user('admin@example.com', 'StrongPassword123!', 'Admin');
--
-- 3) Kich hoat email/user sau khi xac thuc email:
-- UPDATE safety.users SET status = 'active', email_verified_at = now()
-- WHERE email = 'admin@example.com';
--
-- 4) Gan user vao to chuc voi vai tro org_admin:
-- INSERT INTO safety.organization_members (organization_id, user_id, role_id, is_default)
-- SELECT '<ORGANIZATION_UUID>', u.id, r.id, true
-- FROM safety.users u CROSS JOIN safety.roles r
-- WHERE u.email = 'admin@example.com' AND r.code = 'org_admin';
--
-- 5) Dang nhap:
-- SELECT * FROM safety.authenticate_user(
--     'admin@example.com', 'StrongPassword123!', '127.0.0.1', 'Web browser'
-- );
--
-- 6) KPI dashboard hom nay:
-- SELECT * FROM safety.dashboard_summary('<ORGANIZATION_UUID>');
--
-- 7) Bieu do 30 ngay:
-- SELECT * FROM safety.event_chart_by_day(
--     '<ORGANIZATION_UUID>', current_date - 29, current_date
-- );
