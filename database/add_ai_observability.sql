BEGIN;
CREATE TABLE IF NOT EXISTS safety.ai_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES safety.organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES safety.users(id) ON DELETE SET NULL,
  service varchar(10) NOT NULL CHECK (service IN ('llm','tts','rag')),
  model varchar(200) NOT NULL,
  provider_request_id varchar(200),
  status varchar(20) NOT NULL CHECK (status IN ('completed','failed')),
  latency_ms double precision NOT NULL CHECK (latency_ms >= 0),
  first_byte_ms double precision CHECK (first_byte_ms >= 0),
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  cached_tokens bigint CHECK (cached_tokens >= 0),
  reasoning_tokens bigint CHECK (reasoning_tokens >= 0),
  cost_usd numeric(20,12) CHECK (cost_usd >= 0),
  input_characters integer CHECK (input_characters >= 0),
  audio_seconds double precision CHECK (audio_seconds >= 0),
  error_code integer,
  result_count integer CHECK (result_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE safety.ai_usage_events ADD COLUMN IF NOT EXISTS result_count integer CHECK (result_count >= 0);
ALTER TABLE safety.ai_usage_events DROP CONSTRAINT IF EXISTS ai_usage_events_service_check;
ALTER TABLE safety.ai_usage_events ADD CONSTRAINT ai_usage_events_service_check CHECK (service IN ('llm','tts','rag'));
CREATE INDEX IF NOT EXISTS ai_usage_events_org_time_idx ON safety.ai_usage_events(organization_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_events_generation_idx ON safety.ai_usage_events(provider_request_id) WHERE provider_request_id IS NOT NULL;
COMMIT;
