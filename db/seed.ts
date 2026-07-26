import postgres from "postgres";

import { PUBLIC_PROBLEMS } from "../src/problems/public/catalog";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to seed problems");

const counts = { EASY: 0, MEDIUM: 0, HARD: 0 };
for (const problem of PUBLIC_PROBLEMS) counts[problem.difficulty] += 1;
if (
  PUBLIC_PROBLEMS.length !== 7 ||
  counts.EASY !== 2 ||
  counts.MEDIUM !== 3 ||
  counts.HARD !== 2
) {
  throw new Error(
    "The public problem catalog must contain exactly 2 Easy, 3 Medium, and 2 Hard problems",
  );
}

const sql = postgres(databaseUrl, { max: 1 });
try {
  await sql.begin(async (tx) => {
    await tx`UPDATE problem_registry SET active = false`;
    for (const problem of PUBLIC_PROBLEMS) {
      // This import tree is intentionally public-only. Hidden fixtures and
      // canonical solutions never cross into the application database.
      const metadata = JSON.parse(JSON.stringify(problem)) as Record<
        string,
        unknown
      >;
      await tx`
        INSERT INTO problem_registry
          (problem_id, version, title, difficulty, active, public_metadata)
        VALUES
          (${problem.id}, ${problem.version}, ${problem.title}, ${problem.difficulty}, true,
           ${tx.json(metadata as postgres.JSONValue)})
        ON CONFLICT (problem_id, version) DO UPDATE
        SET title = EXCLUDED.title,
            difficulty = EXCLUDED.difficulty,
            active = true,
            public_metadata = EXCLUDED.public_metadata
      `;
    }
  });
  console.info(`Seeded ${PUBLIC_PROBLEMS.length} public problem records`);
} finally {
  await sql.end();
}
