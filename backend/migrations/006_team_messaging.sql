BEGIN;

INSERT INTO safety.permissions (code, name, description)
VALUES ('messaging.use', 'Tin nhắn & yêu cầu', 'Trao đổi và xử lý yêu cầu nội bộ trong cùng tổ chức')
ON CONFLICT (code) DO NOTHING;

INSERT INTO safety.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM safety.roles r CROSS JOIN safety.permissions p
WHERE r.code IN ('super_admin', 'org_admin', 'safety_manager', 'operator', 'camera_employee')
  AND p.code = 'messaging.use'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS safety.team_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES safety.organizations(id),
  participant_a uuid NOT NULL REFERENCES safety.users(id),
  participant_b uuid NOT NULL REFERENCES safety.users(id),
  read_a bigint NOT NULL DEFAULT 0,
  read_b bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, participant_a, participant_b),
  CHECK (participant_a < participant_b)
);
CREATE INDEX IF NOT EXISTS team_conversations_a_idx ON safety.team_conversations(participant_a, updated_at DESC);
CREATE INDEX IF NOT EXISTS team_conversations_b_idx ON safety.team_conversations(participant_b, updated_at DESC);

CREATE TABLE IF NOT EXISTS safety.team_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no bigserial UNIQUE,
  conversation_id uuid NOT NULL REFERENCES safety.team_conversations(id),
  sender_id uuid NOT NULL REFERENCES safety.users(id),
  recipient_id uuid NOT NULL REFERENCES safety.users(id),
  title varchar(160) NOT NULL CHECK (btrim(title) <> ''),
  description text NOT NULL CHECK (btrim(description) <> ''),
  category varchar(30) NOT NULL CHECK (category IN ('support', 'incident', 'equipment', 'shift', 'other')),
  priority varchar(15) NOT NULL CHECK (priority IN ('normal', 'high', 'urgent')),
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'rejected', 'cancelled')),
  due_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS team_requests_conversation_idx ON safety.team_requests(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS safety.team_messages (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES safety.team_conversations(id),
  sender_id uuid NOT NULL REFERENCES safety.users(id),
  client_id uuid NOT NULL,
  kind varchar(15) NOT NULL CHECK (kind IN ('text', 'request', 'activity')),
  content text NOT NULL CHECK (btrim(content) <> ''),
  request_id uuid REFERENCES safety.team_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, sender_id, client_id)
);
CREATE INDEX IF NOT EXISTS team_messages_conversation_idx ON safety.team_messages(conversation_id, id DESC);

COMMIT;
