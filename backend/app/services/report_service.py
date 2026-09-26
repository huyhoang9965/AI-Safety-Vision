from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta, timezone
from typing import Any

from app.database.database import connection


class ReportConflictError(ValueError):
    pass


SEVERITY_LABELS = {
    "critical": "Nghiêm trọng",
    "high": "Cao",
    "medium": "Trung bình",
    "low": "Thấp",
}
STATUS_LABELS = {
    "new": "Mới",
    "acknowledged": "Đã xác nhận",
    "resolved": "Đã xử lý",
    "dismissed": "Bỏ qua",
}


def organization_ids(user: dict[str, Any]) -> list[Any]:
    organizations = [item["organization_id"] for item in user.get("memberships", [])]
    if not organizations:
        raise ReportConflictError("Tài khoản chưa thuộc tổ chức nào")
    return organizations


def _window(days: int) -> tuple[datetime, datetime, datetime]:
    end_at = datetime.now(timezone.utc)
    today_start = end_at.replace(hour=0, minute=0, second=0, microsecond=0)
    start_at = today_start - timedelta(days=days - 1)
    return start_at, end_at, start_at - timedelta(days=days)


def _change(current: int, previous: int) -> float | None:
    if previous == 0:
        return None if current == 0 else 100.0
    return round((current - previous) / previous * 100, 1)


def _float(value: Any) -> float | None:
    return float(value) if value is not None else None


def _event_where(site_code: str | None, alias: str = "e") -> str:
    clause = (
        f"{alias}.organization_id=ANY(%s::uuid[]) "
        f"AND {alias}.detected_at >= %s AND {alias}.detected_at < %s"
    )
    if site_code:
        clause += f" AND EXISTS (SELECT 1 FROM safety.sites fs WHERE fs.id={alias}.site_id AND fs.code=%s)"
    return clause


def _event_params(
    organizations: list[Any],
    start_at: datetime,
    end_at: datetime,
    site_code: str | None,
) -> list[Any]:
    params: list[Any] = [organizations, start_at, end_at]
    if site_code:
        params.append(site_code)
    return params


def _event_summary(conn: Any, organizations: list[Any], start_at: datetime, end_at: datetime, site_code: str | None) -> dict[str, Any]:
    where = _event_where(site_code)
    row = conn.execute(
        f"""
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE severity='critical')::int AS critical,
               count(*) FILTER (WHERE status IN ('new','acknowledged'))::int AS open_events,
               count(*) FILTER (WHERE status='resolved')::int AS resolved,
               avg(confidence)::float8 AS average_confidence,
               avg(EXTRACT(EPOCH FROM (acknowledged_at-detected_at)))
                 FILTER (WHERE acknowledged_at IS NOT NULL)::float8 AS average_acknowledge_seconds,
               avg(EXTRACT(EPOCH FROM (resolved_at-detected_at)))
                 FILTER (WHERE resolved_at IS NOT NULL)::float8 AS average_resolution_seconds,
               count(DISTINCT camera_id)::int AS reporting_cameras
        FROM safety.safety_events e WHERE {where}
        """,
        _event_params(organizations, start_at, end_at, site_code),
    ).fetchone()
    return dict(row)


def overview(user: dict[str, Any], days: int, site_code: str | None) -> dict[str, Any]:
    organizations = organization_ids(user)
    start_at, end_at, previous_start_at = _window(days)
    where = _event_where(site_code)
    params = _event_params(organizations, start_at, end_at, site_code)
    previous_params = _event_params(organizations, previous_start_at, start_at, site_code)

    with connection() as conn:
        current = _event_summary(conn, organizations, start_at, end_at, site_code)
        previous = _event_summary(conn, organizations, previous_start_at, start_at, site_code)

        incident_conditions = [
            "i.organization_id=ANY(%s::uuid[])",
            "i.opened_at >= %s",
            "i.opened_at < %s",
        ]
        incident_params: list[Any] = [organizations, start_at, end_at]
        if site_code:
            incident_conditions.append(
                "EXISTS (SELECT 1 FROM safety.sites fs WHERE fs.id=i.site_id AND fs.code=%s)"
            )
            incident_params.append(site_code)
        incident_where = " AND ".join(incident_conditions)
        incident_summary = conn.execute(
            f"""
            SELECT count(*)::int AS incidents,
                   count(*) FILTER (
                     WHERE due_at<now() AND status IN ('open','investigating')
                   )::int AS overdue_incidents
            FROM safety.incidents i WHERE {incident_where}
            """,
            incident_params,
        ).fetchone()

        trend_rows = conn.execute(
            f"""
            WITH event_days AS (
              SELECT date(e.detected_at) AS day,count(*)::int AS total,
                     count(*) FILTER (WHERE e.severity='critical')::int AS critical,
                     count(*) FILTER (WHERE e.status='resolved')::int AS resolved
              FROM safety.safety_events e WHERE {where}
              GROUP BY date(e.detected_at)
            ), incident_days AS (
              SELECT date(i.opened_at) AS day,count(*)::int AS incidents
              FROM safety.incidents i WHERE {incident_where}
              GROUP BY date(i.opened_at)
            )
            SELECT series.day::date AS day,COALESCE(e.total,0)::int AS total,
                   COALESCE(e.critical,0)::int AS critical,
                   COALESCE(e.resolved,0)::int AS resolved,
                   COALESCE(i.incidents,0)::int AS incidents
            FROM generate_series(%s::date,%s::date,interval '1 day') series(day)
            LEFT JOIN event_days e ON e.day=series.day
            LEFT JOIN incident_days i ON i.day=series.day
            ORDER BY series.day
            """,
            [*params, *incident_params, start_at, end_at],
        ).fetchall()

        event_type_rows = conn.execute(
            f"""
            WITH current_period AS (
              SELECT e.event_type_id,count(*)::int AS total,
                     avg(e.confidence)::float8 AS average_confidence
              FROM safety.safety_events e WHERE {where} GROUP BY e.event_type_id
            ), previous_period AS (
              SELECT e.event_type_id,count(*)::int AS total
              FROM safety.safety_events e
              WHERE {_event_where(site_code)}
              GROUP BY e.event_type_id
            )
            SELECT et.code,et.name,et.color,COALESCE(c.total,0)::int AS total,
                   COALESCE(p.total,0)::int AS previous_total,c.average_confidence
            FROM current_period c JOIN safety.event_types et ON et.id=c.event_type_id
            LEFT JOIN previous_period p ON p.event_type_id=c.event_type_id
            ORDER BY c.total DESC,et.name LIMIT 10
            """,
            [*params, *previous_params],
        ).fetchall()

        severity_rows = conn.execute(
            f"""
            WITH levels(key,label,rank) AS (VALUES
              ('critical','Nghiêm trọng',1),('high','Cao',2),
              ('medium','Trung bình',3),('low','Thấp',4)
            ), counts AS (
              SELECT severity::text AS key,count(*)::int AS total
              FROM safety.safety_events e WHERE {where} GROUP BY severity
            )
            SELECT l.key,l.label,COALESCE(c.total,0)::int AS total
            FROM levels l LEFT JOIN counts c ON c.key=l.key ORDER BY l.rank
            """,
            params,
        ).fetchall()

        status_rows = conn.execute(
            f"""
            WITH levels(key,label,rank) AS (VALUES
              ('new','Mới',1),('acknowledged','Đã xác nhận',2),
              ('resolved','Đã xử lý',3),('dismissed','Bỏ qua',4)
            ), counts AS (
              SELECT status::text AS key,count(*)::int AS total
              FROM safety.safety_events e WHERE {where} GROUP BY status
            )
            SELECT l.key,l.label,COALESCE(c.total,0)::int AS total
            FROM levels l LEFT JOIN counts c ON c.key=l.key ORDER BY l.rank
            """,
            params,
        ).fetchall()

        site_rows = conn.execute(
            f"""
            SELECT s.code,s.name,count(e.id)::int AS total,
                   count(e.id) FILTER (WHERE e.severity='critical')::int AS critical,
                   count(e.id) FILTER (WHERE e.status IN ('new','acknowledged'))::int AS open_events,
                   count(e.id) FILTER (WHERE e.status='resolved')::int AS resolved,
                   count(DISTINCT e.camera_id)::int AS cameras
            FROM safety.safety_events e JOIN safety.sites s ON s.id=e.site_id
            WHERE {where}
            GROUP BY s.id,s.code,s.name ORDER BY total DESC,s.name LIMIT 8
            """,
            params,
        ).fetchall()

        camera_rows = conn.execute(
            f"""
            SELECT c.code,c.name,s.name AS site_name,z.name AS zone_name,
                   c.status::text AS status,count(e.id)::int AS total,
                   count(e.id) FILTER (WHERE e.severity='critical')::int AS critical,
                   avg(e.confidence)::float8 AS average_confidence
            FROM safety.safety_events e JOIN safety.cameras c ON c.id=e.camera_id
            JOIN safety.sites s ON s.id=e.site_id
            LEFT JOIN safety.zones z ON z.id=e.zone_id
            WHERE {where}
            GROUP BY c.id,c.code,c.name,s.name,z.name,c.status
            ORDER BY critical DESC,total DESC LIMIT 8
            """,
            params,
        ).fetchall()

        heatmap_rows = conn.execute(
            f"""
            SELECT EXTRACT(ISODOW FROM e.detected_at)::int AS weekday,
                   EXTRACT(HOUR FROM e.detected_at)::int AS hour,
                   count(*)::int AS total
            FROM safety.safety_events e WHERE {where}
            GROUP BY 1,2 ORDER BY 1,2
            """,
            params,
        ).fetchall()

        recent_rows = conn.execute(
            f"""
            SELECT e.id,e.title,et.code AS event_code,et.name AS event_name,
                   e.severity::text AS severity,e.status::text AS status,
                   e.confidence::float8 AS confidence,e.detected_at,
                   s.name AS site_name,z.name AS zone_name,c.code AS camera_code,
                   c.name AS camera_name,e.snapshot_url
            FROM safety.safety_events e
            JOIN safety.event_types et ON et.id=e.event_type_id
            JOIN safety.sites s ON s.id=e.site_id
            JOIN safety.cameras c ON c.id=e.camera_id
            LEFT JOIN safety.zones z ON z.id=e.zone_id
            WHERE {where} ORDER BY e.detected_at DESC LIMIT 12
            """,
            params,
        ).fetchall()

        filter_rows = conn.execute(
            """
            SELECT code,name FROM safety.sites
            WHERE organization_id=ANY(%s::uuid[]) AND is_active ORDER BY name
            """,
            (organizations,),
        ).fetchall()

    total = int(current["total"])
    severities = [
        {**dict(row), "percentage": round(int(row["total"]) / total * 100, 1) if total else 0.0}
        for row in severity_rows
    ]
    statuses = [
        {**dict(row), "percentage": round(int(row["total"]) / total * 100, 1) if total else 0.0}
        for row in status_rows
    ]
    sites = []
    for row in site_rows:
        item = dict(row)
        item["resolution_rate"] = round(item["resolved"] / item["total"] * 100, 1) if item["total"] else 0.0
        sites.append(item)
    event_types = []
    for row in event_type_rows:
        item = dict(row)
        item["average_confidence"] = _float(item["average_confidence"])
        item["change_percent"] = _change(item["total"], item["previous_total"])
        event_types.append(item)
    cameras = []
    for row in camera_rows:
        item = dict(row)
        item["average_confidence"] = _float(item["average_confidence"])
        cameras.append(item)

    return {
        "period": {
            "days": days,
            "start_at": start_at,
            "end_at": end_at,
            "previous_start_at": previous_start_at,
        },
        "summary": {
            "total_events": total,
            "previous_events": int(previous["total"]),
            "event_change_percent": _change(total, int(previous["total"])),
            "critical_events": int(current["critical"]),
            "critical_change_percent": _change(int(current["critical"]), int(previous["critical"])),
            "open_events": int(current["open_events"]),
            "resolved_events": int(current["resolved"]),
            "resolution_rate": round(int(current["resolved"]) / total * 100, 1) if total else 0.0,
            "average_acknowledge_seconds": _float(current["average_acknowledge_seconds"]),
            "average_resolution_seconds": _float(current["average_resolution_seconds"]),
            "average_confidence": _float(current["average_confidence"]),
            "incidents": int(incident_summary["incidents"]),
            "overdue_incidents": int(incident_summary["overdue_incidents"]),
            "reporting_cameras": int(current["reporting_cameras"]),
        },
        "trend": [dict(row) for row in trend_rows],
        "event_types": event_types,
        "severities": severities,
        "statuses": statuses,
        "sites": sites,
        "cameras": cameras,
        "heatmap": [dict(row) for row in heatmap_rows],
        "recent_events": [dict(row) for row in recent_rows],
        "filters": {"sites": [dict(row) for row in filter_rows]},
        "generated_at": datetime.now(timezone.utc),
    }


def export_csv(user: dict[str, Any], days: int, site_code: str | None) -> str:
    organizations = organization_ids(user)
    start_at, end_at, _ = _window(days)
    where = _event_where(site_code)
    with connection() as conn:
        rows = conn.execute(
            f"""
            SELECT e.detected_at,et.code AS event_code,et.name AS event_name,
                   e.title,e.severity::text AS severity,e.status::text AS status,
                   e.confidence::float8 AS confidence,e.object_count,
                   s.code AS site_code,s.name AS site_name,z.name AS zone_name,
                   c.code AS camera_code,c.name AS camera_name,
                   e.acknowledged_at,e.resolved_at,e.resolution_note
            FROM safety.safety_events e
            JOIN safety.event_types et ON et.id=e.event_type_id
            JOIN safety.sites s ON s.id=e.site_id
            JOIN safety.cameras c ON c.id=e.camera_id
            LEFT JOIN safety.zones z ON z.id=e.zone_id
            WHERE {where} ORDER BY e.detected_at DESC LIMIT 10000
            """,
            _event_params(organizations, start_at, end_at, site_code),
        ).fetchall()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Thời gian", "Mã lỗi", "Loại vi phạm", "Tiêu đề", "Mức độ",
        "Trạng thái", "Độ tin cậy", "Số đối tượng", "Mã cơ sở", "Cơ sở",
        "Khu vực", "Mã camera", "Camera", "Xác nhận lúc", "Xử lý lúc", "Ghi chú",
    ])
    for row in rows:
        writer.writerow([
            row["detected_at"].isoformat(), row["event_code"], row["event_name"],
            row["title"], SEVERITY_LABELS.get(row["severity"], row["severity"]),
            STATUS_LABELS.get(row["status"], row["status"]), row["confidence"],
            row["object_count"], row["site_code"], row["site_name"],
            row["zone_name"], row["camera_code"], row["camera_name"],
            row["acknowledged_at"].isoformat() if row["acknowledged_at"] else "",
            row["resolved_at"].isoformat() if row["resolved_at"] else "",
            row["resolution_note"] or "",
        ])
    return "\ufeff" + output.getvalue()
