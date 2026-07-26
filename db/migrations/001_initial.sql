BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS profiles (
  clerk_user_id text PRIMARY KEY,
  username citext NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT profiles_username_format CHECK (username::text ~ '^[A-Za-z0-9_]{3,20}$')
);

CREATE TABLE IF NOT EXISTS player_records (
  clerk_user_id text PRIMARY KEY REFERENCES profiles(clerk_user_id) ON DELETE CASCADE,
  wins integer NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses integer NOT NULL DEFAULT 0 CHECK (losses >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS problem_registry (
  problem_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  difficulty text NOT NULL CHECK (difficulty IN ('EASY', 'MEDIUM', 'HARD')),
  active boolean NOT NULL DEFAULT true,
  public_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (problem_id, version)
);

CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_token_hash text NOT NULL UNIQUE CHECK (length(invite_token_hash) = 64),
  host_user_id text NOT NULL REFERENCES profiles(clerk_user_id),
  difficulty text NOT NULL CHECK (difficulty IN ('EASY', 'MEDIUM', 'HARD')),
  active_match_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL REFERENCES profiles(clerk_user_id),
  slot smallint NOT NULL CHECK (slot IN (1, 2)),
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (room_id, clerk_user_id),
  UNIQUE (room_id, slot)
);

CREATE TABLE IF NOT EXISTS matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  round_number integer NOT NULL CHECK (round_number > 0),
  previous_match_id uuid REFERENCES matches(id),
  state text NOT NULL DEFAULT 'LOBBY' CHECK (state IN ('LOBBY', 'COUNTDOWN', 'ACTIVE', 'FINISHED', 'REMATCH_PENDING')),
  difficulty text NOT NULL CHECK (difficulty IN ('EASY', 'MEDIUM', 'HARD')),
  problem_id text,
  problem_version integer,
  problem_title text,
  starts_at timestamptz,
  finished_at timestamptz,
  rematch_deadline timestamptz,
  rematch_created_match_id uuid REFERENCES matches(id),
  winner_user_id text REFERENCES profiles(clerk_user_id),
  end_reason text CHECK (end_reason IN ('ACCEPTED', 'FORFEIT', 'CANCELLED', 'NO_CONTEST')),
  records_applied boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (room_id, round_number),
  CONSTRAINT matches_problem_complete CHECK (
    (problem_id IS NULL AND problem_version IS NULL AND problem_title IS NULL)
    OR (problem_id IS NOT NULL AND problem_version IS NOT NULL AND problem_title IS NOT NULL)
  ),
  CONSTRAINT matches_timing_consistent CHECK (
    (state = 'LOBBY' AND starts_at IS NULL)
    OR (state <> 'LOBBY' AND (starts_at IS NOT NULL OR end_reason = 'CANCELLED'))
  ),
  CONSTRAINT matches_finish_consistent CHECK (
    (finished_at IS NULL AND winner_user_id IS NULL AND end_reason IS NULL)
    OR (finished_at IS NOT NULL AND end_reason IS NOT NULL)
  )
);

ALTER TABLE rooms
  ADD CONSTRAINT rooms_active_match_fk
  FOREIGN KEY (active_match_id) REFERENCES matches(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS match_participants (
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL REFERENCES profiles(clerk_user_id),
  slot smallint NOT NULL CHECK (slot IN (1, 2)),
  language text CHECK (language IN ('PYTHON', 'JAVA')),
  ready_at timestamptz,
  activity text NOT NULL DEFAULT 'THINKING' CHECK (activity IN ('THINKING', 'COMPILING', 'JUDGING', 'COOLDOWN', 'ACCEPTED', 'DISCONNECTED')),
  best_passed_count integer NOT NULL DEFAULT 0 CHECK (best_passed_count >= 0),
  hidden_test_count integer CHECK (hidden_test_count IS NULL OR hidden_test_count >= 0),
  cooldown_until timestamptz,
  last_sample_run_at timestamptz,
  active_execution_id uuid,
  connected boolean NOT NULL DEFAULT false,
  disconnected_at timestamptz,
  reconnect_deadline timestamptz,
  outcome text CHECK (outcome IN ('WIN', 'LOSS', 'DRAW', 'NO_CONTEST', 'CANCELLED')),
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (match_id, clerk_user_id),
  UNIQUE (match_id, slot),
  CONSTRAINT participant_ready_requires_language CHECK (ready_at IS NULL OR language IS NOT NULL)
);

CREATE SEQUENCE IF NOT EXISTS execution_server_sequence AS bigint;

CREATE TABLE IF NOT EXISTS executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL REFERENCES profiles(clerk_user_id),
  idempotency_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('RUN', 'SUBMIT')),
  language text NOT NULL CHECK (language IN ('PYTHON', 'JAVA')),
  source_hash text NOT NULL CHECK (length(source_hash) = 64),
  source_bytes integer NOT NULL CHECK (source_bytes >= 0),
  server_sequence bigint NOT NULL DEFAULT nextval('execution_server_sequence'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED')),
  verdict text CHECK (verdict IN ('ACCEPTED', 'WRONG_ANSWER', 'COMPILE_ERROR', 'RUNTIME_ERROR', 'TIMEOUT', 'MEMORY_LIMIT', 'OUTPUT_LIMIT', 'INFRA_ERROR')),
  passed_count integer CHECK (passed_count IS NULL OR passed_count >= 0),
  total_count integer CHECK (total_count IS NULL OR total_count >= 0),
  runtime_ms numeric(12,3) CHECK (runtime_ms IS NULL OR runtime_ms >= 0),
  compile_ms numeric(12,3) CHECK (compile_ms IS NULL OR compile_ms >= 0),
  infrastructure_attempts smallint NOT NULL DEFAULT 0 CHECK (infrastructure_attempts BETWEEN 0 AND 2),
  result_summary jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (match_id, clerk_user_id, idempotency_key),
  UNIQUE (server_sequence),
  CONSTRAINT execution_completion_consistent CHECK (
    (status <> 'COMPLETED' AND verdict IS NULL AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND verdict IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT execution_counts_consistent CHECK (
    passed_count IS NULL OR total_count IS NULL OR passed_count <= total_count
  )
);

ALTER TABLE match_participants
  ADD CONSTRAINT match_participants_active_execution_fk
  FOREIGN KEY (active_execution_id) REFERENCES executions(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS executions_winner_order_idx
  ON executions(match_id, received_at, runtime_ms, server_sequence)
  WHERE kind = 'SUBMIT';

CREATE INDEX IF NOT EXISTS executions_inflight_idx
  ON executions(match_id, received_at)
  WHERE kind = 'SUBMIT' AND status IN ('QUEUED', 'RUNNING');

CREATE TABLE IF NOT EXISTS command_receipts (
  actor_user_id text NOT NULL REFERENCES profiles(clerk_user_id),
  idempotency_key text NOT NULL,
  command_type text NOT NULL,
  match_id uuid REFERENCES matches(id) ON DELETE CASCADE,
  payload_hash text NOT NULL CHECK (length(payload_hash) = 64),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (actor_user_id, idempotency_key),
  CONSTRAINT command_receipt_completion CHECK (
    (response IS NULL AND completed_at IS NULL)
    OR (response IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS match_events (
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  server_timestamp timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (match_id, version)
);

CREATE INDEX IF NOT EXISTS match_events_timestamp_idx
  ON match_events(match_id, server_timestamp);

CREATE TABLE IF NOT EXISTS rematch_votes (
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL REFERENCES profiles(clerk_user_id),
  idempotency_key text NOT NULL,
  voted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (match_id, clerk_user_id),
  UNIQUE (clerk_user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS realtime_ticket_uses (
  jti uuid PRIMARY KEY,
  clerk_user_id text NOT NULL REFERENCES profiles(clerk_user_id),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS realtime_ticket_issues (
  jti uuid PRIMARY KEY,
  clerk_user_id text NOT NULL REFERENCES profiles(clerk_user_id),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS realtime_ticket_issues_user_room_idx
  ON realtime_ticket_issues(clerk_user_id, room_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS realtime_ticket_issues_user_time_idx
  ON realtime_ticket_issues(clerk_user_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS realtime_ticket_issues_expiration_idx
  ON realtime_ticket_issues(expires_at);

CREATE TABLE IF NOT EXISTS realtime_sessions (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL REFERENCES profiles(clerk_user_id),
  connected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disconnected_at timestamptz,
  UNIQUE (id, clerk_user_id)
);

CREATE INDEX IF NOT EXISTS realtime_sessions_active_idx
  ON realtime_sessions(match_id, clerk_user_id, last_seen_at)
  WHERE disconnected_at IS NULL;

CREATE INDEX IF NOT EXISTS realtime_sessions_retention_idx
  ON realtime_sessions(disconnected_at)
  WHERE disconnected_at IS NOT NULL;

INSERT INTO schema_migrations (version)
VALUES ('001_initial')
ON CONFLICT DO NOTHING;

COMMIT;
