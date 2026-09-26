BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS safety;
SET LOCAL search_path TO safety, public;

INSERT INTO permissions (code, name, description) VALUES
  ('chat.use', 'Su dung tro ly AI', 'Hoi dap du lieu van hanh trong pham vi duoc phan quyen'),
  ('chat.manage', 'Quan ly tro ly AI', 'Quan ly cau hinh va lich su chatbot')
ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='super_admin' AND p.code IN ('chat.use','chat.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='org_admin' AND p.code IN ('chat.use','chat.manage')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS chat_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title varchar(200) NOT NULL DEFAULT 'Cuoc tro chuyen moi',
  status varchar(20) NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_conversations_status_ck CHECK (status IN ('open','archived'))
);
CREATE INDEX IF NOT EXISTS chat_conversations_user_time_idx
  ON chat_conversations(user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS chat_conversations_org_time_idx
  ON chat_conversations(organization_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role varchar(20) NOT NULL,
  content text NOT NULL,
  model_name varchar(100),
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_role_ck CHECK (role IN ('user','assistant','system','tool')),
  CONSTRAINT chat_messages_content_ck CHECK (btrim(content) <> ''),
  CONSTRAINT chat_messages_tokens_ck CHECK (
    (input_tokens IS NULL OR input_tokens >= 0) AND
    (output_tokens IS NULL OR output_tokens >= 0) AND
    (latency_ms IS NULL OR latency_ms >= 0)
  )
);
CREATE INDEX IF NOT EXISTS chat_messages_conversation_time_idx
  ON chat_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS chat_tool_calls (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  request_message_id uuid REFERENCES chat_messages(id) ON DELETE SET NULL,
  tool_name varchar(100) NOT NULL,
  arguments jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(20) NOT NULL DEFAULT 'completed',
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_tool_calls_status_ck CHECK (status IN ('completed','failed','denied')),
  CONSTRAINT chat_tool_calls_duration_ck CHECK (duration_ms IS NULL OR duration_ms >= 0)
);
CREATE INDEX IF NOT EXISTS chat_tool_calls_conversation_idx
  ON chat_tool_calls(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_feedback (
  message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating smallint NOT NULL,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id),
  CONSTRAINT chat_feedback_rating_ck CHECK (rating IN (-1,1))
);

COMMIT;
