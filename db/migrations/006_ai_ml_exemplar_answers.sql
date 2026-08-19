BEGIN;

CREATE TABLE IF NOT EXISTS ai_ml_exemplar_answers (
  question_id text NOT NULL,
  question_version integer NOT NULL CHECK (question_version > 0),
  answer text NOT NULL,
  word_count integer NOT NULL CHECK (word_count = 500),
  character_count integer NOT NULL CHECK (character_count BETWEEN 1 AND 12000),
  utf8_byte_count integer NOT NULL CHECK (utf8_byte_count BETWEEN 1 AND 24000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (question_id, question_version),
  FOREIGN KEY (question_id, question_version)
    REFERENCES ai_ml_question_registry(question_id, version) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION prevent_referenced_ai_ml_exemplar_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1
      FROM matches
      WHERE problem_id = OLD.question_id
        AND problem_version = OLD.question_version
    ) THEN
      RAISE EXCEPTION 'Referenced AI/ML exemplar answers are immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF (
    NEW.answer IS DISTINCT FROM OLD.answer
    OR NEW.word_count IS DISTINCT FROM OLD.word_count
    OR NEW.character_count IS DISTINCT FROM OLD.character_count
    OR NEW.utf8_byte_count IS DISTINCT FROM OLD.utf8_byte_count
  ) AND EXISTS (
    SELECT 1
    FROM matches
    WHERE problem_id = OLD.question_id
      AND problem_version = OLD.question_version
  ) THEN
    RAISE EXCEPTION 'Referenced AI/ML exemplar answers are immutable';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ai_ml_exemplar_immutable ON ai_ml_exemplar_answers;
CREATE TRIGGER ai_ml_exemplar_immutable
BEFORE UPDATE OR DELETE ON ai_ml_exemplar_answers
FOR EACH ROW EXECUTE FUNCTION prevent_referenced_ai_ml_exemplar_mutation();

COMMIT;
