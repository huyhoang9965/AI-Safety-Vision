from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
import os
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.api.reports import report_viewer
from app.main import app
from app.services import report_service
from app.database.database import connection


def report_payload():
    now = datetime.now(timezone.utc)
    return {
        "period": {
            "days": 30,
            "start_at": now - timedelta(days=30),
            "end_at": now,
            "previous_start_at": now - timedelta(days=60),
        },
        "summary": {
            "total_events": 12,
            "previous_events": 10,
            "event_change_percent": 20.0,
            "critical_events": 2,
            "critical_change_percent": 0.0,
            "open_events": 3,
            "resolved_events": 8,
            "resolution_rate": 66.7,
            "average_acknowledge_seconds": 120.0,
            "average_resolution_seconds": 900.0,
            "average_confidence": 0.87,
            "incidents": 3,
            "overdue_incidents": 1,
            "reporting_cameras": 4,
        },
        "trend": [
            {
                "day": date.today(),
                "total": 12,
                "critical": 2,
                "resolved": 8,
                "incidents": 3,
            }
        ],
        "response_metrics": {
            "pending_events": 0, "acknowledged_events": 3, "overdue_events": 0,
            "acknowledge_samples": 8, "resolution_samples": 8, "acknowledged_within_24h": 7,
            "acknowledge_p50_seconds": 60, "acknowledge_p95_seconds": 180, "acknowledge_p99_seconds": 240,
            "resolution_p50_seconds": 600, "resolution_p95_seconds": 1200, "resolution_p99_seconds": 1500,
        },
        "event_types": [],
        "severities": [
            {"key": "critical", "label": "Nghiêm trọng", "total": 2, "percentage": 16.7}
        ],
        "statuses": [
            {"key": "resolved", "label": "Đã xử lý", "total": 8, "percentage": 66.7}
        ],
        "sites": [],
        "cameras": [],
        "heatmap": [],
        "recent_events": [],
        "filters": {"sites": [{"code": "MAIN", "name": "Nhà máy chính"}]},
        "generated_at": now,
    }


@pytest.fixture
def reports_client():
    app.dependency_overrides[report_viewer] = lambda: {
        "id": uuid4(),
        "memberships": [{"organization_id": uuid4(), "is_default": True}],
    }
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.pop(report_viewer, None)


def test_report_overview_returns_analytics(reports_client, monkeypatch):
    captured = {}

    def fake_overview(_user, days, site):
        captured.update(days=days, site=site)
        return report_payload()

    monkeypatch.setattr(report_service, "overview", fake_overview)
    response = reports_client.get("/api/reports/overview?period=30d&site=MAIN")

    assert response.status_code == 200
    assert response.json()["summary"]["total_events"] == 12
    assert response.json()["summary"]["resolution_rate"] == 66.7
    assert response.json()["response_metrics"]["acknowledge_p95_seconds"] == 180
    assert response.json()["response_metrics"]["overdue_events"] == 0
    assert captured == {"days": 30, "site": "MAIN"}


def test_report_rejects_unknown_period(reports_client):
    response = reports_client.get("/api/reports/overview?period=14d")
    assert response.status_code == 422


def test_report_export_returns_utf8_csv(reports_client, monkeypatch):
    monkeypatch.setattr(
        report_service,
        "export_csv",
        lambda _user, _days, _site: "\ufeffThời gian,Loại vi phạm\r\n",
    )
    response = reports_client.get("/api/reports/export?period=7d")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "bao-cao-an-toan-7d.csv" in response.headers["content-disposition"]
    assert response.content.startswith(b"\xef\xbb\xbf")


@pytest.mark.skipif(os.getenv('TEST_REPORTS_SQL') != '1', reason='Opt-in PostgreSQL session-local report fixtures')
def test_report_percentiles_overdue_and_utc_days_use_scoped_real_data(monkeypatch):
    org, foreign, site, other_site = [uuid4() for _ in range(4)]
    end = datetime.now(timezone.utc)
    start = end.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=6)
    base = start + timedelta(days=1, hours=23, minutes=30)
    monkeypatch.setattr(report_service, '_window', lambda days: (start, end, start - timedelta(days=days)))
    with connection() as conn:
        # These unconstrained temporary copies never write to real event/site tables.
        names = {}
        for name in ['safety_events', 'sites', 'incidents', 'event_types', 'cameras', 'zones']:
            conn.execute(f'CREATE TEMP TABLE report_{name} AS SELECT * FROM safety.{name} WITH NO DATA')
            names[f'safety.{name}'] = f'pg_temp.report_{name}'
        conn.execute("SET LOCAL TIME ZONE 'Asia/Ho_Chi_Minh'")
        conn.execute("INSERT INTO report_sites(id,organization_id,code,name,is_active) VALUES(%s,%s,'MAIN','Main',true),(%s,%s,'OTHER','Other',true)", (site, org, other_site, org))
        conn.execute("""INSERT INTO report_safety_events(id,organization_id,site_id,status,severity,detected_at,acknowledged_at)
          SELECT gen_random_uuid(),%s,%s,'acknowledged','critical',%s::timestamptz,%s::timestamptz+n*interval '100 seconds'
          FROM generate_series(1,100) n""", (org, site, base, base))
        conn.execute("""INSERT INTO report_safety_events(id,organization_id,site_id,status,severity,detected_at,acknowledged_at,resolved_at)
          VALUES(gen_random_uuid(),%s,%s,'acknowledged','low',%s,%s,NULL),
                (gen_random_uuid(),%s,%s,'acknowledged','low',%s,%s,NULL),
                (gen_random_uuid(),%s,%s,'resolved','low',%s,NULL,%s),
                (gen_random_uuid(),%s,%s,'resolved','low',%s,NULL,%s),
                (gen_random_uuid(),%s,%s,'new','high',%s,NULL,NULL),
                (gen_random_uuid(),%s,%s,'new','high',%s,NULL,NULL),
                (gen_random_uuid(),%s,%s,'new','high',%s,%s,NULL),
                (gen_random_uuid(),%s,%s,'new','high',%s,NULL,NULL),
                (gen_random_uuid(),%s,%s,'new','high',%s,NULL,NULL),
                (gen_random_uuid(),%s,%s,'dismissed','low',%s,NULL,NULL)""", (
            org, site, base, base + timedelta(seconds=90000),
            org, site, base, base - timedelta(seconds=1),
            org, site, base, base + timedelta(seconds=7200),
            org, site, base, base - timedelta(seconds=1),
            org, site, base,
            org, site, end - timedelta(hours=1),
            org, site, base, base - timedelta(seconds=1),
            org, other_site, base,
            foreign, site, base,
            org, site, base,
        ))
        class Isolated:
            def execute(self, sql, params=None):
                for source, target in names.items(): sql = sql.replace(source, target)
                return conn.execute(sql, params)
        @contextmanager
        def temporary_connection(): yield Isolated()
        monkeypatch.setattr(report_service, 'connection', temporary_connection)
        data = report_service.overview({'memberships': [{'organization_id': org}]}, 7, 'MAIN')
        response = data['response_metrics']
        assert response['pending_events'] == 3
        assert response['acknowledged_events'] == 102
        assert response['overdue_events'] == 1  # Acknowledged/dismissed/resolved and inconsistent timestamps excluded.
        assert response['acknowledge_samples'] == 101  # Negative durations excluded.
        assert response['acknowledged_within_24h'] == 100
        assert response['acknowledge_p50_seconds'] == 5100
        assert response['acknowledge_p95_seconds'] == 9600
        assert response['acknowledge_p99_seconds'] == 10000
        assert response['resolution_samples'] == 1 and response['resolution_p99_seconds'] == 7200
        assert len(data['trend']) == 7
        assert sum(row['total'] for row in data['trend']) == data['summary']['total_events'] == 108
        utc_day = next(row for row in data['trend'] if row['day'] == base.date())
        assert utc_day['total'] == 107  # 23:30 UTC stays on its UTC date despite a UTC+7 DB session.
        assert next(row for row in data['heatmap'] if row['hour'] == 23)['total'] == 107
        unfiltered = report_service.overview({'memberships': [{'organization_id': org}]}, 7, None)
        assert unfiltered['response_metrics']['overdue_events'] == 2  # Includes the other site, never the other org.
        empty = report_service.overview({'memberships': [{'organization_id': foreign}]}, 7, 'OTHER')
        assert empty['response_metrics']['acknowledge_p50_seconds'] is None
        assert empty['summary']['total_events'] == 0
        conn.rollback()
