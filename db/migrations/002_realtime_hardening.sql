BEGIN;

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

CREATE INDEX IF NOT EXISTS realtime_sessions_retention_idx
  ON realtime_sessions(disconnected_at)
  WHERE disconnected_at IS NOT NULL;

INSERT INTO schema_migrations (version)
VALUES ('002_realtime_hardening')
ON CONFLICT DO NOTHING;

COMMIT;
