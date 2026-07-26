import {
  PUBLIC_PROBLEMS,
  getPublicProblem as getInternalPublicProblem,
} from "./public/catalog";
import type { ProblemDifficulty } from "./types";

export interface ClientSafeProblem {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly difficulty: ProblemDifficulty;
  readonly description: string;
  readonly constraints: readonly string[];
  readonly samples: readonly {
    readonly id: string;
    readonly input: string;
    readonly output: string;
    readonly explanation?: string;
  }[];
  readonly functionName: string;
  readonly contracts: {
    readonly PYTHON: { readonly signature: string; readonly notes: string };
    readonly JAVA: { readonly signature: string; readonly notes: string };
  };
  readonly starterCode: { readonly PYTHON: string; readonly JAVA: string };
  readonly limits: { readonly wallMs: number; readonly memoryMb: number };
  readonly comparison: string;
}

function toClientSafe(
  problem: (typeof PUBLIC_PROBLEMS)[number],
): ClientSafeProblem {
  return {
    id: problem.id,
    version: problem.version,
    title: problem.title,
    difficulty: problem.difficulty,
    description: problem.description,
    constraints: problem.constraints,
    samples: problem.samples.map((sample, index) => ({
      id: `sample-${index + 1}`,
      ...sample,
    })),
    functionName: problem.functionName,
    contracts: {
      PYTHON: problem.contracts.python,
      JAVA: problem.contracts.java,
    },
    starterCode: {
      PYTHON: problem.starterCode.python,
      JAVA: problem.starterCode.java,
    },
    limits: {
      wallMs: problem.limits.wallTimeMs,
      memoryMb: problem.limits.memoryMb,
    },
    comparison: problem.comparison,
  };
}

export const PUBLIC_PROBLEM_CATALOG: readonly ClientSafeProblem[] =
  Object.freeze(PUBLIC_PROBLEMS.map(toClientSafe));

export function listByDifficulty(
  difficulty: ProblemDifficulty,
): readonly ClientSafeProblem[] {
  return PUBLIC_PROBLEM_CATALOG.filter(
    (problem) => problem.difficulty === difficulty,
  );
}

export function getPublicProblem(
  id: string,
  version?: number,
): ClientSafeProblem | undefined {
  const problem = getInternalPublicProblem(id, version);
  return problem ? toClientSafe(problem) : undefined;
}

export const publicProblemCatalog = Object.freeze({
  listByDifficulty,
  get: getPublicProblem,
});
