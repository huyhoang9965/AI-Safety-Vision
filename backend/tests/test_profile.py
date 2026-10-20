import base64
import io
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.security import create_access_token
from app.services import profile_service


@pytest.fixture
def account():
    return {"id": uuid4(), "email": "profile@example.test", "username": "profile-user",
            "full_name": "Profile User", "department": "Safety", "job_title": "Engineer",
            "phone": None, "avatar_url": None, "status": "active", "email_verified": True,
            "memberships": []}


@pytest.fixture
def client(monkeypatch, account):
    monkeypatch.setattr("app.services.auth_service.get_user", lambda user_id: account if str(user_id) == str(account["id"]) else None)
    with patch("app.database.database.initialize_database", side_effect=RuntimeError("test database offline")):
        with TestClient(app) as client:
            yield client


def headers(account):
    token, _ = create_access_token(str(account["id"]))
    return {"Authorization": "Bearer " + token}


def test_profile_requires_login(client, monkeypatch):
    called = []
    monkeypatch.setattr(profile_service, "update_profile", lambda *args: called.append(args))
    response = client.post("/api/auth/me", json={"full_name": "Updated Name"})
    assert response.status_code == 401
    assert called == []


def test_profile_updates_authenticated_account_without_admin_permission(client, account, monkeypatch):
    called = []

    def update(user_id, body):
        called.append((user_id, body))
        return {**account, "full_name": body.full_name, "phone": body.phone}

    monkeypatch.setattr(profile_service, "update_profile", update)
    response = client.post("/api/auth/me", headers=headers(account), json={"full_name": "  Updated Name  ", "phone": "0901234567"})
    assert response.status_code == 200
    assert called[0][0] == account["id"]
    assert response.json()["full_name"] == "Updated Name"
    assert response.json()["email"] == account["email"]
    assert "password_hash" not in response.json()


@pytest.mark.parametrize("extra", [{"user_id": str(uuid4())}, {"role": "admin"}, {"email": "other@example.test"}, {"memberships": []}])
def test_profile_rejects_identity_and_permissions_changes(client, account, monkeypatch, extra):
    called = []
    monkeypatch.setattr(profile_service, "update_profile", lambda *args: called.append(args))
    response = client.post("/api/auth/me", headers=headers(account), json={"full_name": "Updated Name", **extra})
    assert response.status_code == 422
    assert called == []


def test_duplicate_username_returns_conflict(client, account, monkeypatch):
    def conflict(*args):
        raise profile_service.ProfileConflictError("Tên tài khoản này đã được sử dụng")

    monkeypatch.setattr(profile_service, "update_profile", conflict)
    response = client.post("/api/auth/me", headers=headers(account), json={"full_name": "Updated Name"})
    assert response.status_code == 409


def test_incorrect_current_password_is_not_an_expired_token(client, account, monkeypatch):
    def incorrect(*args):
        raise profile_service.ProfileError("Mật khẩu hiện tại không chính xác")

    monkeypatch.setattr(profile_service, "change_password", incorrect)
    response = client.post("/api/auth/me/password", headers=headers(account), json={"current_password": "wrong", "new_password": "NewSecret123!"})
    assert response.status_code == 400
    assert "hiện tại" in response.json()["detail"]


def test_password_change_returns_a_new_session_for_same_account(client, account, monkeypatch):
    called = []

    def change(user_id, current, new, *context):
        called.append((user_id, current, new))
        return {"access_token": "new-access-token", "refresh_token": "r" * 64,
                "expires_in": 900, "user": account}

    monkeypatch.setattr(profile_service, "change_password", change)
    response = client.post("/api/auth/me/password", headers=headers(account), json={"current_password": "OldSecret123!", "new_password": "NewSecret123!"})
    assert response.status_code == 200
    assert response.json()["user"]["id"] == str(account["id"])
    assert response.json()["refresh_token"] == "r" * 64
    assert called == [(account["id"], "OldSecret123!", "NewSecret123!")]


@pytest.mark.parametrize("password", ["short", "a" * 73, "ắ" * 30, "OldSecret123!"])
def test_password_policy_rejects_invalid_new_password(client, account, monkeypatch, password):
    called = []
    monkeypatch.setattr(profile_service, "change_password", lambda *args: called.append(args))
    response = client.post("/api/auth/me/password", headers=headers(account), json={"current_password": "OldSecret123!", "new_password": password})
    assert response.status_code == 422
    assert called == []


def test_avatar_decodes_and_reencodes_a_real_image(tmp_path):
    output = io.BytesIO()
    image = Image.new("RGB", (800, 600), "blue")
    image.save(output, format="JPEG")
    url, path = profile_service._write_avatar("data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode(), tmp_path)
    assert url.startswith("/avatars/")
    with Image.open(path) as actual:
        assert actual.format == "PNG"
        assert actual.size == (512, 384)


@pytest.mark.parametrize("data", ["data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,%%%%", "data:image/png;base64,bm90IGFuIGltYWdl"])
def test_avatar_rejects_non_images_without_writing_files(tmp_path, data):
    with pytest.raises(profile_service.ProfileError):
        profile_service._write_avatar(data, tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_failed_profile_update_cleans_up_uploaded_avatar(monkeypatch, tmp_path):
    new_file = tmp_path / "new.png"
    new_file.write_bytes(b"fixture")
    monkeypatch.setattr(profile_service, "_write_avatar", lambda *args: ("/avatars/new.png", new_file))

    def unavailable():
        raise RuntimeError("Database unavailable")

    monkeypatch.setattr(profile_service, "connection", unavailable)
    from app.profile_schemas import UpdateProfileRequest

    with pytest.raises(RuntimeError):
        profile_service.update_profile(uuid4(), UpdateProfileRequest(full_name="Test User", avatar_data="image"))
    assert not new_file.exists()
