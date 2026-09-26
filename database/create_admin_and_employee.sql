-- Run this entire file in pgAdmin 4 while connected to safety_db.
-- Safe to run again: accounts, roles and memberships are updated, not duplicated.
--
-- Accounts:
--   Admin:    admin@factory-ai.org     / Admin@123456
--   Employee: employee@factory-ai.org / Employee@123456
--
-- IMPORTANT: Change both passwords after the first successful login.

BEGIN;

SET LOCAL search_path TO safety, public;

INSERT INTO organizations (code, name, timezone, is_active)
VALUES ('FACTORY_AI', 'Factory AI Safety', 'Asia/Ho_Chi_Minh', true)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    timezone = EXCLUDED.timezone,
    is_active = true,
    updated_at = now();

-- Employee role has exactly one permission: camera.view.
INSERT INTO roles (code, name, description, is_system)
VALUES (
    'camera_employee',
    'Nhân viên camera',
    'Chỉ được xem camera giám sát',
    true
)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    updated_at = now();

DELETE FROM role_permissions
WHERE role_id = (SELECT id FROM roles WHERE code = 'camera_employee');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'camera.view'
WHERE r.code = 'camera_employee'
ON CONFLICT DO NOTHING;

DO $accounts$
DECLARE
    v_admin_id uuid;
    v_employee_id uuid;
    v_org_id uuid;
    v_admin_role_id uuid;
    v_employee_role_id uuid;
BEGIN
    SELECT id INTO v_org_id
    FROM organizations
    WHERE code = 'FACTORY_AI';

    SELECT id INTO v_admin_role_id
    FROM roles
    WHERE code = 'org_admin';

    SELECT id INTO v_employee_role_id
    FROM roles
    WHERE code = 'camera_employee';

    IF v_admin_role_id IS NULL THEN
        RAISE EXCEPTION 'Role org_admin is missing. Run ai_safety_monitoring.sql first.';
    END IF;

    -- Administrator
    SELECT id INTO v_admin_id
    FROM users
    WHERE lower(email) = 'admin@factory-ai.org'
      AND deleted_at IS NULL;

    IF v_admin_id IS NULL THEN
        v_admin_id := register_user(
            'admin@factory-ai.org',
            'Admin@123456',
            'Quản trị viên hệ thống',
            NULL,
            'Ban quản trị',
            'Administrator'
        );
    END IF;

    UPDATE users
    SET full_name = 'Quản trị viên hệ thống',
        department = 'Ban quản trị',
        job_title = 'Administrator',
        status = 'active',
        email_verified_at = COALESCE(email_verified_at, now()),
        failed_login_count = 0,
        locked_until = NULL,
        updated_at = now()
    WHERE id = v_admin_id;

    INSERT INTO user_credentials (user_id, password_hash, must_change_password)
    VALUES (v_admin_id, crypt('Admin@123456', gen_salt('bf', 12)), true)
    ON CONFLICT (user_id) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        password_changed_at = now(),
        must_change_password = true;

    -- Camera employee
    SELECT id INTO v_employee_id
    FROM users
    WHERE lower(email) = 'employee@factory-ai.org'
      AND deleted_at IS NULL;

    IF v_employee_id IS NULL THEN
        v_employee_id := register_user(
            'employee@factory-ai.org',
            'Employee@123456',
            'Nhân viên giám sát camera',
            NULL,
            'An toàn nhà máy',
            'Camera Operator'
        );
    END IF;

    UPDATE users
    SET full_name = 'Nhân viên giám sát camera',
        department = 'An toàn nhà máy',
        job_title = 'Camera Operator',
        status = 'active',
        email_verified_at = COALESCE(email_verified_at, now()),
        failed_login_count = 0,
        locked_until = NULL,
        updated_at = now()
    WHERE id = v_employee_id;

    INSERT INTO user_credentials (user_id, password_hash, must_change_password)
    VALUES (v_employee_id, crypt('Employee@123456', gen_salt('bf', 12)), true)
    ON CONFLICT (user_id) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        password_changed_at = now(),
        must_change_password = true;

    -- A user has only one default organization.
    UPDATE organization_members
    SET is_default = false
    WHERE user_id IN (v_admin_id, v_employee_id);

    INSERT INTO organization_members (
        organization_id,
        user_id,
        role_id,
        is_default
    )
    VALUES
        (v_org_id, v_admin_id, v_admin_role_id, true),
        (v_org_id, v_employee_id, v_employee_role_id, true)
    ON CONFLICT (organization_id, user_id) DO UPDATE
    SET role_id = EXCLUDED.role_id,
        is_default = EXCLUDED.is_default;

    -- Force old sessions to log in again so new roles apply immediately.
    UPDATE auth_sessions
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE user_id IN (v_admin_id, v_employee_id);
END;
$accounts$;

COMMIT;

-- Verification:
-- admin has dashboard.view and camera.view among other permissions;
-- employee has camera.view only.
SELECT
    u.email,
    u.full_name,
    u.status,
    r.code AS role_code,
    r.name AS role_name,
    array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL) AS permissions
FROM safety.users u
JOIN safety.organization_members om ON om.user_id = u.id
JOIN safety.organizations o ON o.id = om.organization_id
JOIN safety.roles r ON r.id = om.role_id
LEFT JOIN safety.role_permissions rp ON rp.role_id = r.id
LEFT JOIN safety.permissions p ON p.id = rp.permission_id
WHERE o.code = 'FACTORY_AI'
  AND lower(u.email) IN (
      'admin@factory-ai.org',
      'employee@factory-ai.org'
  )
GROUP BY u.email, u.full_name, u.status, r.code, r.name
ORDER BY u.email;
