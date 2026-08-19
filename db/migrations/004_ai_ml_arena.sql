BEGIN;

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS challenge_type text NOT NULL DEFAULT 'CODING';

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS challenge_type text NOT NULL DEFAULT 'CODING',
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'DUEL',
  ADD COLUMN IF NOT EXISTS answer_deadline_at timestamptz;

UPDATE matches match
SET challenge_type = room.challenge_type
FROM rooms room
WHERE room.id = match.room_id
  AND match.challenge_type IS DISTINCT FROM room.challenge_type;

UPDATE matches match
SET mode = room.mode
FROM rooms room
WHERE room.id = match.room_id
  AND match.mode IS DISTINCT FROM room.mode;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rooms_challenge_type_valid'
      AND conrelid = 'rooms'::regclass
  ) THEN
    ALTER TABLE rooms
      ADD CONSTRAINT rooms_challenge_type_valid
      CHECK (challenge_type IN ('CODING', 'AI_ML'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'matches_challenge_type_valid'
      AND conrelid = 'matches'::regclass
  ) THEN
    ALTER TABLE matches
      ADD CONSTRAINT matches_challenge_type_valid
      CHECK (challenge_type IN ('CODING', 'AI_ML'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'matches_mode_valid'
      AND conrelid = 'matches'::regclass
  ) THEN
    ALTER TABLE matches
      ADD CONSTRAINT matches_mode_valid
      CHECK (mode IN ('DUEL', 'PRACTICE'));
  END IF;
END
$$;

ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_state_check;
ALTER TABLE matches
  ADD CONSTRAINT matches_state_check
  CHECK (state IN ('LOBBY', 'COUNTDOWN', 'ACTIVE', 'JUDGING', 'FINISHED', 'REMATCH_PENDING'));

ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_end_reason_check;
ALTER TABLE matches
  ADD CONSTRAINT matches_end_reason_check
  CHECK (end_reason IN (
    'ACCEPTED', 'FORFEIT', 'CANCELLED', 'NO_CONTEST',
    'JUDGED', 'ANSWER_TIMEOUT', 'JUDGE_FAILED'
  ));

ALTER TABLE matches
  ADD CONSTRAINT matches_ai_ml_deadline_consistent
  CHECK (
    (challenge_type = 'CODING' AND answer_deadline_at IS NULL)
    OR (
      challenge_type = 'AI_ML'
      AND (
        (state = 'LOBBY' AND answer_deadline_at IS NULL)
        OR (state <> 'LOBBY' AND (answer_deadline_at IS NOT NULL OR end_reason = 'CANCELLED'))
      )
    )
  );

ALTER TABLE match_participants
  DROP CONSTRAINT IF EXISTS participant_ready_requires_language;

CREATE TABLE IF NOT EXISTS ai_ml_question_registry (
  question_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  prompt text NOT NULL,
  difficulty text NOT NULL CHECK (difficulty IN ('EASY', 'MEDIUM', 'HARD')),
  category text NOT NULL,
  tags jsonb NOT NULL,
  answer_constraints jsonb NOT NULL,
  private_material jsonb NOT NULL,
  rubric_hash text NOT NULL CHECK (length(rubric_hash) = 64),
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (question_id, version),
  CONSTRAINT ai_ml_question_archive_consistent CHECK (
    (active AND archived_at IS NULL) OR (NOT active)
  )
);

CREATE INDEX IF NOT EXISTS ai_ml_question_active_difficulty_idx
  ON ai_ml_question_registry(difficulty, question_id, version)
  WHERE active;

CREATE TABLE IF NOT EXISTS ai_ml_judge_prompts (
  version integer PRIMARY KEY CHECK (version > 0),
  duel_instructions text NOT NULL,
  practice_instructions text NOT NULL,
  schema_version text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS ai_ml_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL REFERENCES profiles(clerk_user_id),
  normalized_answer text NOT NULL,
  word_count integer NOT NULL CHECK (word_count BETWEEN 0 AND 500),
  character_count integer NOT NULL CHECK (character_count BETWEEN 0 AND 12000),
  utf8_byte_count integer NOT NULL CHECK (utf8_byte_count BETWEEN 0 AND 24000),
  submission_state text NOT NULL DEFAULT 'FINAL' CHECK (submission_state = 'FINAL'),
  submission_source text NOT NULL DEFAULT 'PLAYER'
    CHECK (submission_source IN ('PLAYER', 'DEADLINE')),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (match_id, clerk_user_id),
  FOREIGN KEY (match_id, clerk_user_id)
    REFERENCES match_participants(match_id, clerk_user_id) ON DELETE CASCADE,
  CONSTRAINT ai_ml_answer_counts_consistent CHECK (
    (normalized_answer = '' AND word_count = 0)
    OR (normalized_answer <> '' AND word_count > 0)
  )
);

CREATE TABLE IF NOT EXISTS ai_ml_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED')),
  immutable_snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL CHECK (length(snapshot_hash) = 64),
  answer_a_user_id text REFERENCES profiles(clerk_user_id),
  answer_b_user_id text REFERENCES profiles(clerk_user_id),
  question_id text NOT NULL,
  question_version integer NOT NULL CHECK (question_version > 0),
  rubric_hash text NOT NULL CHECK (length(rubric_hash) = 64),
  prompt_version integer NOT NULL CHECK (prompt_version > 0),
  schema_version text NOT NULL,
  requested_model text NOT NULL,
  returned_model text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  worker_claim_id uuid,
  claimed_at timestamptz,
  retry_not_before timestamptz,
  criterion_scores jsonb,
  raw_score_a integer CHECK (raw_score_a BETWEEN 0 AND 100),
  raw_score_b integer CHECK (raw_score_b BETWEEN 0 AND 100),
  official_score_a integer CHECK (official_score_a BETWEEN 0 AND 100),
  official_score_b integer CHECK (official_score_b BETWEEN 0 AND 100),
  winner_user_id text REFERENCES profiles(clerk_user_id),
  tie_break_reason text CHECK (tie_break_reason IN (
    'none', 'blank_forfeit', 'correctness',
    'completeness_or_specificity', 'clarity', 'exact_equivalence'
  )),
  explanation text,
  provider_response_id text,
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cached_tokens integer CHECK (cached_tokens IS NULL OR cached_tokens >= 0),
  reasoning_tokens integer CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  completion_classification text,
  failure_code text,
  failure_metadata jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (question_id, question_version)
    REFERENCES ai_ml_question_registry(question_id, version),
  CONSTRAINT ai_ml_evaluation_mapping_distinct CHECK (
    answer_a_user_id IS NULL OR answer_b_user_id IS NULL OR answer_a_user_id <> answer_b_user_id
  ),
  CONSTRAINT ai_ml_evaluation_mode_consistent CHECK (
    (
      immutable_snapshot->>'mode' = 'DUEL'
      AND answer_a_user_id IS NOT NULL
      AND answer_b_user_id IS NOT NULL
      AND (immutable_snapshot->'answers') ? 'B'
    )
    OR (
      immutable_snapshot->>'mode' = 'PRACTICE'
      AND answer_a_user_id IS NOT NULL
      AND answer_b_user_id IS NULL
      AND NOT ((immutable_snapshot->'answers') ? 'B')
    )
  ),
  CONSTRAINT ai_ml_evaluation_completion_consistent CHECK (
    (
      status = 'COMPLETED'
      AND completed_at IS NOT NULL
      AND criterion_scores IS NOT NULL
      AND returned_model IS NOT NULL
      AND raw_score_a IS NOT NULL
      AND official_score_a IS NOT NULL
      AND tie_break_reason IS NOT NULL
      AND explanation IS NOT NULL AND length(explanation) > 0
      AND (
        (
          immutable_snapshot->>'mode' = 'DUEL'
          AND raw_score_b IS NOT NULL
          AND official_score_b IS NOT NULL
          AND winner_user_id IS NOT NULL
          AND winner_user_id IN (answer_a_user_id, answer_b_user_id)
          AND (
            (winner_user_id = answer_a_user_id AND official_score_a > official_score_b)
            OR (winner_user_id = answer_b_user_id AND official_score_b > official_score_a)
          )
        )
        OR (
          immutable_snapshot->>'mode' = 'PRACTICE'
          AND raw_score_b IS NULL
          AND official_score_b IS NULL
          AND winner_user_id IS NULL
          AND tie_break_reason = 'none'
          AND official_score_a = raw_score_a
        )
      )
    )
    OR (
      status = 'SKIPPED'
      AND completed_at IS NOT NULL
      AND raw_score_a = 0
      AND official_score_a = 0
      AND winner_user_id IS NULL
      AND tie_break_reason = 'none'
      AND explanation IS NOT NULL AND length(explanation) > 0
      AND (
        (
          immutable_snapshot->>'mode' = 'DUEL'
          AND raw_score_b = 0 AND official_score_b = 0
        )
        OR (
          immutable_snapshot->>'mode' = 'PRACTICE'
          AND raw_score_b IS NULL AND official_score_b IS NULL
        )
      )
    )
    OR (
      status IN ('PENDING', 'IN_PROGRESS', 'FAILED')
      AND completed_at IS NULL
      AND criterion_scores IS NULL
      AND raw_score_a IS NULL AND raw_score_b IS NULL
      AND official_score_a IS NULL AND official_score_b IS NULL
      AND winner_user_id IS NULL AND tie_break_reason IS NULL
      AND explanation IS NULL
    )
  ),
  CONSTRAINT ai_ml_evaluation_blank_consistent CHECK (
    status IN ('PENDING', 'IN_PROGRESS', 'FAILED')
    OR (
      status = 'SKIPPED'
      AND (
        (
          immutable_snapshot->>'mode' = 'PRACTICE'
          AND immutable_snapshot#>>'{answers,A}' = ''
        )
        OR (
          immutable_snapshot->>'mode' = 'DUEL'
          AND immutable_snapshot#>>'{answers,A}' = ''
          AND immutable_snapshot#>>'{answers,B}' = ''
        )
      )
    )
    OR (
      status = 'COMPLETED'
      AND (
        (
          immutable_snapshot->>'mode' = 'PRACTICE'
          AND immutable_snapshot#>>'{answers,A}' <> ''
        )
        OR (
          immutable_snapshot->>'mode' = 'DUEL'
          AND NOT (
            immutable_snapshot#>>'{answers,A}' = ''
            AND immutable_snapshot#>>'{answers,B}' = ''
          )
          AND (
            (
              (immutable_snapshot#>>'{answers,A}' = '') <> (immutable_snapshot#>>'{answers,B}' = '')
              AND tie_break_reason = 'blank_forfeit'
              AND (
                (immutable_snapshot#>>'{answers,A}' = '' AND raw_score_a = 0 AND official_score_a = 0)
                OR (immutable_snapshot#>>'{answers,B}' = '' AND raw_score_b = 0 AND official_score_b = 0)
              )
            )
            OR (
              immutable_snapshot#>>'{answers,A}' <> ''
              AND immutable_snapshot#>>'{answers,B}' <> ''
              AND tie_break_reason <> 'blank_forfeit'
            )
          )
        )
      )
    )
  ),
  CONSTRAINT ai_ml_evaluation_claim_consistent CHECK (
    (status = 'IN_PROGRESS' AND worker_claim_id IS NOT NULL AND claimed_at IS NOT NULL)
    OR status <> 'IN_PROGRESS'
  )
);

CREATE INDEX IF NOT EXISTS ai_ml_evaluation_recovery_idx
  ON ai_ml_evaluations(status, retry_not_before, created_at)
  WHERE status IN ('PENDING', 'FAILED', 'IN_PROGRESS');

CREATE OR REPLACE FUNCTION prevent_ai_ml_answer_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Final AI/ML answers are immutable';
END
$$;

DROP TRIGGER IF EXISTS ai_ml_answer_immutable ON ai_ml_answers;
CREATE TRIGGER ai_ml_answer_immutable
BEFORE UPDATE ON ai_ml_answers
FOR EACH ROW EXECUTE FUNCTION prevent_ai_ml_answer_mutation();

CREATE INDEX IF NOT EXISTS matches_ai_ml_deadline_idx
  ON matches(answer_deadline_at, id)
  WHERE challenge_type = 'AI_ML' AND state = 'ACTIVE';

CREATE OR REPLACE FUNCTION prevent_ai_ml_evaluation_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.immutable_snapshot IS DISTINCT FROM OLD.immutable_snapshot
    OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
    OR NEW.answer_a_user_id IS DISTINCT FROM OLD.answer_a_user_id
    OR NEW.answer_b_user_id IS DISTINCT FROM OLD.answer_b_user_id
    OR NEW.question_id IS DISTINCT FROM OLD.question_id
    OR NEW.question_version IS DISTINCT FROM OLD.question_version
    OR NEW.rubric_hash IS DISTINCT FROM OLD.rubric_hash
    OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version
    OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
    OR NEW.requested_model IS DISTINCT FROM OLD.requested_model
  THEN
    RAISE EXCEPTION 'AI/ML evaluation snapshots and mappings are immutable';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ai_ml_evaluation_snapshot_immutable ON ai_ml_evaluations;
CREATE TRIGGER ai_ml_evaluation_snapshot_immutable
BEFORE UPDATE ON ai_ml_evaluations
FOR EACH ROW EXECUTE FUNCTION prevent_ai_ml_evaluation_snapshot_mutation();

CREATE OR REPLACE FUNCTION prevent_referenced_ai_ml_material_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.title IS DISTINCT FROM OLD.title
    OR NEW.prompt IS DISTINCT FROM OLD.prompt
    OR NEW.difficulty IS DISTINCT FROM OLD.difficulty
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.tags IS DISTINCT FROM OLD.tags
    OR NEW.answer_constraints IS DISTINCT FROM OLD.answer_constraints
    OR NEW.private_material IS DISTINCT FROM OLD.private_material
    OR NEW.rubric_hash IS DISTINCT FROM OLD.rubric_hash
  ) AND EXISTS (
    SELECT 1 FROM matches
    WHERE problem_id = OLD.question_id AND problem_version = OLD.version
  ) THEN
    RAISE EXCEPTION 'Referenced AI/ML question versions are immutable';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ai_ml_question_version_immutable ON ai_ml_question_registry;
CREATE TRIGGER ai_ml_question_version_immutable
BEFORE UPDATE ON ai_ml_question_registry
FOR EACH ROW EXECUTE FUNCTION prevent_referenced_ai_ml_material_mutation();

CREATE OR REPLACE FUNCTION prevent_referenced_ai_ml_prompt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.duel_instructions IS DISTINCT FROM OLD.duel_instructions
    OR NEW.practice_instructions IS DISTINCT FROM OLD.practice_instructions
    OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
  ) AND EXISTS (
    SELECT 1 FROM ai_ml_evaluations WHERE prompt_version = OLD.version
  ) THEN
    RAISE EXCEPTION 'Referenced AI/ML judge prompt versions are immutable';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ai_ml_prompt_version_immutable ON ai_ml_judge_prompts;
CREATE TRIGGER ai_ml_prompt_version_immutable
BEFORE UPDATE ON ai_ml_judge_prompts
FOR EACH ROW EXECUTE FUNCTION prevent_referenced_ai_ml_prompt_mutation();

CREATE OR REPLACE FUNCTION prevent_match_challenge_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.challenge_type IS DISTINCT FROM OLD.challenge_type
    OR NEW.mode IS DISTINCT FROM OLD.mode
  THEN
    RAISE EXCEPTION 'Match challenge type and participation mode are immutable';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS match_challenge_type_immutable ON matches;
CREATE TRIGGER match_challenge_type_immutable
BEFORE UPDATE ON matches
FOR EACH ROW EXECUTE FUNCTION prevent_match_challenge_mutation();

INSERT INTO schema_migrations (version)
VALUES ('004_ai_ml_arena')
ON CONFLICT DO NOTHING;

COMMIT;
