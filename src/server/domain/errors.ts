export type DomainErrorCode =
  | "AUTH_REQUIRED"
  | "PROFILE_REQUIRED"
  | "USERNAME_INVALID"
  | "USERNAME_TAKEN"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "HOST_CANNOT_JOIN_OWN_ROOM"
  | "NOT_A_PARTICIPANT"
  | "MATCH_NOT_FOUND"
  | "INVALID_STATE"
  | "INVALID_LANGUAGE"
  | "INVALID_CHALLENGE_TYPE"
  | "LANGUAGE_REQUIRED"
  | "NOT_READY"
  | "NO_PROBLEM_AVAILABLE"
  | "RATE_LIMITED"
  | "COOLDOWN_ACTIVE"
  | "EXECUTION_IN_PROGRESS"
  | "SOURCE_TOO_LARGE"
  | "ANSWER_WORD_LIMIT"
  | "ANSWER_CHARACTER_LIMIT"
  | "ANSWER_BYTE_LIMIT"
  | "ANSWER_DEADLINE_PASSED"
  | "ANSWER_ALREADY_SUBMITTED"
  | "JUDGE_UNAVAILABLE"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "REMATCH_EXPIRED"
  | "TICKET_INVALID"
  | "TICKET_REPLAYED";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly status: number;
  readonly retryAt?: string;

  constructor(
    code: DomainErrorCode,
    message: string,
    status = 400,
    retryAt?: string,
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    this.retryAt = retryAt;
  }
}

export function requireActor(
  actorUserId: string | null | undefined,
): asserts actorUserId is string {
  if (!actorUserId) {
    throw new DomainError("AUTH_REQUIRED", "Authentication is required", 401);
  }
}
