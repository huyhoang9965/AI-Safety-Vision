from __future__ import annotations

from typing import Any
from uuid import UUID

from app.database.database import connection


class AlertNotFoundError(ValueError):
    pass


class AlertConflictError(ValueError):
    pass


def organization_ids(user: dict[str, Any]) -> list[UUID]:
    return [membership["organization_id"] for membership in user.get("memberships", [])]


def _alert_select() -> str:
    return """
        SELECT
            e.id,
            et.code AS event_code,
            et.name AS event_name,
            e.title,
            e.description,
            e.severity::text AS severity,
            e.status::text AS status,
            e.confidence::float8 AS confidence,
            e.object_count,
            e.detected_at,
            e.acknowledged_at,
            e.resolved_at,
            e.resolution_note,
            s.code AS site_code,
            s.name AS site_name,
            z.code AS zone_code,
            z.name AS zone_name,
            c.code AS camera_code,
            c.name AS camera_name,
            e.snapshot_url,
            e.video_url,
            e.thumbnail_url,
            CASE WHEN acknowledged_user.id IS NULL THEN NULL ELSE
                jsonb_build_object('id', acknowledged_user.id, 'full_name', acknowledged_user.full_name)
            END AS acknowledged_by,
            CASE WHEN resolved_user.id IS NULL THEN NULL ELSE
                jsonb_build_object('id', resolved_user.id, 'full_name', resolved_user.full_name)
            END AS resolved_by,
            ie.incident_id
        FROM safety.safety_events e
        JOIN safety.event_types et ON et.id = e.event_type_id
        JOIN safety.sites s ON s.id = e.site_id
        LEFT JOIN safety.zones z ON z.id = e.zone_id
        JOIN safety.cameras c ON c.id = e.camera_id
        LEFT JOIN safety.users acknowledged_user ON acknowledged_user.id = e.acknowledged_by
        LEFT JOIN safety.users resolved_user ON resolved_user.id = e.resolved_by
        LEFT JOIN safety.incident_events ie ON ie.event_id = e.id
    """


def _serialize(row: dict[str, Any]) -> dict[str, Any]:
    payload = dict(row)
    if payload.get("confidence") is not None:
        payload["confidence"] = float(payload["confidence"])
    return payload


def get_alert(
    event_id: UUID,
    organizations: list[UUID],
    conn: Any | None = None,
) -> dict[str, Any] | None:
    if not organizations:
        return None

    def execute(active_conn: Any):
        return active_conn.execute(
            _alert_select() + """
                WHERE e.id = %s
                  AND e.organization_id = ANY(%s::uuid[])
            """,
            (event_id, organizations),
        ).fetchone()

    if conn is not None:
        row = execute(conn)
    else:
        with connection() as active_conn:
            row = execute(active_conn)
    return _serialize(row) if row else None


def list_alerts(
    user: dict[str, Any],
    status: str | None,
    severity: str | None,
    event_type: str | None,
    site: str | None,
    camera: str | None,
    search: str | None,
    period: str,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    organizations = organization_ids(user)
    if not organizations:
        return {
            "items": [],
            "total": 0,
            "limit": limit,
            "offset": offset,
            "summary": _empty_summary(),
            "filters": {"event_types": [], "sites": [], "cameras": []},
        }

    conditions = ["e.organization_id = ANY(%s::uuid[])"]
    params: list[Any] = [organizations]
    if status:
        conditions.append("e.status = %s::safety.event_status")
        params.append(status)
    if severity:
        conditions.append("e.severity = %s::safety.severity_level")
        params.append(severity)
    if event_type:
        conditions.append("et.code = %s")
        params.append(event_type)
    if site:
        conditions.append("s.code = %s")
        params.append(site)
    if camera:
        conditions.append("c.code = %s")
        params.append(camera)
    if search:
        conditions.append(
            "(e.title ILIKE %s OR e.description ILIKE %s OR c.code ILIKE %s OR c.name ILIKE %s)"
        )
        pattern = "%" + search.strip() + "%"
        params.extend([pattern, pattern, pattern, pattern])
    period_sql = {
        "today": "e.detected_at >= date_trunc('day', now())",
        "24h": "e.detected_at >= now() - interval '24 hours'",
        "7d": "e.detected_at >= now() - interval '7 days'",
        "30d": "e.detected_at >= now() - interval '30 days'",
    }.get(period)
    if period_sql:
        conditions.append(period_sql)

    where = " WHERE " + " AND ".join(conditions)
    with connection() as conn:
        total_row = conn.execute(
            """
            SELECT count(*) AS total
            FROM safety.safety_events e
            JOIN safety.event_types et ON et.id = e.event_type_id
            JOIN safety.sites s ON s.id = e.site_id
            JOIN safety.cameras c ON c.id = e.camera_id
            """ + where,
            params,
        ).fetchone()
        rows = conn.execute(
            _alert_select() + where + """
                ORDER BY e.detected_at DESC,
                    CASE e.status WHEN 'new' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
                    CASE e.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                        WHEN 'medium' THEN 2 ELSE 3 END
                LIMIT %s OFFSET %s
            """,
            [*params, limit, offset],
        ).fetchall()
        summary = conn.execute(
            """
            SELECT
                count(*)::int AS total,
                count(*) FILTER (WHERE status = 'new')::int AS new,
                count(*) FILTER (WHERE status = 'acknowledged')::int AS acknowledged,
                count(*) FILTER (WHERE status = 'resolved')::int AS resolved,
                count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed,
                count(*) FILTER (
                    WHERE severity = 'critical' AND status IN ('new', 'acknowledged')
                )::int AS critical_open,
                count(*) FILTER (
                    WHERE severity = 'high' AND status IN ('new', 'acknowledged')
                )::int AS high_open,
                count(*) FILTER (
                    WHERE detected_at >= date_trunc('day', now())
                )::int AS today,
                avg(extract(epoch FROM (acknowledged_at - detected_at)))
                    FILTER (WHERE acknowledged_at IS NOT NULL)::float8
                    AS average_acknowledge_seconds
            FROM safety.safety_events
            WHERE organization_id = ANY(%s::uuid[])
            """,
            (organizations,),
        ).fetchone()
        event_types = conn.execute(
            """
            SELECT DISTINCT et.code, et.name
            FROM safety.event_types et
            JOIN safety.safety_events e ON e.event_type_id = et.id
            WHERE e.organization_id = ANY(%s::uuid[])
            ORDER BY et.name
            """,
            (organizations,),
        ).fetchall()
        sites = conn.execute(
            """
            SELECT DISTINCT s.code, s.name
            FROM safety.sites s
            JOIN safety.safety_events e ON e.site_id = s.id
            WHERE e.organization_id = ANY(%s::uuid[])
            ORDER BY s.name
            """,
            (organizations,),
        ).fetchall()
        cameras = conn.execute(
            """
            SELECT DISTINCT c.code, c.name
            FROM safety.cameras c
            JOIN safety.safety_events e ON e.camera_id = c.id
            WHERE e.organization_id = ANY(%s::uuid[])
            ORDER BY c.name
            """,
            (organizations,),
        ).fetchall()

    summary_payload = dict(summary) if summary else _empty_summary()
    if summary_payload.get("average_acknowledge_seconds") is not None:
        summary_payload["average_acknowledge_seconds"] = float(
            summary_payload["average_acknowledge_seconds"]
        )
    return {
        "items": [_serialize(row) for row in rows],
        "total": int(total_row["total"]),
        "limit": limit,
        "offset": offset,
        "summary": summary_payload,
        "filters": {
            "event_types": [dict(row) for row in event_types],
            "sites": [dict(row) for row in sites],
            "cameras": [dict(row) for row in cameras],
        },
    }


def acknowledge(
    event_id: UUID,
    user: dict[str, Any],
    note: str | None,
) -> dict[str, Any]:
    organizations = organization_ids(user)
    with connection() as conn:
        if get_alert(event_id, organizations, conn) is None:
            raise AlertNotFoundError("Không tìm thấy cảnh báo")
        changed = conn.execute(
            "SELECT safety.acknowledge_event(%s, %s, %s) AS changed",
            (event_id, user["id"], note),
        ).fetchone()["changed"]
        if not changed:
            raise AlertConflictError("Chỉ cảnh báo mới có thể được xác nhận")
        return get_alert(event_id, organizations, conn)


def resolve(
    event_id: UUID,
    user: dict[str, Any],
    note: str,
) -> dict[str, Any]:
    organizations = organization_ids(user)
    with connection() as conn:
        if get_alert(event_id, organizations, conn) is None:
            raise AlertNotFoundError("Không tìm thấy cảnh báo")
        changed = conn.execute(
            "SELECT safety.resolve_event(%s, %s, %s) AS changed",
            (event_id, user["id"], note),
        ).fetchone()["changed"]
        if not changed:
            raise AlertConflictError("Cảnh báo đã được đóng hoặc loại bỏ")
        return get_alert(event_id, organizations, conn)


def dismiss(
    event_id: UUID,
    user: dict[str, Any],
    note: str,
) -> dict[str, Any]:
    organizations = organization_ids(user)
    with connection() as conn:
        if get_alert(event_id, organizations, conn) is None:
            raise AlertNotFoundError("Không tìm thấy cảnh báo")
        row = conn.execute(
            """
            UPDATE safety.safety_events
            SET status = 'dismissed',
                acknowledged_at = COALESCE(acknowledged_at, now()),
                acknowledged_by = COALESCE(acknowledged_by, %s),
                resolved_at = now(),
                resolved_by = %s,
                resolution_note = %s
            WHERE id = %s
              AND organization_id = ANY(%s::uuid[])
              AND status IN ('new', 'acknowledged')
            RETURNING id
            """,
            (user["id"], user["id"], note, event_id, organizations),
        ).fetchone()
        if row is None:
            raise AlertConflictError("Cảnh báo đã được đóng hoặc loại bỏ")
        return get_alert(event_id, organizations, conn)


def create_incident(
    event_id: UUID,
    user: dict[str, Any],
    title: str | None,
) -> UUID:
    organizations = organization_ids(user)
    with connection() as conn:
        if get_alert(event_id, organizations, conn) is None:
            raise AlertNotFoundError("Không tìm thấy cảnh báo")
        return conn.execute(
            "SELECT safety.create_incident_from_event(%s, %s, %s) AS incident_id",
            (event_id, user["id"], title),
        ).fetchone()["incident_id"]


def _empty_summary() -> dict[str, Any]:
    return {
        "total": 0,
        "new": 0,
        "acknowledged": 0,
        "resolved": 0,
        "dismissed": 0,
        "critical_open": 0,
        "high_open": 0,
        "today": 0,
        "average_acknowledge_seconds": None,
    }
