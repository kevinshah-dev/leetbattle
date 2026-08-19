import type {
  AiMlEvaluationSnapshot,
  AiMlJudgeAdapter,
  AiMlJudgeResult,
} from "./contracts";
import { parseAiMlEvaluationSnapshot } from "./schemas";

export type FakeAiMlJudgeResponder = (
  snapshot: AiMlEvaluationSnapshot,
  callNumber: number,
) => AiMlJudgeResult | Promise<AiMlJudgeResult>;

export interface FakeAiMlJudge extends AiMlJudgeAdapter {
  readonly callCount: number;
}

/** A deterministic, network-free adapter for lifecycle and coordinator tests. */
export function createFakeAiMlJudge(
  resultOrResponder: AiMlJudgeResult | FakeAiMlJudgeResponder,
): FakeAiMlJudge {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    async evaluate(snapshot) {
      const immutableSnapshot = parseAiMlEvaluationSnapshot(snapshot);
      callCount += 1;
      if (typeof resultOrResponder === "function") {
        return resultOrResponder(immutableSnapshot, callCount);
      }
      return resultOrResponder;
    },
  };
}
