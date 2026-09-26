from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from app.database.database import connection
from app.services.alert_service import organization_ids


class IncidentNotFoundError(ValueError):
    pass


class IncidentConflictError(ValueError):
    pass


def _base_select() -> str:
    return """
        SELECT
            i.id,
            i.incident_no,
            i.title,
            i.description,
            i.severity::text AS severity,
            i.status::text AS status,
            s.code AS site_code,
            s.name AS site_name,
            CASE WHEN assigned.id IS NULL THEN NULL ELSE
                jsonb_build_object('id', assigned.id, 'full_name', assigned.full_name, 'email', assigned.email)
            END AS assigned_to,
            CASE WHEN opener.id IS NULL THEN NULL ELSE
                jsonb_build_object('id', opener.id, 'full_name', opener.full_name, 'email', opener.email)
            END AS opened_by,
            i.opened_at,
            i.due_at,
            i.resolved_at,
            i.closed_at,
            i.updated_at,
            (SELECT count(*)::int FROM safety.incident_events ie WHERE ie.incident_id = i.id) AS event_count,
            (SELECT count(*)::int FROM safety.incident_comments ic
             WHERE ic.incident_id = i.id AND ic.deleted_at IS NULL) AS comment_count,
            (i.due_at IS NOT NULL AND i.due_at < now() AND i.status IN ('open', 'investigating')) AS overdue
        FROM safety.incidents i
        JOIN safety.sites s ON s.id = i.site_id
        LEFT JOIN safety.users assigned ON assigned.id = i.assigned_to
        LEFT JOIN safety.users opener ON opener.id = i.opened_by
    """


def _empty_summary() -> dict[str, Any]:
    return {
        "total": 0,
        "open": 0,
        "investigating": 0,
        "resolved": 0,
        "closed": 0,
        "overdue": 0,
        "critical_open": 0,
        "unassigned": 0,
        "average_resolution_seconds": None,
    }


def list_incidents(
    user: dict[str, Any],
    status: str | None,
    severity: str | None,
    site: str | None,
    assignee: str | None,
    search: str | None,
    period: str,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    organizations = organization_ids(user)
    if not organizations:
        return {
            "items": [], "total": 0, "limit": limit, "offset": offset,
            "summary": _empty_summary(), "filters": {"sites": [], "members": []},
        }

    conditions = ["i.organization_id = ANY(%s::uuid[])"]
    params: list[Any] = [organizations]
    if status:
        conditions.append("i.status = %s::safety.incident_status")
        params.append(status)
    if severity:
        conditions.append("i.severity = %s::safety.severity_level")
        params.append(severity)
    if site:
        conditions.append("s.code = %s")
        params.append(site)
    if assignee == "unassigned":
        conditions.append("i.assigned_to IS NULL")
    elif assignee:
        conditions.append("i.assigned_to = %s")
        params.append(UUID(assignee))
    if search:
        conditions.append(
            "(i.title ILIKE %s OR i.description ILIKE %s OR CAST(i.incident_no AS text) ILIKE %s)"
        )
        pattern = "%" + search.strip() + "%"
        params.extend([pattern, pattern, pattern])
    period_sql = {
        "today": "i.opened_at >= date_trunc('day', now())",
        "7d": "i.opened_at >= now() - interval '7 days'",
        "30d": "i.opened_at >= now() - interval '30 days'",
        "90d": "i.opened_at >= now() - interval '90 days'",
    }.get(period)
    if period_sql:
        conditions.append(period_sql)
    where = " WHERE " + " AND ".join(conditions)

    with connection() as conn:
        total = conn.execute(
            "SELECT count(*)::int AS total FROM safety.incidents i "
            "JOIN safety.sites s ON s.id = i.site_id" + where,
            params,
        ).fetchone()["total"]
        items = conn.execute(
            _base_select() + where + """
                ORDER BY
                    CASE i.status WHEN 'open' THEN 0 WHEN 'investigating' THEN 1
                        WHEN 'resolved' THEN 2 ELSE 3 END,
                    CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                        WHEN 'medium' THEN 2 ELSE 3 END,
                    COALESCE(i.due_at, 'infinity'::timestamptz),
                    i.opened_at DESC
                LIMIT %s OFFSET %s
            """,
            [*params, limit, offset],
        ).fetchall()
        summary = conn.execute(
            """
            SELECT
                count(*)::int AS total,
                count(*) FILTER (WHERE status = 'open')::int AS open,
                count(*) FILTER (WHERE status = 'investigating')::int AS investigating,
                count(*) FILTER (WHERE status = 'resolved')::int AS resolved,
                count(*) FILTER (WHERE status = 'closed')::int AS closed,
                count(*) FILTER (
                    WHERE due_at < now() AND status IN ('open', 'investigating')
                )::int AS overdue,
                count(*) FILTER (
                    WHERE severity = 'critical' AND status IN ('open', 'investigating')
                )::int AS critical_open,
                count(*) FILTER (
                    WHERE assigned_to IS NULL AND status IN ('open', 'investigating')
                )::int AS unassigned,
                avg(extract(epoch FROM (resolved_at - opened_at)))
                    FILTER (WHERE resolved_at IS NOT NULL)::float8 AS average_resolution_seconds
            FROM safety.incidents
            WHERE organization_id = ANY(%s::uuid[])
            """,
            (organizations,),
        ).fetchone()
        sites = conn.execute(
            """
            SELECT code, name FROM safety.sites
            WHERE organization_id = ANY(%s::uuid[]) AND is_active
            ORDER BY name
            """,
            (organizations,),
        ).fetchall()
        members = conn.execute(
            """
            SELECT DISTINCT u.id, u.full_name, u.email
            FROM safety.organization_members om
            JOIN safety.users u ON u.id = om.user_id
            WHERE om.organization_id = ANY(%s::uuid[])
              AND u.status = 'active' AND u.deleted_at IS NULL
            ORDER BY u.full_name
            """,
            (organizations,),
        ).fetchall()

    summary_payload = dict(summary) if summary else _empty_summary()
    if summary_payload.get("average_resolution_seconds") is not None:
        summary_payload["average_resolution_seconds"] = float(
            summary_payload["average_resolution_seconds"]
        )
    return {
        "items": [dict(row) for row in items],
        "total": int(total),
        "limit": limit,
        "offset": offset,
        "summary": summary_payload,
        "filters": {
            "sites": [dict(row) for row in sites],
            "members": [dict(row) for row in members],
        },
    }


def _find_incident(
    incident_id: UUID,
    organizations: list[UUID],
    conn: Any,
) -> dict[str, Any] | None:
    return conn.execute(
        _base_select() + """
            WHERE i.id = %s
              AND i.organization_id = ANY(%s::uuid[])
        """,
        (incident_id, organizations),
    ).fetchone()


def detail(incident_id: UUID, user: dict[str, Any], conn: Any | None = None) -> dict[str, Any]:
    organizations = organization_ids(user)

    def load(active_conn: Any) -> dict[str, Any]:
        incident = _find_incident(incident_id, organizations, active_conn)
        if incident is None:
            raise IncidentNotFoundError("Không tìm thấy sự cố")
        extra = active_conn.execute(
            """
            SELECT resolution, root_cause, corrective_action
            FROM safety.incidents WHERE id = %s
            """,
            (incident_id,),
        ).fetchone()
        comments = active_conn.execute(
            """
            SELECT ic.id, ic.body, ic.created_at, ic.updated_at,
                   CASE WHEN u.id IS NULL THEN NULL ELSE
                       jsonb_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email)
                   END AS user
            FROM safety.incident_comments ic
            LEFT JOIN safety.users u ON u.id = ic.user_id
            WHERE ic.incident_id = %s AND ic.deleted_at IS NULL
            ORDER BY ic.created_at
            """,
            (incident_id,),
        ).fetchall()
        history = active_conn.execute(
            """
            SELECT h.id, h.old_status::text AS old_status,
                   h.new_status::text AS new_status, h.note, h.changed_at,
                   CASE WHEN u.id IS NULL THEN NULL ELSE
                       jsonb_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email)
                   END AS changed_by
            FROM safety.incident_status_history h
            LEFT JOIN safety.users u ON u.id = h.changed_by
            WHERE h.incident_id = %s
            ORDER BY h.changed_at
            """,
            (incident_id,),
        ).fetchall()
        events = active_conn.execute(
            """
            SELECT e.id, e.title, e.severity::text AS severity,
                   e.status::text AS status, e.detected_at,
                   et.name AS event_name, c.code AS camera_code,
                   c.name AS camera_name, e.snapshot_url
            FROM safety.incident_events ie
            JOIN safety.safety_events e ON e.id = ie.event_id
            JOIN safety.event_types et ON et.id = e.event_type_id
            JOIN safety.cameras c ON c.id = e.camera_id
            WHERE ie.incident_id = %s
            ORDER BY e.detected_at DESC
            """,
            (incident_id,),
        ).fetchall()
        payload = dict(incident)
        payload.update(dict(extra))
        payload["comments"] = [dict(row) for row in comments]
        payload["history"] = [dict(row) for row in history]
        payload["linked_events"] = [dict(row) for row in events]
        return payload

    if conn is not None:
        return load(conn)
    with connection() as active_conn:
        return load(active_conn)


def create(payload: Any, user: dict[str, Any]) -> dict[str, Any]:
    organizations = organization_ids(user)
    with connection() as conn:
        site = conn.execute(
            """
            SELECT id, organization_id FROM safety.sites
            WHERE code = %s AND organization_id = ANY(%s::uuid[]) AND is_active
            """,
            (payload.site_code, organizations),
        ).fetchone()
        if site is None:
            raise IncidentConflictError("Địa điểm không hợp lệ hoặc chưa được kích hoạt")
        if payload.assigned_to is not None:
            _ensure_member(conn, payload.assigned_to, site["organization_id"])
        row = conn.execute(
            """
            INSERT INTO safety.incidents (
                organization_id, site_id, title, description, severity,
                assigned_to, opened_by, due_at
            ) VALUES (%s, %s, %s, %s, %s::safety.severity_level, %s, %s, %s)
            RETURNING id
            """,
            (
                site["organization_id"], site["id"], payload.title.strip(),
                _clean(payload.description), payload.severity,
                payload.assigned_to, user["id"], payload.due_at,
            ),
        ).fetchone()
        _annotate_latest_history(conn, row["id"], user["id"], "Tạo sự cố")
        return detail(row["id"], user, conn)


def update(incident_id: UUID, payload: Any, user: dict[str, Any]) -> dict[str, Any]:
    organizations = organization_ids(user)
    with connection() as conn:
        current = _find_incident(incident_id, organizations, conn)
        if current is None:
            raise IncidentNotFoundError("Không tìm thấy sự cố")
        if payload.assigned_to is not None:
            organization = conn.execute(
                "SELECT organization_id FROM safety.incidents WHERE id = %s",
                (incident_id,),
            ).fetchone()["organization_id"]
            _ensure_member(conn, payload.assigned_to, organization)
        conn.execute(
            """
            UPDATE safety.incidents
            SET title = %s, description = %s,
                severity = %s::safety.severity_level,
                assigned_to = %s, due_at = %s,
                root_cause = %s, corrective_action = %s, resolution = %s
            WHERE id = %s AND organization_id = ANY(%s::uuid[])
            """,
            (
                payload.title.strip(), _clean(payload.description), payload.severity,
                payload.assigned_to, payload.due_at, _clean(payload.root_cause),
                _clean(payload.corrective_action), _clean(payload.resolution),
                incident_id, organizations,
            ),
        )
        return detail(incident_id, user, conn)


def change_status(
    incident_id: UUID,
    next_status: str,
    note: str | None,
    user: dict[str, Any],
) -> dict[str, Any]:
    organizations = organization_ids(user)
    transitions = {
        "open": {"investigating", "resolved"},
        "investigating": {"open", "resolved"},
        "resolved": {"investigating", "closed"},
        "closed": set(),
    }
    with connection() as conn:
        current = _find_incident(incident_id, organizations, conn)
        if current is None:
            raise IncidentNotFoundError("Không tìm thấy sự cố")
        if next_status == current["status"]:
            return detail(incident_id, user, conn)
        if next_status not in transitions[current["status"]]:
            raise IncidentConflictError(
                "Không thể chuyển từ " + current["status"] + " sang " + next_status
            )
        if next_status in {"resolved", "closed"} and not (note or "").strip():
            raise IncidentConflictError("Vui lòng nhập ghi chú trước khi hoàn tất")
        timestamps = {
            "open": "resolved_at = NULL, closed_at = NULL",
            "investigating": "resolved_at = NULL, closed_at = NULL",
            "resolved": "resolved_at = now(), closed_at = NULL",
            "closed": "resolved_at = COALESCE(resolved_at, now()), closed_at = now()",
        }[next_status]
        conn.execute(
            """
            UPDATE safety.incidents
            SET status = %s::safety.incident_status, """ + timestamps + """
            WHERE id = %s AND organization_id = ANY(%s::uuid[])
            """,
            (next_status, incident_id, organizations),
        )
        _annotate_latest_history(conn, incident_id, user["id"], _clean(note))
        return detail(incident_id, user, conn)


def add_comment(
    incident_id: UUID,
    body: str,
    user: dict[str, Any],
) -> dict[str, Any]:
    organizations = organization_ids(user)
    with connection() as conn:
        if _find_incident(incident_id, organizations, conn) is None:
            raise IncidentNotFoundError("Không tìm thấy sự cố")
        conn.execute(
            """
            INSERT INTO safety.incident_comments (incident_id, user_id, body)
            VALUES (%s, %s, %s)
            """,
            (incident_id, user["id"], body.strip()),
        )
        return detail(incident_id, user, conn)


def _ensure_member(conn: Any, user_id: UUID, organization_id: UUID) -> None:
    exists = conn.execute(
        """
        SELECT 1 FROM safety.organization_members
        WHERE organization_id = %s AND user_id = %s
        """,
        (organization_id, user_id),
    ).fetchone()
    if exists is None:
        raise IncidentConflictError("Người được phân công không thuộc tổ chức")


def _annotate_latest_history(
    conn: Any,
    incident_id: UUID,
    user_id: UUID,
    note: str | None,
) -> None:
    conn.execute(
        """
        UPDATE safety.incident_status_history
        SET changed_by = %s, note = %s
        WHERE id = (
            SELECT id FROM safety.incident_status_history
            WHERE incident_id = %s
            ORDER BY id DESC LIMIT 1
        )
        """,
        (user_id, note, incident_id),
    )


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None
