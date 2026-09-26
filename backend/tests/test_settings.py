from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.api.settings import settings_manager
from app.main import app
from app.services import settings_service


def response_payload():
    settings = deepcopy(settings_service.DEFAULT_SETTINGS)
    settings["general"]["organization_name"] = "Factory AI Safety"
    settings["general"]["timezone"] = "Asia/Ho_Chi_Minh"
    return {
        "organization_id": uuid4(),
        "organization_code": "FACTORY_AI",
        "settings": settings,
        "health": {
            "database": "healthy",
            "backend": "healthy",
            "cameras_total": 9,
            "cameras_online": 9,
            "models_registered": 2,
            "events_total": 0,
            "open_alerts": 0,
            "active_users": 2,
            "checked_at": datetime.now(timezone.utc),
        },
        "recent_changes": [],
        "updated_at": datetime.now(timezone.utc),
    }


@pytest.fixture
def settings_client():
    app.dependency_overrides[settings_manager] = lambda: {
        "id": uuid4(),
        "memberships": [{"organization_id": uuid4(), "is_default": True}],
    }
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.pop(settings_manager, None)


def test_settings_endpoint_returns_all_configuration_groups(settings_client, monkeypatch):
    monkeypatch.setattr(settings_service, "get_settings", lambda _user: response_payload())
    response = settings_client.get("/api/settings")
    assert response.status_code == 200
    body = response.json()
    assert set(body["settings"]) == {"general", "ai", "alerts", "retention", "security"}
    assert body["health"]["cameras_total"] == 9


def test_settings_validation_requires_one_notification_channel(settings_client):
    payload = response_payload()["settings"]
    payload["alerts"]["in_app_enabled"] = False
    payload["alerts"]["email_enabled"] = False
    payload["alerts"]["webhook_enabled"] = False
    response = settings_client.post("/api/settings", json=payload)
    assert response.status_code == 422


def test_settings_update_returns_saved_configuration(settings_client, monkeypatch):
    payload = response_payload()
    monkeypatch.setattr(settings_service, "update_settings", lambda _body, _user: payload)
    response = settings_client.post("/api/settings", json=payload["settings"])
    assert response.status_code == 200
    assert response.json()["success"] is True
    assert response.json()["settings"]["settings"]["ai"]["detection_confidence"] == 0.5
