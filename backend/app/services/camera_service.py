from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from app.camera_schemas import CameraCreateRequest, SiteCreateRequest, ZoneCreateRequest
from app.database.database import connection
from app.services.alert_service import organization_ids


class InfrastructureNotFoundError(ValueError):
    pass


class InfrastructureConflictError(ValueError):
    pass


def _primary_organization(user: dict[str, Any]) -> UUID:
    memberships = user.get("memberships", [])
    if not memberships:
        raise InfrastructureConflictError("Tài khoản chưa thuộc tổ chức nào")
    membership = next((item for item in memberships if item.get("is_default")), memberships[0])
    return membership["organization_id"]


def _camera_select() -> str:
    return """
        SELECT c.id, c.site_id, c.zone_id,
               s.code AS site_code, s.name AS site_name,
               z.code AS zone_code, z.name AS zone_name,
               c.code, c.name, c.snapshot_url, c.status::text AS status,
               c.manufacturer, c.model, c.ip_address::text AS ip_address,
               c.latitude::float8 AS latitude, c.longitude::float8 AS longitude,
               c.fps::float8 AS fps, c.resolution_width, c.resolution_height,
               c.installed_at, c.last_seen_at,
               (c.stream_url_encrypted IS NOT NULL AND c.stream_url_encrypted <> '') AS stream_configured,
               c.is_active, c.updated_at,
               (SELECT count(*)::int FROM safety.model_deployments md
                WHERE md.camera_id = c.id AND md.is_enabled) AS deployment_count,
               latest.status::text AS health_status,
               latest.latency_ms AS latest_latency_ms,
               latest.packet_loss_pct::float8 AS latest_packet_loss_pct
        FROM safety.cameras c
        JOIN safety.sites s ON s.id = c.site_id
        LEFT JOIN safety.zones z ON z.id = c.zone_id
        LEFT JOIN LATERAL (
            SELECT h.status, h.latency_ms, h.packet_loss_pct
            FROM safety.camera_health_samples h
            WHERE h.camera_id = c.id
            ORDER BY h.sampled_at DESC LIMIT 1
        ) latest ON true
    """


def list_infrastructure(user: dict[str, Any]) -> dict[str, Any]:
    organizations = organization_ids(user)
    if not organizations:
        return {"sites": [], "zones": [], "cameras": [], "summary": _empty_summary()}
    with connection() as conn:
        sites = conn.execute(
            """
            SELECT s.id, s.code, s.name, s.address,
                   s.latitude::float8 AS latitude, s.longitude::float8 AS longitude,
                   s.timezone, s.is_active,
                   count(DISTINCT z.id)::int AS zone_count,
                   count(DISTINCT c.id)::int AS camera_count
            FROM safety.sites s
            LEFT JOIN safety.zones z ON z.site_id = s.id
            LEFT JOIN safety.cameras c ON c.site_id = s.id
            WHERE s.organization_id = ANY(%s::uuid[])
            GROUP BY s.id ORDER BY s.is_active DESC, s.name
            """, (organizations,),
        ).fetchall()
        zones = conn.execute(
            """
            SELECT z.id, z.site_id, s.code AS site_code, z.code, z.name,
                   z.description, z.is_restricted, z.is_active,
                   count(c.id)::int AS camera_count
            FROM safety.zones z
            JOIN safety.sites s ON s.id = z.site_id
            LEFT JOIN safety.cameras c ON c.zone_id = z.id
            WHERE z.organization_id = ANY(%s::uuid[])
            GROUP BY z.id, s.code, s.name ORDER BY s.name, z.name
            """, (organizations,),
        ).fetchall()
        cameras = conn.execute(
            _camera_select() + """
            WHERE c.organization_id = ANY(%s::uuid[])
            ORDER BY s.name, z.name NULLS LAST, c.name
            """, (organizations,),
        ).fetchall()
        summary = conn.execute(
            """
            SELECT
              (SELECT count(*)::int FROM safety.sites WHERE organization_id = ANY(%s::uuid[])) AS sites,
              (SELECT count(*)::int FROM safety.zones WHERE organization_id = ANY(%s::uuid[])) AS zones,
              count(*)::int AS cameras,
              count(*) FILTER (WHERE status = 'online')::int AS online,
              count(*) FILTER (WHERE status = 'offline')::int AS offline,
              count(*) FILTER (WHERE status = 'warning')::int AS warning,
              count(*) FILTER (WHERE status = 'maintenance')::int AS maintenance,
              count(*) FILTER (WHERE status = 'disabled')::int AS disabled,
              (SELECT count(*)::int FROM safety.zones
               WHERE organization_id = ANY(%s::uuid[]) AND is_restricted) AS restricted_zones
            FROM safety.cameras WHERE organization_id = ANY(%s::uuid[])
            """, (organizations, organizations, organizations, organizations),
        ).fetchone()
    return {
        "sites": [dict(row) for row in sites],
        "zones": [dict(row) for row in zones],
        "cameras": [dict(row) for row in cameras],
        "summary": dict(summary) if summary else _empty_summary(),
    }


def _empty_summary() -> dict[str, int]:
    return {key: 0 for key in (
        "sites", "zones", "cameras", "online", "offline", "warning",
        "maintenance", "disabled", "restricted_zones",
    )}


def _find_camera(camera_id: UUID, organizations: list[UUID], conn: Any) -> dict[str, Any] | None:
    return conn.execute(
        _camera_select() + " WHERE c.id = %s AND c.organization_id = ANY(%s::uuid[])",
        (camera_id, organizations),
    ).fetchone()


def camera_detail(camera_id: UUID, user: dict[str, Any]) -> dict[str, Any]:
    organizations = organization_ids(user)
    with connection() as conn:
        camera = _find_camera(camera_id, organizations, conn)
        if camera is None:
            raise InfrastructureNotFoundError("Không tìm thấy camera")
        health = conn.execute(
            """
            SELECT id, status::text AS status, latency_ms, fps::float8 AS fps,
                   packet_loss_pct::float8 AS packet_loss_pct,
                   cpu_usage_pct::float8 AS cpu_usage_pct,
                   gpu_usage_pct::float8 AS gpu_usage_pct,
                   temperature_c::float8 AS temperature_c, sampled_at
            FROM safety.camera_health_samples WHERE camera_id = %s
            ORDER BY sampled_at DESC LIMIT 24
            """, (camera_id,),
        ).fetchall()
        deployments = conn.execute(
            """
            SELECT md.id, m.code AS model_code, m.name AS model_name, m.version,
                   md.confidence_threshold::float8 AS confidence_threshold,
                   md.is_enabled, md.deployed_at
            FROM safety.model_deployments md
            JOIN safety.ai_models m ON m.id = md.model_id
            WHERE md.camera_id = %s ORDER BY md.is_enabled DESC, md.deployed_at DESC
            """, (camera_id,),
        ).fetchall()
        events = conn.execute(
            """
            SELECT count(*) FILTER (WHERE detected_at >= now() - interval '24 hours')::int AS events_24h,
                   count(*) FILTER (WHERE detected_at >= now() - interval '7 days')::int AS events_7d
            FROM safety.safety_events WHERE camera_id = %s
            """, (camera_id,),
        ).fetchone()
    return {
        **dict(camera),
        "health_samples": [dict(row) for row in health],
        "deployments": [dict(row) for row in deployments],
        "events_24h": int(events["events_24h"]) if events else 0,
        "events_7d": int(events["events_7d"]) if events else 0,
    }


def _audit(conn: Any, organization_id: UUID, user: dict[str, Any], action: str,
           entity_type: str, entity_id: UUID, new_data: dict[str, Any]) -> None:
    conn.execute(
        """INSERT INTO safety.audit_logs
           (organization_id, actor_user_id, action, entity_type, entity_id, new_data)
           VALUES (%s, %s, %s, %s, %s, %s::jsonb)""",
        (organization_id, user["id"], action, entity_type, str(entity_id), json.dumps(new_data)),
    )


def _validate_resolution(body: CameraCreateRequest) -> None:
    if (body.resolution_width is None) != (body.resolution_height is None):
        raise InfrastructureConflictError("Chiều rộng và chiều cao độ phân giải phải được nhập cùng nhau")


def _site_in_org(conn: Any, site_id: UUID, organization_id: UUID) -> bool:
    return conn.execute(
        "SELECT 1 FROM safety.sites WHERE id = %s AND organization_id = %s",
        (site_id, organization_id),
    ).fetchone() is not None


def _validate_zone(conn: Any, zone_id: UUID | None, site_id: UUID, organization_id: UUID) -> None:
    if zone_id is None:
        return
    exists = conn.execute(
        "SELECT 1 FROM safety.zones WHERE id = %s AND site_id = %s AND organization_id = %s",
        (zone_id, site_id, organization_id),
    ).fetchone()
    if not exists:
        raise InfrastructureConflictError("Khu vực không thuộc nhà máy đã chọn")


def create_site(body: SiteCreateRequest, user: dict[str, Any]) -> UUID:
    organization_id = _primary_organization(user)
    values = body.model_dump()
    values["code"] = body.code.upper()
    with connection() as conn:
        if conn.execute(
            "SELECT 1 FROM safety.sites WHERE organization_id = %s AND upper(code) = upper(%s)",
            (organization_id, body.code),
        ).fetchone():
            raise InfrastructureConflictError("Mã nhà máy đã tồn tại")
        row = conn.execute(
            """INSERT INTO safety.sites
               (organization_id, code, name, address, latitude, longitude, timezone, is_active)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
            (organization_id, values["code"], body.name.strip(), body.address,
             body.latitude, body.longitude, body.timezone, body.is_active),
        ).fetchone()
        _audit(conn, organization_id, user, "site.create", "site", row["id"], values)
        return row["id"]


def update_site(site_id: UUID, body: SiteCreateRequest, user: dict[str, Any]) -> None:
    organizations = organization_ids(user)
    values = body.model_dump()
    values["code"] = body.code.upper()
    with connection() as conn:
        current = conn.execute(
            "SELECT organization_id FROM safety.sites WHERE id = %s AND organization_id = ANY(%s::uuid[])",
            (site_id, organizations),
        ).fetchone()
        if not current:
            raise InfrastructureNotFoundError("Không tìm thấy nhà máy")
        duplicate = conn.execute(
            "SELECT 1 FROM safety.sites WHERE organization_id = %s AND upper(code) = upper(%s) AND id <> %s",
            (current["organization_id"], body.code, site_id),
        ).fetchone()
        if duplicate:
            raise InfrastructureConflictError("Mã nhà máy đã tồn tại")
        conn.execute(
            """UPDATE safety.sites SET code=%s, name=%s, address=%s, latitude=%s,
               longitude=%s, timezone=%s, is_active=%s, updated_at=now() WHERE id=%s""",
            (values["code"], body.name.strip(), body.address, body.latitude,
             body.longitude, body.timezone, body.is_active, site_id),
        )
        _audit(conn, current["organization_id"], user, "site.update", "site", site_id, values)


def create_zone(body: ZoneCreateRequest, user: dict[str, Any]) -> UUID:
    organization_id = _primary_organization(user)
    values = body.model_dump(mode="json")
    values["code"] = body.code.upper()
    with connection() as conn:
        if not _site_in_org(conn, body.site_id, organization_id):
            raise InfrastructureNotFoundError("Không tìm thấy nhà máy")
        if conn.execute(
            "SELECT 1 FROM safety.zones WHERE site_id = %s AND upper(code) = upper(%s)",
            (body.site_id, body.code),
        ).fetchone():
            raise InfrastructureConflictError("Mã khu vực đã tồn tại trong nhà máy")
        row = conn.execute(
            """INSERT INTO safety.zones
               (organization_id, site_id, code, name, description, is_restricted, is_active)
               VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id""",
            (organization_id, body.site_id, values["code"], body.name.strip(),
             body.description, body.is_restricted, body.is_active),
        ).fetchone()
        _audit(conn, organization_id, user, "zone.create", "zone", row["id"], values)
        return row["id"]


def update_zone(zone_id: UUID, body: ZoneCreateRequest, user: dict[str, Any]) -> None:
    organizations = organization_ids(user)
    values = body.model_dump(mode="json")
    values["code"] = body.code.upper()
    with connection() as conn:
        current = conn.execute(
            "SELECT organization_id FROM safety.zones WHERE id=%s AND organization_id = ANY(%s::uuid[])",
            (zone_id, organizations),
        ).fetchone()
        if not current:
            raise InfrastructureNotFoundError("Không tìm thấy khu vực")
        if not _site_in_org(conn, body.site_id, current["organization_id"]):
            raise InfrastructureConflictError("Nhà máy không hợp lệ")
        duplicate = conn.execute(
            "SELECT 1 FROM safety.zones WHERE site_id=%s AND upper(code)=upper(%s) AND id<>%s",
            (body.site_id, body.code, zone_id),
        ).fetchone()
        if duplicate:
            raise InfrastructureConflictError("Mã khu vực đã tồn tại trong nhà máy")
        conn.execute(
            """UPDATE safety.zones SET site_id=%s, code=%s, name=%s, description=%s,
               is_restricted=%s, is_active=%s, updated_at=now() WHERE id=%s""",
            (body.site_id, values["code"], body.name.strip(), body.description,
             body.is_restricted, body.is_active, zone_id),
        )
        _audit(conn, current["organization_id"], user, "zone.update", "zone", zone_id, values)


def create_camera(body: CameraCreateRequest, user: dict[str, Any]) -> UUID:
    _validate_resolution(body)
    organization_id = _primary_organization(user)
    values = body.model_dump(mode="json")
    values["code"] = body.code.upper()
    with connection() as conn:
        if not _site_in_org(conn, body.site_id, organization_id):
            raise InfrastructureNotFoundError("Không tìm thấy nhà máy")
        _validate_zone(conn, body.zone_id, body.site_id, organization_id)
        if conn.execute(
            "SELECT 1 FROM safety.cameras WHERE organization_id=%s AND upper(code)=upper(%s)",
            (organization_id, body.code),
        ).fetchone():
            raise InfrastructureConflictError("Mã camera đã tồn tại")
        row = conn.execute(
            """INSERT INTO safety.cameras
               (organization_id, site_id, zone_id, code, name, snapshot_url, status,
                manufacturer, model, ip_address, latitude, longitude, fps,
                resolution_width, resolution_height, installed_at, is_active)
               VALUES (%s,%s,%s,%s,%s,%s,%s::safety.device_status,%s,%s,%s::inet,%s,%s,%s,%s,%s,%s,%s)
               RETURNING id""",
            (organization_id, body.site_id, body.zone_id, values["code"], body.name.strip(),
             body.snapshot_url, body.status, body.manufacturer, body.model,
             body.ip_address or None, body.latitude, body.longitude, body.fps,
             body.resolution_width, body.resolution_height, body.installed_at, body.is_active),
        ).fetchone()
        _audit(conn, organization_id, user, "camera.create", "camera", row["id"], values)
        return row["id"]


def update_camera(camera_id: UUID, body: CameraCreateRequest, user: dict[str, Any]) -> None:
    _validate_resolution(body)
    organizations = organization_ids(user)
    values = body.model_dump(mode="json")
    values["code"] = body.code.upper()
    with connection() as conn:
        current = conn.execute(
            "SELECT organization_id FROM safety.cameras WHERE id=%s AND organization_id = ANY(%s::uuid[])",
            (camera_id, organizations),
        ).fetchone()
        if not current:
            raise InfrastructureNotFoundError("Không tìm thấy camera")
        organization_id = current["organization_id"]
        if not _site_in_org(conn, body.site_id, organization_id):
            raise InfrastructureConflictError("Nhà máy không hợp lệ")
        _validate_zone(conn, body.zone_id, body.site_id, organization_id)
        if conn.execute(
            "SELECT 1 FROM safety.cameras WHERE organization_id=%s AND upper(code)=upper(%s) AND id<>%s",
            (organization_id, body.code, camera_id),
        ).fetchone():
            raise InfrastructureConflictError("Mã camera đã tồn tại")
        conn.execute(
            """UPDATE safety.cameras SET site_id=%s, zone_id=%s, code=%s, name=%s,
               snapshot_url=%s, status=%s::safety.device_status, manufacturer=%s, model=%s,
               ip_address=%s::inet, latitude=%s, longitude=%s, fps=%s,
               resolution_width=%s, resolution_height=%s, installed_at=%s,
               is_active=%s, updated_at=now() WHERE id=%s""",
            (body.site_id, body.zone_id, values["code"], body.name.strip(),
             body.snapshot_url, body.status, body.manufacturer, body.model,
             body.ip_address or None, body.latitude, body.longitude, body.fps,
             body.resolution_width, body.resolution_height, body.installed_at,
             body.is_active, camera_id),
        )
        _audit(conn, organization_id, user, "camera.update", "camera", camera_id, values)


def update_camera_status(camera_id: UUID, status: str, user: dict[str, Any]) -> None:
    organizations = organization_ids(user)
    with connection() as conn:
        current = conn.execute(
            "SELECT organization_id FROM safety.cameras WHERE id=%s AND organization_id = ANY(%s::uuid[])",
            (camera_id, organizations),
        ).fetchone()
        if not current:
            raise InfrastructureNotFoundError("Không tìm thấy camera")
        conn.execute(
            "UPDATE safety.cameras SET status=%s::safety.device_status, updated_at=now() WHERE id=%s",
            (status, camera_id),
        )
        _audit(conn, current["organization_id"], user, "camera.status", "camera", camera_id, {"status": status})
