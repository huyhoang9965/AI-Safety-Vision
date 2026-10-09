from datetime import datetime, timezone
from dataclasses import replace
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient

from app.api.chat import chat_user
from app.main import app
from app.config import get_settings


def test_chat_status_is_permission_protected_and_reports_local_mode(monkeypatch):
    monkeypatch.setattr("app.services.chat_service.get_settings", lambda: replace(get_settings(), openrouter_api_key=""))
    app.dependency_overrides[chat_user] = lambda: {"id": uuid4(), "memberships": []}
    try:
        with patch("app.database.database.initialize_database", side_effect=RuntimeError("offline")):
            with TestClient(app) as client:
                response = client.get("/api/chat/status")
        assert response.status_code == 200
        assert response.json()["mode"] == "local"
        assert response.json()["available"] is True
    finally:
        app.dependency_overrides.pop(chat_user, None)


def test_chat_message_returns_persisted_contract(monkeypatch):
    user_id = uuid4()
    conversation_id = uuid4()
    now = datetime.now(timezone.utc).isoformat()
    app.dependency_overrides[chat_user] = lambda: {"id": user_id, "memberships": []}
    message = {
        "id": str(uuid4()), "role": "user", "content": "Tom tat dashboard",
        "model_name": None, "latency_ms": None, "metadata": {},
        "created_at": now, "feedback": None,
    }
    assistant = {
        **message, "id": str(uuid4()), "role": "assistant", "content": "Khong co canh bao.",
        "model_name": "local-readonly-v1", "latency_ms": 4,
        "metadata": {"read_only": True},
    }
    monkeypatch.setattr("app.services.chat_service.send_message", lambda body, user: {
        "conversation_id": str(conversation_id), "user_message": message,
        "assistant_message": assistant,
        "tool_calls": [{"name": "get_dashboard_summary", "label": "Tong hop", "status": "completed", "duration_ms": 3}],
        "mode": "local",
    })
    try:
        with patch("app.database.database.initialize_database", side_effect=RuntimeError("offline")):
            with TestClient(app) as client:
                response = client.post("/api/chat/messages", json={"message": "Tom tat dashboard"})
        assert response.status_code == 200
        assert response.json()["conversation_id"] == str(conversation_id)
        assert response.json()["assistant_message"]["metadata"]["read_only"] is True
    finally:
        app.dependency_overrides.pop(chat_user, None)


def test_chat_status_reports_openrouter_without_exposing_key(monkeypatch):
    settings = replace(get_settings(), openrouter_api_key="fake-private-key", openrouter_model="test-model")
    monkeypatch.setattr("app.services.chat_service.get_settings", lambda: settings)
    app.dependency_overrides[chat_user] = lambda: {"id": uuid4(), "memberships": []}
    try:
        with patch("app.database.database.initialize_database", side_effect=RuntimeError("offline")):
            with TestClient(app) as client:
                response = client.get("/api/chat/status")
        assert response.status_code == 200
        assert response.json()["mode"] == "openrouter"
        assert response.json()["llm_configured"] is True
        assert response.json()["model"] == "test-model"
        assert "fake-private-key" not in response.text
    finally:
        app.dependency_overrides.pop(chat_user, None)
