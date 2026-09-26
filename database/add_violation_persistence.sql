-- Chay toan bo file nay trong Query Tool cua database safety_db tren pgAdmin 4.
-- Script co the chay lai an toan, khong tao trung du lieu.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS safety;

ALTER TABLE public.inference_history
    ADD COLUMN IF NOT EXISTS camera_id uuid REFERENCES safety.cameras(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES safety.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS started_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE public.detection_results
    ADD COLUMN IF NOT EXISTS is_violation boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS track_id varchar(100),
    ADD COLUMN IF NOT EXISTS evidence_url text,
    ADD COLUMN IF NOT EXISTS evidence_basis varchar(150),
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS detection_results_violation_idx
    ON public.detection_results (inference_id, is_violation, frame_index);

CREATE UNIQUE INDEX IF NOT EXISTS alerts_event_uq
    ON safety.alerts (event_id);

INSERT INTO safety.organizations (code, name, timezone, is_active)
VALUES ('FACTORY_AI', 'Factory AI Safety', 'Asia/Ho_Chi_Minh', true)
ON CONFLICT (code) DO NOTHING;

WITH target_org AS (
    SELECT id FROM safety.organizations WHERE code = 'FACTORY_AI'
)
INSERT INTO safety.sites (organization_id, code, name, address, timezone, is_active)
SELECT id, 'MAIN_FACTORY', 'Nha may chinh', 'Khu vuc san xuat chinh',
       'Asia/Ho_Chi_Minh', true
FROM target_org
ON CONFLICT (organization_id, code) DO NOTHING;

WITH target_org AS (
    SELECT id FROM safety.organizations WHERE code = 'FACTORY_AI'
), target_site AS (
    SELECT s.id, s.organization_id
    FROM safety.sites s
    JOIN target_org o ON o.id = s.organization_id
    WHERE s.code = 'MAIN_FACTORY'
), zone_seed(code, name, description, is_restricted) AS (
    VALUES
      ('PRODUCTION_WALKWAY', 'Loi di san xuat', 'Loi di va khu san xuat', false),
      ('FORKLIFT_YARD', 'Bai trung chuyen', 'Khu vuc xe nang', true),
      ('TECHNICAL', 'Khu ky thuat', 'Tu dien va thiet bi ky thuat', true),
      ('RESTRICTED', 'Khu vuc han che', 'Khu vuc chi danh cho nguoi duoc cap quyen', true),
      ('MAIN_INTERSECTION', 'Giao cat noi bo', 'Giao cat loi di chinh', false),
      ('WAREHOUSE', 'Cua nhap hang', 'Kho nguyen lieu va cua nhap hang', false),
      ('PRODUCTION_B', 'Khu san xuat B', 'Day chuyen dong goi', false),
      ('FACTORY_GATE', 'Khu vuc kiem soat', 'Cong nha may', true),
      ('MAINTENANCE', 'Xuong co khi', 'Khu bao tri va sua chua', true)
)
INSERT INTO safety.zones (
    organization_id, site_id, code, name, description, is_restricted, is_active
)
SELECT s.organization_id, s.id, z.code, z.name, z.description, z.is_restricted, true
FROM target_site s
CROSS JOIN zone_seed z
ON CONFLICT (site_id, code) DO NOTHING;

WITH target_org AS (
    SELECT id FROM safety.organizations WHERE code = 'FACTORY_AI'
), target_site AS (
    SELECT s.id, s.organization_id
    FROM safety.sites s
    JOIN target_org o ON o.id = s.organization_id
    WHERE s.code = 'MAIN_FACTORY'
), camera_seed(code, name, zone_code) AS (
    VALUES
      ('CAM-01', 'Toan canh xuong', 'PRODUCTION_WALKWAY'),
      ('CAM-02', 'Khu vuc xe nang', 'FORKLIFT_YARD'),
      ('CAM-03', 'Tu dien may ep', 'TECHNICAL'),
      ('CAM-04', 'May gia cong', 'RESTRICTED'),
      ('CAM-05', 'Loi di chinh', 'MAIN_INTERSECTION'),
      ('CAM-06', 'Kho nguyen lieu', 'WAREHOUSE'),
      ('CAM-07', 'Day chuyen dong goi', 'PRODUCTION_B'),
      ('CAM-08', 'Cong nha may', 'FACTORY_GATE'),
      ('CAM-09', 'Khu bao tri', 'MAINTENANCE')
)
INSERT INTO safety.cameras (
    organization_id, site_id, zone_id, code, name, status, is_active
)
SELECT s.organization_id, s.id, z.id, c.code, c.name,
       'online'::safety.device_status, true
FROM target_site s
JOIN camera_seed c ON true
JOIN safety.zones z
  ON z.site_id = s.id AND z.code = c.zone_code
ON CONFLICT (organization_id, code) DO NOTHING;

COMMIT;
