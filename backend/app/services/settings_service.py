from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from app.database.database import connection
from app.settings_schemas import SystemSettingsPayload


class SettingsNotFoundError(ValueError):
    pass


DEFAULT_SETTINGS: dict[str, Any] = {
    "general": {
        "language": "vi",
        "date_format": "DD/MM/YYYY",
        "time_format": "24h",
        "shift_start": "07:00",
    },
    "ai": {
        "inference_enabled": True,
        "detection_confidence": 0.5,
        "minimum_event_interval_seconds": 60,
        "save_evidence": True,
        "store_output_video": True,
        "auto_create_critical_incident": False,
    },
    "alerts": {
        "in_app_enabled": True,
        "email_enabled": False,
        "webhook_enabled": False,
        "critical_immediate": True,
        "digest_interval_minutes": 15,
        "escalation_minutes": 15,
        "quiet_hours_enabled": False,
        "quiet_hours_start": "22:00",
        "quiet_hours_end": "06:00",
    },
    "retention": {
        "event_retention_days": 365,
        "evidence_retention_days": 90,
        "audit_retention_days": 730,
        "auto_cleanup_enabled": True,
    },
    "security": {
        "session_timeout_minutes": 120,
        "require_mfa_for_admins": False,
        "lockout_attempts": 5,
        "lockout_minutes": 15,
        "allow_password_login": True,
    },
}


def _primary_organization(user: dict[str, Any]) -> UUID:
    memberships = user.get("memberships", [])
    if not memberships:
        raise SettingsNotFoundError("Tài khoản chưa thuộc tổ chức nào")
    membership = next((item for item in memberships if item.get("is_default")), memberships[0])
    return membership["organization_id"]


def _merge_settings(organization: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(DEFAULT_SETTINGS)
    stored = organization.get("settings") or {}
    for section in DEFAULT_SETTINGS:
        value = stored.get(section)
        if isinstance(value, dict):
            merged[section].update(value)
    merged["general"]["organization_name"] = organization["name"]
    merged["general"]["timezone"] = organization["timezone"]
    return merged


def _health(conn: Any, organization_id: UUID) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT
          (SELECT count(*)::int FROM safety.cameras
           WHERE organization_id=%s AND is_active) AS cameras_total,
          (SELECT count(*)::int FROM safety.cameras
           WHERE organization_id=%s AND is_active AND status='online') AS cameras_online,
          (SELECT count(*)::int FROM public.models) AS models_registered,
          (SELECT count(*)::int FROM safety.safety_events
           WHERE organization_id=%s) AS events_total,
          (SELECT count(*)::int FROM safety.safety_events
           WHERE organization_id=%s AND status IN ('new','acknowledged')) AS open_alerts,
          (SELECT count(*)::int FROM safety.organization_members om
           JOIN safety.users u ON u.id=om.user_id
           WHERE om.organization_id=%s AND u.status='active'
             AND u.deleted_at IS NULL) AS active_users
        """,
        (organization_id, organization_id, organization_id, organization_id, organization_id),
    ).fetchone()
    return {
        "database": "healthy",
        "backend": "healthy",
        **dict(row),
        "checked_at": datetime.now(timezone.utc),
    }


def _recent_changes(conn: Any, organization_id: UUID) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT a.id, a.action, u.full_name AS actor_name, a.created_at,
               COALESCE(a.new_data->'changed_sections', '[]'::jsonb) AS changed_sections
        FROM safety.audit_logs a
        LEFT JOIN safety.users u ON u.id=a.actor_user_id
        WHERE a.organization_id=%s AND a.entity_type='system_settings'
        ORDER BY a.created_at DESC
        LIMIT 8
        """,
        (organization_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def _response(conn: Any, organization_id: UUID) -> dict[str, Any]:
    organization = conn.execute(
        """
        SELECT id, code, name, timezone, settings, updated_at
        FROM safety.organizations
        WHERE id=%s AND is_active
        """,
        (organization_id,),
    ).fetchone()
    if not organization:
        raise SettingsNotFoundError("Không tìm thấy tổ chức đang hoạt động")
    return {
        "organization_id": organization["id"],
        "organization_code": organization["code"],
        "settings": _merge_settings(dict(organization)),
        "health": _health(conn, organization_id),
        "recent_changes": _recent_changes(conn, organization_id),
        "updated_at": organization["updated_at"],
    }


def get_settings(user: dict[str, Any]) -> dict[str, Any]:
    organization_id = _primary_organization(user)
    with connection() as conn:
        return _response(conn, organization_id)


def update_settings(body: SystemSettingsPayload, user: dict[str, Any]) -> dict[str, Any]:
    organization_id = _primary_organization(user)
    payload = body.model_dump(mode="json")
    organization_name = payload["general"].pop("organization_name").strip()
    timezone_name = payload["general"].pop("timezone")
    with connection() as conn:
        current = conn.execute(
            "SELECT name, timezone, settings FROM safety.organizations WHERE id=%s FOR UPDATE",
            (organization_id,),
        ).fetchone()
        if not current:
            raise SettingsNotFoundError("Không tìm thấy tổ chức")
        previous = _merge_settings(dict(current))
        comparable_previous = deepcopy(previous)
        comparable_previous["general"].pop("organization_name", None)
        comparable_previous["general"].pop("timezone", None)
        changed_sections = [
            key for key in payload
            if comparable_previous.get(key) != payload[key]
        ]
        if (
            previous["general"]["organization_name"] != organization_name
            or previous["general"]["timezone"] != timezone_name
        ) and "general" not in changed_sections:
            changed_sections.append("general")
        conn.execute(
            """
            UPDATE safety.organizations
            SET name=%s, timezone=%s, settings=%s::jsonb, updated_at=now()
            WHERE id=%s
            """,
            (organization_name, timezone_name, json.dumps(payload), organization_id),
        )
        conn.execute(
            """
            INSERT INTO safety.audit_logs
              (organization_id, actor_user_id, action, entity_type, entity_id,
               old_data, new_data)
            VALUES (%s,%s,'settings.update','system_settings',%s,%s::jsonb,%s::jsonb)
            """,
            (
                organization_id,
                user["id"],
                str(organization_id),
                json.dumps(previous),
                json.dumps({"changed_sections": sorted(changed_sections), "settings": payload}),
            ),
        )
        return _response(conn, organization_id)


def reset_settings(user: dict[str, Any]) -> dict[str, Any]:
    organization_id = _primary_organization(user)
    with connection() as conn:
        current = conn.execute(
            "SELECT name, timezone, settings FROM safety.organizations WHERE id=%s FOR UPDATE",
            (organization_id,),
        ).fetchone()
        if not current:
            raise SettingsNotFoundError("Không tìm thấy tổ chức")
        conn.execute(
            "UPDATE safety.organizations SET settings='{}'::jsonb, updated_at=now() WHERE id=%s",
            (organization_id,),
        )
        conn.execute(
            """
            INSERT INTO safety.audit_logs
              (organization_id, actor_user_id, action, entity_type, entity_id,
               old_data, new_data)
            VALUES (%s,%s,'settings.reset','system_settings',%s,%s::jsonb,%s::jsonb)
            """,
            (
                organization_id,
                user["id"],
                str(organization_id),
                json.dumps(_merge_settings(dict(current))),
                json.dumps({"changed_sections": list(DEFAULT_SETTINGS), "reset": True}),
            ),
        )
        return _response(conn, organization_id)
