BEGIN;

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'DUEL';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'rooms_mode_valid'
      AND conrelid = 'rooms'::regclass
  ) THEN
    ALTER TABLE rooms
      ADD CONSTRAINT rooms_mode_valid CHECK (mode IN ('DUEL', 'PRACTICE'));
  END IF;
END
$$;

INSERT INTO schema_migrations (version)
VALUES ('003_practice_mode')
ON CONFLICT DO NOTHING;

COMMIT;
