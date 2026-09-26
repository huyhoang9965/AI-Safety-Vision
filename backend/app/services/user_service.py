from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from app.database.database import connection
from app.user_schemas import UserCreateRequest, UserUpdateRequest


class UserNotFoundError(ValueError):
    pass


class UserConflictError(ValueError):
    pass


def _primary_membership(user: dict[str, Any]) -> dict[str, Any]:
    memberships = user.get("memberships", [])
    if not memberships:
        raise UserConflictError("Tài khoản chưa thuộc tổ chức nào")
    return next((item for item in memberships if item.get("is_default")), memberships[0])


def _organization(user: dict[str, Any]) -> tuple[UUID, str]:
    membership = _primary_membership(user)
    return membership["organization_id"], membership["organization_name"]


def _can_assign_super_admin(user: dict[str, Any]) -> bool:
    return any(
        membership.get("role_code") == "super_admin"
        for membership in user.get("memberships", [])
    )


def _user_select() -> str:
    return """
        SELECT u.id, u.email, u.username, u.full_name, u.department, u.job_title,
               u.phone, u.avatar_url, u.status::text AS status,
               u.email_verified_at IS NOT NULL AS email_verified,
               u.last_login_at, u.failed_login_count, u.locked_until, u.created_at,
               r.id AS role_id, r.code AS role_code, r.name AS role_name,
               COALESCE((SELECT array_agg(p.code ORDER BY p.code)
                         FROM safety.role_permissions rp
                         JOIN safety.permissions p ON p.id = rp.permission_id
                         WHERE rp.role_id = r.id), ARRAY[]::varchar[]) AS permissions,
               COALESCE((SELECT array_agg(usa.site_id ORDER BY usa.site_id)
                         FROM safety.user_site_access usa
                         WHERE usa.user_id = u.id), ARRAY[]::uuid[]) AS site_ids,
               (SELECT count(*)::int FROM safety.user_site_access usa
                WHERE usa.user_id = u.id) AS site_count,
               (SELECT count(*)::int FROM safety.auth_sessions ses
                WHERE ses.user_id = u.id AND ses.revoked_at IS NULL AND ses.expires_at > now()) AS active_sessions,
               COALESCE(uc.must_change_password, false) AS must_change_password
        FROM safety.organization_members om
        JOIN safety.users u ON u.id = om.user_id AND u.deleted_at IS NULL
        JOIN safety.roles r ON r.id = om.role_id
        LEFT JOIN safety.user_credentials uc ON uc.user_id = u.id
    """


def list_users(user: dict[str, Any]) -> dict[str, Any]:
    organization_id, organization_name = _organization(user)
    allow_super = _can_assign_super_admin(user)
    with connection() as conn:
        users = conn.execute(
            _user_select() + " WHERE om.organization_id = %s ORDER BY u.created_at DESC",
            (organization_id,),
        ).fetchall()
        roles = conn.execute(
            """
            SELECT r.id, r.code, r.name, r.description, r.is_system,
                   COALESCE((SELECT array_agg(p.code ORDER BY p.code)
                             FROM safety.role_permissions rp
                             JOIN safety.permissions p ON p.id = rp.permission_id
                             WHERE rp.role_id = r.id), ARRAY[]::varchar[]) AS permissions,
                   (SELECT count(*)::int FROM safety.organization_members om
                    WHERE om.role_id = r.id AND om.organization_id = %s) AS member_count
            FROM safety.roles r
            WHERE (%s OR r.code <> 'super_admin')
            ORDER BY CASE r.code WHEN 'org_admin' THEN 0 WHEN 'safety_manager' THEN 1
                     WHEN 'operator' THEN 2 WHEN 'viewer' THEN 3 ELSE 4 END, r.name
            """, (organization_id, allow_super),
        ).fetchall()
        permissions = conn.execute(
            "SELECT id, code, name, description FROM safety.permissions ORDER BY code"
        ).fetchall()
        sites = conn.execute(
            "SELECT id, code, name FROM safety.sites WHERE organization_id=%s AND is_active ORDER BY name",
            (organization_id,),
        ).fetchall()
        summary = conn.execute(
            """
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE u.status='active')::int AS active,
                   count(*) FILTER (WHERE u.status='pending')::int AS pending,
                   count(*) FILTER (WHERE u.status='locked')::int AS locked,
                   count(*) FILTER (WHERE u.status='disabled')::int AS disabled,
                   count(*) FILTER (WHERE r.code IN ('org_admin','super_admin'))::int AS admins,
                   (SELECT count(*)::int FROM safety.auth_sessions ses
                    JOIN safety.organization_members m ON m.user_id=ses.user_id
                    WHERE m.organization_id=%s AND ses.revoked_at IS NULL
                      AND ses.expires_at>now()) AS active_sessions
            FROM safety.organization_members om
            JOIN safety.users u ON u.id=om.user_id AND u.deleted_at IS NULL
            JOIN safety.roles r ON r.id=om.role_id
            WHERE om.organization_id=%s
            """, (organization_id, organization_id),
        ).fetchone()
    empty = {"total": 0, "active": 0, "pending": 0, "locked": 0,
             "disabled": 0, "admins": 0, "active_sessions": 0}
    return {
        "users": [dict(row) for row in users],
        "roles": [dict(row) for row in roles],
        "permissions": [dict(row) for row in permissions],
        "sites": [dict(row) for row in sites],
        "summary": dict(summary) if summary else empty,
        "organization_name": organization_name,
    }


def _find_user(conn: Any, user_id: UUID, organization_id: UUID) -> dict[str, Any] | None:
    return conn.execute(
        _user_select() + " WHERE om.organization_id=%s AND u.id=%s",
        (organization_id, user_id),
    ).fetchone()


def user_detail(user_id: UUID, user: dict[str, Any]) -> dict[str, Any]:
    organization_id, _ = _organization(user)
    with connection() as conn:
        target = _find_user(conn, user_id, organization_id)
        if not target:
            raise UserNotFoundError("Không tìm thấy người dùng")
        logins = conn.execute(
            """SELECT id, succeeded, failure_reason, ip_address::text AS ip_address,
                      user_agent, attempted_at
               FROM safety.login_attempts WHERE user_id=%s
               ORDER BY attempted_at DESC LIMIT 15""", (user_id,),
        ).fetchall()
        audits = conn.execute(
            """SELECT a.id, a.action, a.entity_type, a.entity_id, a.created_at,
                      actor.full_name AS actor_name
               FROM safety.audit_logs a
               LEFT JOIN safety.users actor ON actor.id=a.actor_user_id
               WHERE a.organization_id=%s AND (a.actor_user_id=%s OR a.entity_id=%s)
               ORDER BY a.created_at DESC LIMIT 20""",
            (organization_id, user_id, str(user_id)),
        ).fetchall()
        sessions = conn.execute(
            """SELECT id, ip_address::text AS ip_address, user_agent, device_name,
                      created_at, last_used_at, expires_at
               FROM safety.auth_sessions
               WHERE user_id=%s AND revoked_at IS NULL AND expires_at>now()
               ORDER BY created_at DESC LIMIT 10""", (user_id,),
        ).fetchall()
    return {**dict(target), "login_activity": [dict(row) for row in logins],
            "audit_activity": [dict(row) for row in audits],
            "sessions": [dict(row) for row in sessions]}


def _role(conn: Any, role_id: UUID, user: dict[str, Any]) -> dict[str, Any]:
    role = conn.execute("SELECT id, code, name FROM safety.roles WHERE id=%s", (role_id,)).fetchone()
    if not role or (role["code"] == "super_admin" and not _can_assign_super_admin(user)):
        raise UserConflictError("Vai trò không hợp lệ hoặc vượt quá quyền quản trị của bạn")
    return role


def _validate_sites(conn: Any, site_ids: list[UUID], organization_id: UUID) -> None:
    if not site_ids:
        return
    count = conn.execute(
        "SELECT count(*)::int AS total FROM safety.sites WHERE organization_id=%s AND id=ANY(%s::uuid[])",
        (organization_id, list(set(site_ids))),
    ).fetchone()["total"]
    if count != len(set(site_ids)):
        raise UserConflictError("Một hoặc nhiều nhà máy không thuộc tổ chức hiện tại")


def _audit(conn: Any, organization_id: UUID, actor_id: UUID, action: str,
           entity_id: UUID, data: dict[str, Any]) -> None:
    conn.execute(
        """INSERT INTO safety.audit_logs
           (organization_id, actor_user_id, action, entity_type, entity_id, new_data)
           VALUES (%s,%s,%s,'user',%s,%s::jsonb)""",
        (organization_id, actor_id, action, str(entity_id), json.dumps(data)),
    )


def _set_site_access(conn: Any, user_id: UUID, site_ids: list[UUID], actor_id: UUID) -> None:
    conn.execute("DELETE FROM safety.user_site_access WHERE user_id=%s", (user_id,))
    if site_ids:
        conn.executemany(
            "INSERT INTO safety.user_site_access (user_id,site_id,granted_by) VALUES (%s,%s,%s)",
            [(user_id, site_id, actor_id) for site_id in dict.fromkeys(site_ids)],
        )


def _role_has_manage(conn: Any, role_id: UUID) -> bool:
    return conn.execute(
        """SELECT 1 FROM safety.role_permissions rp
           JOIN safety.permissions p ON p.id=rp.permission_id
           WHERE rp.role_id=%s AND p.code='user.manage'""", (role_id,),
    ).fetchone() is not None


def _protect_last_admin(conn: Any, user_id: UUID, organization_id: UUID,
                        removing_admin: bool) -> None:
    if not removing_admin:
        return
    current = conn.execute(
        """SELECT r.code FROM safety.organization_members om
           JOIN safety.roles r ON r.id=om.role_id
           WHERE om.organization_id=%s AND om.user_id=%s""",
        (organization_id, user_id),
    ).fetchone()
    if not current or current["code"] not in ("org_admin", "super_admin"):
        return
    admins = conn.execute(
        """SELECT count(*)::int AS total FROM safety.organization_members om
           JOIN safety.users u ON u.id=om.user_id
           JOIN safety.roles r ON r.id=om.role_id
           WHERE om.organization_id=%s AND u.status='active'
             AND u.deleted_at IS NULL AND r.code IN ('org_admin','super_admin')""",
        (organization_id,),
    ).fetchone()["total"]
    if admins <= 1:
        raise UserConflictError("Không thể thay đổi quản trị viên hoạt động cuối cùng của tổ chức")


def create_user(body: UserCreateRequest, user: dict[str, Any]) -> UUID:
    organization_id, _ = _organization(user)
    actor_id = user["id"]
    with connection() as conn:
        role = _role(conn, body.role_id, user)
        _validate_sites(conn, body.site_ids, organization_id)
        duplicate = conn.execute(
            """SELECT 1 FROM safety.users WHERE deleted_at IS NULL AND
               (lower(email)=lower(%s) OR (%s IS NOT NULL AND lower(username)=lower(%s)))""",
            (body.email, body.username, body.username),
        ).fetchone()
        if duplicate:
            raise UserConflictError("Email hoặc tên đăng nhập đã tồn tại")
        try:
            row = conn.execute(
                "SELECT safety.register_user(%s,%s,%s,%s,%s,%s) AS id",
                (body.email, body.temporary_password.get_secret_value(), body.full_name.strip(),
                 body.username, body.department, body.job_title),
            ).fetchone()
        except Exception as exc:
            raise UserConflictError(str(exc).split("\n", 1)[0]) from exc
        user_id = row["id"]
        conn.execute(
            """UPDATE safety.users SET phone=%s, status=%s::safety.user_status,
               email_verified_at=CASE WHEN %s='active' THEN now() ELSE email_verified_at END,
               updated_at=now() WHERE id=%s""",
            (body.phone, body.status, body.status, user_id),
        )
        conn.execute(
            "UPDATE safety.user_credentials SET must_change_password=true WHERE user_id=%s",
            (user_id,),
        )
        conn.execute(
            """INSERT INTO safety.organization_members (organization_id,user_id,role_id,is_default)
               VALUES (%s,%s,%s,true)""", (organization_id, user_id, role["id"]),
        )
        _set_site_access(conn, user_id, body.site_ids, actor_id)
        _audit(conn, organization_id, actor_id, "user.create", user_id,
               {"email": body.email, "role": role["code"], "status": body.status,
                "site_ids": [str(item) for item in body.site_ids]})
        return user_id


def update_user(user_id: UUID, body: UserUpdateRequest, user: dict[str, Any]) -> None:
    organization_id, _ = _organization(user)
    actor_id = user["id"]
    with connection() as conn:
        target = _find_user(conn, user_id, organization_id)
        if not target:
            raise UserNotFoundError("Không tìm thấy người dùng")
        role = _role(conn, body.role_id, user)
        _validate_sites(conn, body.site_ids, organization_id)
        duplicate = conn.execute(
            """SELECT 1 FROM safety.users WHERE id<>%s AND deleted_at IS NULL AND
               (lower(email)=lower(%s) OR (%s IS NOT NULL AND lower(username)=lower(%s)))""",
            (user_id, body.email, body.username, body.username),
        ).fetchone()
        if duplicate:
            raise UserConflictError("Email hoặc tên đăng nhập đã tồn tại")
        if user_id == actor_id and not _role_has_manage(conn, body.role_id):
            raise UserConflictError("Bạn không thể tự gỡ quyền quản lý người dùng của chính mình")
        _protect_last_admin(
            conn, user_id, organization_id,
            target["role_code"] in ("org_admin", "super_admin")
            and role["code"] not in ("org_admin", "super_admin"),
        )
        conn.execute(
            """UPDATE safety.users SET email=lower(%s), username=NULLIF(%s,''),
               full_name=%s, department=NULLIF(%s,''), job_title=NULLIF(%s,''),
               phone=NULLIF(%s,''), updated_at=now() WHERE id=%s""",
            (body.email, body.username, body.full_name.strip(), body.department,
             body.job_title, body.phone, user_id),
        )
        conn.execute(
            "UPDATE safety.organization_members SET role_id=%s WHERE organization_id=%s AND user_id=%s",
            (body.role_id, organization_id, user_id),
        )
        _set_site_access(conn, user_id, body.site_ids, actor_id)
        if target["role_id"] != body.role_id:
            conn.execute(
                "UPDATE safety.auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=%s",
                (user_id,),
            )
        _audit(conn, organization_id, actor_id, "user.update", user_id,
               {"email": body.email, "role": role["code"],
                "site_ids": [str(item) for item in body.site_ids]})


def change_status(user_id: UUID, status: str, user: dict[str, Any]) -> None:
    organization_id, _ = _organization(user)
    actor_id = user["id"]
    if user_id == actor_id and status != "active":
        raise UserConflictError("Bạn không thể tự khóa hoặc vô hiệu hóa tài khoản của mình")
    with connection() as conn:
        target = _find_user(conn, user_id, organization_id)
        if not target:
            raise UserNotFoundError("Không tìm thấy người dùng")
        _protect_last_admin(conn, user_id, organization_id, status != "active")
        conn.execute(
            """UPDATE safety.users SET status=%s::safety.user_status,
               failed_login_count=CASE WHEN %s='active' THEN 0 ELSE failed_login_count END,
               locked_until=NULL, updated_at=now() WHERE id=%s""",
            (status, status, user_id),
        )
        if status != "active":
            conn.execute(
                "UPDATE safety.auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=%s",
                (user_id,),
            )
        _audit(conn, organization_id, actor_id, "user.status", user_id, {"status": status})


def reset_password(user_id: UUID, password: str, user: dict[str, Any]) -> None:
    organization_id, _ = _organization(user)
    actor_id = user["id"]
    if len(password) < 8:
        raise UserConflictError("Mật khẩu tạm phải có ít nhất 8 ký tự")
    with connection() as conn:
        if not _find_user(conn, user_id, organization_id):
            raise UserNotFoundError("Không tìm thấy người dùng")
        conn.execute(
            """UPDATE safety.user_credentials
               SET password_hash=crypt(%s,gen_salt('bf',12)), password_changed_at=now(),
                   must_change_password=true WHERE user_id=%s""", (password, user_id),
        )
        conn.execute(
            "UPDATE safety.auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=%s",
            (user_id,),
        )
        conn.execute(
            "UPDATE safety.users SET failed_login_count=0, locked_until=NULL, updated_at=now() WHERE id=%s",
            (user_id,),
        )
        _audit(conn, organization_id, actor_id, "user.password_reset", user_id,
               {"sessions_revoked": True, "must_change_password": True})
