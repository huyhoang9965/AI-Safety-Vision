from datetime import date, datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.api.reports import report_viewer
from app.main import app
from app.services import report_service


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
