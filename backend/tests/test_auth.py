from dataclasses import replace
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.security import TokenError, create_access_token, decode_access_token


def sample_user():
    return {
        "id": uuid4(),
        "email": "safety@example.com",
        "username": None,
        "full_name": "Safety User",
        "department": "EHS",
        "job_title": "Safety Engineer",
        "phone": None,
        "avatar_url": None,
        "status": "active",
        "email_verified": True,
        "memberships": [],
    }


def test_access_token_round_trip_and_rejects_wrong_secret():
    settings = replace(get_settings(), jwt_secret="a" * 40)
    token, expires_in = create_access_token(str(uuid4()), settings)

    assert expires_in == settings.access_token_minutes * 60
    assert decode_access_token(token, settings)["type"] == "access"
    with pytest.raises(TokenError):
        decode_access_token(token, replace(settings, jwt_secret="b" * 40))


def test_register_endpoint(monkeypatch):
    user = sample_user()
    monkeypatch.setattr("app.services.auth_service.register_user", lambda body: user)

    with patch(
        "app.database.database.initialize_database",
        side_effect=RuntimeError("test database offline"),
    ):
        with TestClient(app) as client:
            response = client.post(
                "/api/auth/register",
                json={
                    "email": "safety@example.com",
                    "password": "StrongPass123!",
                    "full_name": "Safety User",
                    "department": "EHS",
                    "job_title": "Safety Engineer",
                },
            )

    assert response.status_code == 201
    assert response.json()["user"]["email"] == "safety@example.com"


def test_login_and_me_endpoints(monkeypatch):
    user = sample_user()
    token, _ = create_access_token(str(user["id"]))
    monkeypatch.setattr(
        "app.services.auth_service.login_user",
        lambda *args: {
            "access_token": token,
            "refresh_token": "r" * 64,
            "expires_in": 900,
            "user": user,
        },
    )
    monkeypatch.setattr("app.services.auth_service.get_user", lambda user_id: user)

    with patch(
        "app.database.database.initialize_database",
        side_effect=RuntimeError("test database offline"),
    ):
        with TestClient(app) as client:
            login_response = client.post(
                "/api/auth/login",
                json={"email": "safety@example.com", "password": "StrongPass123!"},
            )
            me_response = client.get(
                "/api/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )

    assert login_response.status_code == 200
    assert login_response.json()["token_type"] == "bearer"
    assert me_response.status_code == 200
    assert me_response.json()["id"] == str(user["id"])
