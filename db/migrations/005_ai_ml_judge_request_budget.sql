BEGIN;

ALTER TABLE ai_ml_evaluations
  ADD COLUMN IF NOT EXISTS provider_attempts jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE ai_ml_evaluations
SET provider_attempts = '[]'::jsonb
WHERE provider_attempts IS NULL;

ALTER TABLE ai_ml_evaluations
  ALTER COLUMN provider_attempts SET DEFAULT '[]'::jsonb,
  ALTER COLUMN provider_attempts SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_ml_evaluation_provider_attempts_array'
      AND conrelid = 'ai_ml_evaluations'::regclass
  ) THEN
    ALTER TABLE ai_ml_evaluations
      ADD CONSTRAINT ai_ml_evaluation_provider_attempts_array
      CHECK (jsonb_typeof(provider_attempts) = 'array');
  END IF;
END
$$;

-- Durable, append-only reservations for actual outbound judge attempts. This
-- intentionally has no evaluation foreign key: deleting match history must not
-- refund request capacity inside the rolling 24-hour window.
CREATE TABLE IF NOT EXISTS ai_ml_judge_request_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  adapter_attempt smallint NOT NULL CHECK (adapter_attempt BETWEEN 1 AND 3),
  requested_model text NOT NULL CHECK (length(requested_model) > 0),
  charged_user_ids text[] NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (claim_id, adapter_attempt),
  CONSTRAINT ai_ml_judge_request_charged_users_valid CHECK (
    cardinality(charged_user_ids) BETWEEN 1 AND 2
    AND array_position(charged_user_ids, NULL) IS NULL
    AND charged_user_ids[1] <> ''
    AND (
      cardinality(charged_user_ids) = 1
      OR (
        charged_user_ids[2] <> ''
        AND charged_user_ids[1] <> charged_user_ids[2]
      )
    )
  )
);

ALTER TABLE ai_ml_judge_request_reservations
  ADD COLUMN IF NOT EXISTS charged_user_ids text[];

UPDATE ai_ml_judge_request_reservations
SET charged_user_ids = ARRAY['legacy:' || evaluation_id::text]
WHERE charged_user_ids IS NULL;

ALTER TABLE ai_ml_judge_request_reservations
  ALTER COLUMN charged_user_ids SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_ml_judge_request_charged_users_valid'
      AND conrelid = 'ai_ml_judge_request_reservations'::regclass
  ) THEN
    ALTER TABLE ai_ml_judge_request_reservations
      ADD CONSTRAINT ai_ml_judge_request_charged_users_valid CHECK (
        cardinality(charged_user_ids) BETWEEN 1 AND 2
        AND array_position(charged_user_ids, NULL) IS NULL
        AND charged_user_ids[1] <> ''
        AND (
          cardinality(charged_user_ids) = 1
          OR (
            charged_user_ids[2] <> ''
            AND charged_user_ids[1] <> charged_user_ids[2]
          )
        )
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS ai_ml_judge_request_reservations_window_idx
  ON ai_ml_judge_request_reservations(reserved_at);

CREATE INDEX IF NOT EXISTS ai_ml_judge_request_reservations_evaluation_idx
  ON ai_ml_judge_request_reservations(evaluation_id, reserved_at);

INSERT INTO schema_migrations (version)
VALUES ('005_ai_ml_judge_request_budget')
ON CONFLICT DO NOTHING;

COMMIT;
