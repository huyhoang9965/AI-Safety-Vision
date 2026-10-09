import os
from contextlib import contextmanager
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.api.alerts import event_acknowledger, event_viewer
from app.api.auth import current_user
from app.main import app
from app.database.database import connection
from app.services import alert_service


@pytest.mark.skipif(os.getenv("TEST_ALERT_SQL") != "1", reason="Opt-in read-only PostgreSQL check")
@pytest.mark.parametrize("status,age_seconds,resolved,expected", [
    ("new", 86399, False, False),
    ("new", 86400, False, False),
    ("new", 86401, False, True),
    ("acknowledged", 86399, False, False),
    ("acknowledged", 86400, False, False),
    ("acknowledged", 86401, False, False),
    ("resolved", 172800, True, False),
    ("dismissed", 172800, True, False),
    ("resolved", 172800, False, False),
    ("new", 172800, True, False),
    ("new", -3600, False, False),
])
def test_overdue_boundary_in_postgresql(status, age_seconds, resolved, expected):
    # Synthetic rows only: no production data or table mutations.
    with connection() as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        row = conn.execute(
            f"""SELECT {alert_service.overdue_condition()} AS overdue FROM (
                SELECT %s::text AS status,
                       now() - %s * interval '1 second' AS detected_at,
                       NULL::timestamptz AS acknowledged_at,
                       CASE WHEN %s THEN now() ELSE NULL END AS resolved_at
            ) e""", (status, age_seconds, resolved),
        ).fetchone()
    assert row["overdue"] is expected


def test_overdue_filter_and_summary_keep_organization_scope(monkeypatch):
    organization = uuid4()
    queries = []

    class Result:
        def __init__(self, sql): self.sql = sql
        def fetchone(self):
            return {**alert_service._empty_summary(), "overdue": 2} if "AS overdue," in self.sql else {"total": 2}
        def fetchall(self): return []

    class Conn:
        def execute(self, sql, params):
            queries.append((sql, params))
            return Result(sql)

    @contextmanager
    def fake_connection(): yield Conn()

    monkeypatch.setattr(alert_service, "connection", fake_connection)
    payload = alert_service.list_alerts(
        {"memberships": [{"organization_id": organization}]},
        None, None, None, None, None, None, "all", 5, 0, overdue=True,
    )
    assert payload["summary"]["overdue"] == 2
    assert len(queries) == 6
    for sql, params in queries:
        assert "organization_id = ANY(%s::uuid[])" in sql
        assert params[-1 if "AS acknowledgeable_new" in sql else 0] == [organization]
    assert alert_service.overdue_condition() in queries[0][0]  # Filter affects pagination total.
    assert "ORDER BY " + alert_service.overdue_condition() + " DESC" in queries[1][0]
    assert "date_trunc" not in queries[0][0]  # Old pending alerts remain visible.


def test_empty_membership_has_no_overdue_and_never_queries_database(monkeypatch):
    def unexpected(): raise AssertionError("Should not query without organization membership")
    monkeypatch.setattr(alert_service, "connection", unexpected)
    payload = alert_service.list_alerts({"memberships": []}, None, None, None, None, None, None, "all", 5, 0, overdue=True)
    assert payload["summary"]["overdue"] == 0
    assert payload["items"] == []


def test_api_accepts_overdue_filter_and_preserves_summary(monkeypatch):
    captured = {}
    def fake_list(*args, **kwargs):
        captured.update(kwargs)
        return {"items": [], "total": 2, "limit": 5, "offset": 0,
                "summary": {**alert_service._empty_summary(), "overdue": 2},
                "filters": {"event_types": [], "sites": [], "cameras": []}}
    monkeypatch.setattr(alert_service, "list_alerts", fake_list)
    app.dependency_overrides[event_viewer] = lambda: {"memberships": []}
    try:
        with patch("app.database.database.initialize_database", side_effect=RuntimeError("offline")):
            with TestClient(app) as client:
                response = client.get("/api/alerts?period=all&overdue=true&limit=5")
                invalid = client.get("/api/alerts?overdue=invalid")
        assert response.status_code == 200
        assert response.json()["summary"]["overdue"] == 2
        assert captured == {"overdue": True}
        assert invalid.status_code == 422
    finally:
        app.dependency_overrides.pop(event_viewer, None)


def test_alert_notifications_require_login():
    with patch("app.database.database.initialize_database", side_effect=RuntimeError("offline")):
        with TestClient(app) as client:
            response = client.get("/api/alerts?period=all&overdue=true&limit=5")
    assert response.status_code == 401


def test_bulk_acknowledge_without_permission_never_queries(monkeypatch):
    def unexpected(): raise AssertionError("Should not query without acknowledge permission")
    monkeypatch.setattr(alert_service, "connection", unexpected)
    assert alert_service.acknowledge_all({"memberships": []}, None) == 0
    assert alert_service.acknowledge_all({"memberships": [{
        "organization_id": uuid4(), "permissions": ["event.view"],
    }]}, None) == 0


@pytest.mark.skipif(os.getenv("TEST_ALERT_SQL") != "1", reason="Opt-in isolated PostgreSQL check")
def test_bulk_acknowledge_across_pages_scoped_and_repeat_safe(monkeypatch):
    # Exercise the actual UPDATE on a session-local table, never production events.
    allowed, read_only, foreign, actor = [uuid4() for _ in range(4)]
    with connection() as conn:
        conn.execute("""CREATE TEMP TABLE bulk_test_events (
            id int GENERATED ALWAYS AS IDENTITY, organization_id uuid, status text,
            acknowledged_at timestamptz, acknowledged_by uuid, resolution_note text,
            resolved_at timestamptz, detected_at timestamptz DEFAULT now() - interval '2 days'
        ) ON COMMIT DROP""")
        conn.execute("""INSERT INTO bulk_test_events (organization_id, status, resolution_note)
            SELECT %s, 'new', 'Ghi chú cũ' FROM generate_series(1, 55)""", (allowed,))
        conn.execute("""INSERT INTO bulk_test_events (organization_id, status, resolved_at)
            VALUES (%s, 'acknowledged', NULL), (%s, 'resolved', now()),
                   (%s, 'dismissed', now()), (%s, 'new', now()),
                   (%s, 'new', NULL), (%s, 'new', NULL)""",
            (allowed, allowed, allowed, allowed, read_only, foreign))

        class TestConn:
            def execute(self, sql, params):
                return conn.execute(sql.replace("safety.safety_events", "bulk_test_events"), params)

        @contextmanager
        def isolated_connection(): yield TestConn()

        monkeypatch.setattr(alert_service, "connection", isolated_connection)
        user = {"id": actor, "memberships": [
            {"organization_id": allowed, "permissions": ["event.acknowledge"]},
            {"organization_id": read_only, "permissions": ["event.view"]},
        ]}
        def overdue_count():
            return conn.execute(
                f"SELECT count(*) AS total FROM bulk_test_events e WHERE organization_id = %s AND {alert_service.overdue_condition()}",
                (allowed,),
            ).fetchone()["total"]
        assert overdue_count() == 55
        assert alert_service.acknowledge_all(user, "  Đã tiếp nhận  ") == 55
        assert overdue_count() == 0
        assert alert_service.acknowledge_all(user, "Không được ghi đè") == 0
        rows = conn.execute("SELECT * FROM bulk_test_events ORDER BY id").fetchall()
        for row in rows[:55]:
            assert row["status"] == "acknowledged"
            assert row["acknowledged_at"] is not None
            assert row["acknowledged_by"] == actor
            assert row["resolution_note"] == "Đã tiếp nhận"
            assert row["resolved_at"] is None
        assert [row["status"] for row in rows[55:]] == [
            "acknowledged", "resolved", "dismissed", "new", "new", "new",
        ]
        assert all(row["acknowledged_by"] is None for row in rows[55:])


@pytest.mark.skipif(os.getenv("TEST_ALERT_SQL") != "1", reason="Opt-in read-only PostgreSQL check")
def test_bulk_summary_sql_accepts_permission_scoped_organizations(monkeypatch):
    with connection() as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        @contextmanager
        def readonly_connection(): yield conn
        monkeypatch.setattr(alert_service, "connection", readonly_connection)
        payload = alert_service.list_alerts({"memberships": [{
            "organization_id": uuid4(), "permissions": ["event.acknowledge"],
        }]}, None, None, None, None, None, None, "all", 50, 0)
        assert payload["summary"]["acknowledgeable_new"] == 0
        assert payload["summary"]["critical_new"] == 0
        assert payload["summary"]["high_new"] == 0


@pytest.mark.skipif(os.getenv("TEST_ALERT_SQL") != "1", reason="Opt-in read-only PostgreSQL check")
def test_event_with_acknowledgement_timestamp_is_not_overdue():
    with connection() as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        row = conn.execute(f"""SELECT {alert_service.overdue_condition()} AS overdue FROM (
            SELECT 'new'::text AS status, now() - interval '2 days' AS detected_at,
                   now() AS acknowledged_at, NULL::timestamptz AS resolved_at
        ) e""").fetchone()
        assert row["overdue"] is False


def test_bulk_api_requires_login_and_acknowledge_permission(monkeypatch):
    def unexpected(*args): raise AssertionError("Unauthorized bulk mutation")
    monkeypatch.setattr(alert_service, "acknowledge_all", unexpected)
    with patch("app.database.database.initialize_database", side_effect=RuntimeError("offline")):
        with TestClient(app) as client:
            assert client.post("/api/alerts/acknowledge-all", json={}).status_code == 401
            app.dependency_overrides[current_user] = lambda: {"memberships": [{
                "organization_id": uuid4(), "permissions": ["event.view"],
            }]}
            try:
                assert client.post("/api/alerts/acknowledge-all", json={}).status_code == 403
            finally:
                app.dependency_overrides.pop(current_user, None)


@pytest.mark.parametrize("count", [0, 55])
def test_bulk_api_returns_actual_count_and_validates_notes(monkeypatch, count):
    captured = []
    user = {"id": uuid4(), "memberships": []}
    def fake_bulk(actor, note):
        captured.append((actor, note))
        return count
    monkeypatch.setattr(alert_service, "acknowledge_all", fake_bulk)
    app.dependency_overrides[event_acknowledger] = lambda: user
    try:
        with patch("app.database.database.initialize_database", side_effect=RuntimeError("offline")):
            with TestClient(app) as client:
                response = client.post("/api/alerts/acknowledge-all", json={"note": "Đã kiểm tra"})
                assert response.status_code == 200
                assert response.json()["acknowledged_count"] == count
                assert response.json()["success"] is True
                assert client.post("/api/alerts/acknowledge-all", json={"note": "x" * 2001}).status_code == 422
        assert captured == [(user, "Đã kiểm tra")]
    finally:
        app.dependency_overrides.pop(event_acknowledger, None)
