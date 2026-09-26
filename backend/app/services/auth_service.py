from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from app.auth_schemas import RegisterRequest
from app.config import get_settings
from app.database.database import connection
from app.security import create_access_token, create_refresh_token, hash_refresh_token


class AuthenticationError(ValueError):
    pass


class RegistrationError(ValueError):
    pass


def _permissions_for_role(conn: Any, role_id: UUID) -> list[str]:
    rows = conn.execute(
        """
        SELECT p.code
        FROM safety.role_permissions rp
        JOIN safety.permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = %s
        ORDER BY p.code
        """,
        (role_id,),
    ).fetchall()
    return [row["code"] for row in rows]


def _user_payload(conn: Any, user_id: UUID | str) -> dict[str, Any] | None:
    user = conn.execute(
        """
        SELECT id, email, username, full_name, department, job_title, phone,
               avatar_url, status::text AS status,
               email_verified_at IS NOT NULL AS email_verified
        FROM safety.users
        WHERE id = %s AND deleted_at IS NULL
        """,
        (user_id,),
    ).fetchone()
    if not user:
        return None

    memberships = conn.execute(
        """
        SELECT om.organization_id, o.code AS organization_code,
               o.name AS organization_name, r.id AS role_id,
               r.code AS role_code, r.name AS role_name, om.is_default
        FROM safety.organization_members om
        JOIN safety.organizations o ON o.id = om.organization_id AND o.is_active
        JOIN safety.roles r ON r.id = om.role_id
        WHERE om.user_id = %s
        ORDER BY om.is_default DESC, o.name
        """,
        (user_id,),
    ).fetchall()

    payload = dict(user)
    payload["memberships"] = [
        {
            "organization_id": row["organization_id"],
            "organization_code": row["organization_code"],
            "organization_name": row["organization_name"],
            "role_code": row["role_code"],
            "role_name": row["role_name"],
            "is_default": row["is_default"],
            "permissions": _permissions_for_role(conn, row["role_id"]),
        }
        for row in memberships
    ]
    return payload


def register_user(request: RegisterRequest) -> dict[str, Any]:
    settings = get_settings()
    try:
        with connection() as conn:
            row = conn.execute(
                "SELECT safety.register_user(%s, %s, %s, %s, %s, %s) AS user_id",
                (
                    request.email,
                    request.password.get_secret_value(),
                    request.full_name,
                    request.username,
                    request.department,
                    request.job_title,
                ),
            ).fetchone()
            user_id = row["user_id"]
            if not settings.require_email_verification:
                conn.execute(
                    """
                    UPDATE safety.users
                    SET status = 'active',
                        email_verified_at = COALESCE(email_verified_at, now())
                    WHERE id = %s
                    """,
                    (user_id,),
                )
            user = _user_payload(conn, user_id)
    except Exception as exc:
        message = str(exc).split("\n", 1)[0]
        if "Email hoac username da ton tai" in message:
            raise RegistrationError("Email hoặc tên đăng nhập đã tồn tại") from exc
        if "Email khong hop le" in message:
            raise RegistrationError("Email không hợp lệ") from exc
        if "Mat khau" in message:
            raise RegistrationError("Mật khẩu phải có ít nhất 8 ký tự") from exc
        raise

    if user is None:
        raise RegistrationError("Không thể tạo tài khoản")
    return user


def login_user(
    email: str,
    password: str,
    ip_address: str | None,
    user_agent: str | None,
) -> dict[str, Any]:
    settings = get_settings()
    failure_message: str | None = None
    result: dict[str, Any] | None = None

    with connection() as conn:
        auth = conn.execute(
            "SELECT * FROM safety.authenticate_user(%s, %s, %s, %s)",
            (email, password, ip_address, user_agent),
        ).fetchone()
        if not auth or not auth["authenticated"]:
            failure_message = auth["message"] if auth else "Đăng nhập thất bại"
        else:
            user_id = auth["user_id"]
            refresh_token = create_refresh_token()
            expires_at = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_days)
            conn.execute(
                "SELECT safety.create_session(%s, %s, %s, %s, %s, %s)",
                (
                    user_id,
                    hash_refresh_token(refresh_token),
                    expires_at,
                    ip_address,
                    user_agent,
                    None,
                ),
            )
            user = _user_payload(conn, user_id)
            access_token, expires_in = create_access_token(str(user_id), settings)
            result = {
                "access_token": access_token,
                "refresh_token": refresh_token,
                "expires_in": expires_in,
                "user": user,
            }

    if failure_message is not None:
        raise AuthenticationError(failure_message)
    if result is None:
        raise AuthenticationError("Đăng nhập thất bại")
    return result


def refresh_session(
    refresh_token: str,
    ip_address: str | None,
    user_agent: str | None,
) -> dict[str, Any]:
    settings = get_settings()
    token_hash = hash_refresh_token(refresh_token)
    with connection() as conn:
        session = conn.execute(
            """
            SELECT s.id, s.user_id
            FROM safety.auth_sessions s
            JOIN safety.users u ON u.id = s.user_id
            WHERE s.refresh_token_hash = %s
              AND s.revoked_at IS NULL
              AND s.expires_at > now()
              AND u.status = 'active'
              AND u.deleted_at IS NULL
            FOR UPDATE OF s
            """,
            (token_hash,),
        ).fetchone()
        if not session:
            raise AuthenticationError("Phiên đăng nhập không hợp lệ hoặc đã hết hạn")

        conn.execute(
            """
            UPDATE safety.auth_sessions
            SET revoked_at = now(), last_used_at = now()
            WHERE id = %s
            """,
            (session["id"],),
        )
        new_refresh_token = create_refresh_token()
        expires_at = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_days)
        conn.execute(
            "SELECT safety.create_session(%s, %s, %s, %s, %s, %s)",
            (
                session["user_id"],
                hash_refresh_token(new_refresh_token),
                expires_at,
                ip_address,
                user_agent,
                None,
            ),
        )
        user = _user_payload(conn, session["user_id"])
        access_token, expires_in = create_access_token(str(session["user_id"]), settings)

    return {
        "access_token": access_token,
        "refresh_token": new_refresh_token,
        "expires_in": expires_in,
        "user": user,
    }


def logout_session(refresh_token: str) -> bool:
    with connection() as conn:
        result = conn.execute(
            """
            UPDATE safety.auth_sessions
            SET revoked_at = COALESCE(revoked_at, now())
            WHERE refresh_token_hash = %s
            """,
            (hash_refresh_token(refresh_token),),
        )
        return result.rowcount > 0


def get_user(user_id: UUID | str) -> dict[str, Any] | None:
    with connection() as conn:
        return _user_payload(conn, user_id)
