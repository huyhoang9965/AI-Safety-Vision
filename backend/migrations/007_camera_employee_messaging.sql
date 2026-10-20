-- Correct existing installations where the dedicated camera employee role
-- was not included in the initial messaging permission grant.
BEGIN;

INSERT INTO safety.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM safety.roles r
CROSS JOIN safety.permissions p
WHERE r.code = 'camera_employee' AND p.code = 'messaging.use'
ON CONFLICT DO NOTHING;

COMMIT;
