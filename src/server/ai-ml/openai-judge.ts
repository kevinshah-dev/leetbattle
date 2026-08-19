import OpenAI from "openai";
import {
  ContentFilterFinishReasonError,
  LengthFinishReasonError,
} from "openai/error";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import type {
  AiMlEvaluationSnapshot,
  AiMlJudgeAdapter,
  AiMlJudgeAttemptClassification,
  AiMlJudgeAttemptMetadata,
  AiMlJudgeEvaluationOptions,
  AiMlJudgeFailureCode,
  AiMlJudgeProviderMetadata,
  AiMlJudgeResult,
  AiMlJudgeTokenUsage,
} from "./contracts";
import { AiMlJudgeUnavailableError } from "./contracts";
import type { AiMlJudgeRequestBudget } from "./request-budget";
import { AiMlJudgeRequestBudgetExceededError } from "./request-budget";
import {
  AiMlSemanticValidationError,
  validateAiMlDuelScoring,
  validateAiMlPracticeScoring,
} from "./scoring";
import {
  AiMlDuelProviderOutputSchema,
  AiMlPracticeProviderOutputSchema,
  parseAiMlEvaluationSnapshot,
} from "./schemas";

export const OPENAI_JUDGE_DEFAULT_MODEL = "gpt-5.4-nano";
export const OPENAI_JUDGE_MAX_ATTEMPTS = 3;
export const OPENAI_JUDGE_TIMEOUT_MS = 30_000;
export const OPENAI_JUDGE_MAX_OUTPUT_TOKENS = 900;

export interface OpenAiJudgeRequest {
  readonly model: string;
  readonly input: readonly [
    Readonly<{ role: "developer"; content: string }>,
    Readonly<{ role: "user"; content: string }>,
  ];
  readonly store: false;
  readonly tools: readonly [];
  readonly reasoning: Readonly<{ effort: "low" }>;
  readonly max_output_tokens: typeof OPENAI_JUDGE_MAX_OUTPUT_TOKENS;
}

export interface OpenAiJudgeTransportUsage {
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cachedTokens?: number | null;
  readonly reasoningTokens?: number | null;
}

export interface OpenAiJudgeTransportResponse {
  readonly responseId: string | null;
  readonly returnedModel: string;
  readonly status?: string;
  readonly incompleteReason?: string | null;
  readonly refused?: boolean;
  readonly outputParsed: unknown;
  readonly usage?: OpenAiJudgeTransportUsage;
}

export interface OpenAiJudgeTransportInput {
  readonly request: OpenAiJudgeRequest;
  readonly outputSchema: z.ZodType;
  readonly formatName: "ai_ml_duel_judge" | "ai_ml_practice_judge";
}

export interface OpenAiJudgeTransport {
  /** Live transports must opt into durable accounting before any request. */
  readonly requiresDurableRequestBudget?: boolean;
  parse(
    input: OpenAiJudgeTransportInput,
  ): Promise<OpenAiJudgeTransportResponse>;
}

export type OpenAiJudgeTransportErrorKind =
  "network" | "timeout" | "http" | "refusal" | "incomplete";

/** A provider-boundary error with no prompt, answer, or raw response content. */
export class OpenAiJudgeTransportError extends Error {
  constructor(
    readonly kind: OpenAiJudgeTransportErrorKind,
    readonly httpStatus: number | null = null,
  ) {
    super("OpenAI judge transport failed");
    this.name = "OpenAiJudgeTransportError";
  }
}

export interface OpenAiSdkJudgeTransportOptions {
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

/** Production transport. SDK retries are disabled so the adapter owns the cap. */
export class OpenAiSdkJudgeTransport implements OpenAiJudgeTransport {
  readonly requiresDurableRequestBudget = true;
  private readonly client: OpenAI;
  private readonly timeoutMs: number;

  constructor(options: OpenAiSdkJudgeTransportOptions = {}) {
    this.timeoutMs = validateTimeout(
      options.timeoutMs ?? OPENAI_JUDGE_TIMEOUT_MS,
    );
    this.client = new OpenAI({
      apiKey: options.apiKey,
      maxRetries: 0,
      timeout: this.timeoutMs,
    });
  }

  async parse({
    request,
    outputSchema,
    formatName,
  }: OpenAiJudgeTransportInput): Promise<OpenAiJudgeTransportResponse> {
    try {
      const response = await this.client.responses.parse(
        {
          model: request.model,
          input: request.input.map((message) => ({ ...message })),
          store: request.store,
          tools: [],
          reasoning: { effort: request.reasoning.effort },
          max_output_tokens: request.max_output_tokens,
          text: {
            format: zodTextFormat(outputSchema, formatName),
          },
        },
        { maxRetries: 0, timeout: this.timeoutMs },
      );

      const refused = response.output.some(
        (item) =>
          item.type === "message" &&
          item.content.some((content) => content.type === "refusal"),
      );
      const usage = response.usage;

      return {
        responseId: response.id,
        returnedModel: response.model,
        status: response.status,
        incompleteReason: response.incomplete_details?.reason ?? null,
        refused,
        outputParsed: response.output_parsed,
        usage: usage
          ? {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              cachedTokens: usage.input_tokens_details.cached_tokens,
              reasoningTokens: usage.output_tokens_details.reasoning_tokens,
            }
          : undefined,
      };
    } catch (error) {
      if (error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new OpenAiJudgeTransportError("timeout");
      }
      if (error instanceof OpenAI.APIConnectionError) {
        throw new OpenAiJudgeTransportError("network");
      }
      if (error instanceof LengthFinishReasonError) {
        throw new OpenAiJudgeTransportError("incomplete");
      }
      if (error instanceof ContentFilterFinishReasonError) {
        throw new OpenAiJudgeTransportError("refusal");
      }
      if (error instanceof OpenAI.APIError) {
        throw new OpenAiJudgeTransportError("http", error.status ?? null);
      }
      throw error;
    }
  }
}

interface OpenAiEvaluationPayload {
  readonly schemaVersion: string;
  readonly mode: "DUEL" | "PRACTICE";
  readonly question: AiMlEvaluationSnapshot["question"];
  readonly answers: AiMlEvaluationSnapshot["answers"];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Builds the complete single-pass request. Instructions and untrusted data are
 * separate messages; answers can never become model options or instructions.
 */
export function buildOpenAiJudgeRequest(
  snapshot: AiMlEvaluationSnapshot,
  requestedModel = OPENAI_JUDGE_DEFAULT_MODEL,
): OpenAiJudgeRequest {
  if (requestedModel.trim() === "") {
    throw new TypeError("The OpenAI judge model must not be blank");
  }

  const payload: OpenAiEvaluationPayload = {
    schemaVersion: snapshot.schemaVersion,
    mode: snapshot.mode,
    question: snapshot.question,
    answers: snapshot.answers,
  };
  return deepFreeze({
    model: requestedModel,
    input: [
      { role: "developer", content: snapshot.instructions },
      { role: "user", content: JSON.stringify(payload) },
    ],
    store: false,
    tools: [],
    reasoning: { effort: "low" },
    max_output_tokens: OPENAI_JUDGE_MAX_OUTPUT_TOKENS,
  });
}

export interface OpenAiJudgeAdapterOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly transport?: OpenAiJudgeTransport;
  /** Required for the live SDK transport; optional for injected test transports. */
  readonly requestBudget?: AiMlJudgeRequestBudget;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
}

interface ClassifiedFailure {
  readonly code: AiMlJudgeFailureCode;
  readonly classification: AiMlJudgeAttemptClassification;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
}

export class OpenAiJudgeAdapter implements AiMlJudgeAdapter {
  private readonly requestedModel: string;
  private readonly maxAttempts: number;
  private readonly transport: OpenAiJudgeTransport;
  private readonly requestBudget: AiMlJudgeRequestBudget | undefined;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(options: OpenAiJudgeAdapterOptions = {}) {
    this.requestedModel = options.model ?? OPENAI_JUDGE_DEFAULT_MODEL;
    if (this.requestedModel.trim() === "") {
      throw new TypeError("The OpenAI judge model must not be blank");
    }
    this.maxAttempts = validateMaxAttempts(
      options.maxAttempts ?? OPENAI_JUDGE_MAX_ATTEMPTS,
    );
    const timeoutMs = validateTimeout(
      options.timeoutMs ?? OPENAI_JUDGE_TIMEOUT_MS,
    );
    const transport =
      options.transport ??
      new OpenAiSdkJudgeTransport({ apiKey: options.apiKey, timeoutMs });
    if (transport.requiresDurableRequestBudget && !options.requestBudget) {
      throw new TypeError(
        "The live OpenAI judge transport requires a durable request budget",
      );
    }
    this.transport = transport;
    this.requestBudget = options.requestBudget;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  async evaluate(
    snapshot: AiMlEvaluationSnapshot,
    options: AiMlJudgeEvaluationOptions = {},
  ): Promise<AiMlJudgeResult> {
    let immutableSnapshot: AiMlEvaluationSnapshot;
    try {
      immutableSnapshot = parseAiMlEvaluationSnapshot(snapshot);
    } catch {
      throw new AiMlJudgeUnavailableError({
        code: "CONFIGURATION",
        retryable: false,
        attemptCount: 0,
        attempts: Object.freeze([]),
      });
    }

    const requestedModel = options.requestedModel ?? this.requestedModel;
    const request = buildOpenAiJudgeRequest(immutableSnapshot, requestedModel);
    const outputSchema =
      immutableSnapshot.mode === "DUEL"
        ? AiMlDuelProviderOutputSchema
        : AiMlPracticeProviderOutputSchema;
    const formatName =
      immutableSnapshot.mode === "DUEL"
        ? ("ai_ml_duel_judge" as const)
        : ("ai_ml_practice_judge" as const);
    const attempts: AiMlJudgeAttemptMetadata[] = [];

    if (
      this.requestBudget &&
      (!options.evaluationId ||
        !options.claimId ||
        !options.participantUserIds ||
        options.participantUserIds.length < 1 ||
        options.participantUserIds.length > 2)
    ) {
      throw new AiMlJudgeUnavailableError({
        code: "CONFIGURATION",
        retryable: false,
        attemptCount: 0,
        attempts: Object.freeze([]),
      });
    }

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let reservationId: string | null = null;
      if (this.requestBudget) {
        try {
          const reservation = await this.requestBudget.reserve({
            evaluationId: options.evaluationId!,
            claimId: options.claimId!,
            adapterAttempt: attempt,
            requestedModel,
            participantUserIds: options.participantUserIds!,
          });
          reservationId = reservation.id;
        } catch (error) {
          throw new AiMlJudgeUnavailableError({
            code:
              error instanceof AiMlJudgeRequestBudgetExceededError
                ? "BUDGET_CIRCUIT_OPEN"
                : "BUDGET_ACCOUNTING_FAILED",
            retryable: true,
            attemptCount: attempts.length,
            attempts: Object.freeze([...attempts]),
          });
        }
      }

      const startedAt = this.now();
      let response: OpenAiJudgeTransportResponse | undefined;
      try {
        response = await this.transport.parse({
          request,
          outputSchema,
          formatName,
        });

        if (response.refused) {
          throw new OpenAiJudgeTransportError("refusal");
        }
        if (response.status !== undefined && response.status !== "completed") {
          throw new OpenAiJudgeTransportError("incomplete");
        }
        if (response.outputParsed === null) {
          throw new z.ZodError([]);
        }

        const parsed = outputSchema.parse(response.outputParsed);
        const scored =
          immutableSnapshot.mode === "DUEL"
            ? validateAiMlDuelScoring(
                immutableSnapshot,
                AiMlDuelProviderOutputSchema.parse(parsed),
              )
            : validateAiMlPracticeScoring(
                immutableSnapshot,
                AiMlPracticeProviderOutputSchema.parse(parsed),
              );
        const latencyMs = elapsedMs(startedAt, this.now());
        const usage = safeUsage(response.usage);
        attempts.push(
          Object.freeze({
            reservationId,
            attempt,
            classification: "success" as const,
            retryable: false,
            latencyMs,
            httpStatus: null,
            responseId: response.responseId,
            returnedModel: response.returnedModel,
            ...usage,
          }),
        );
        const provider: AiMlJudgeProviderMetadata = Object.freeze({
          attemptCount: attempt,
          responseId: response.responseId,
          requestedModel,
          returnedModel: response.returnedModel,
          latencyMs: attempts.reduce(
            (total, metadata) => total + metadata.latencyMs,
            0,
          ),
          attempts: Object.freeze([...attempts]),
          ...usage,
        });
        return Object.freeze({ ...scored, provider });
      } catch (error) {
        const failure = classifyFailure(error);
        const metadata = Object.freeze({
          reservationId,
          attempt,
          classification: failure.classification,
          retryable: failure.retryable,
          latencyMs: elapsedMs(startedAt, this.now()),
          httpStatus: failure.httpStatus,
          responseId: response?.responseId ?? null,
          returnedModel: response?.returnedModel ?? null,
          ...safeUsage(response?.usage),
        });
        attempts.push(metadata);

        if (!failure.retryable || attempt === this.maxAttempts) {
          throw new AiMlJudgeUnavailableError({
            code: failure.code,
            retryable: failure.retryable,
            attemptCount: attempt,
            attempts: Object.freeze([...attempts]),
          });
        }

        await this.sleep(retryDelayMs(attempt, this.random()));
      }
    }

    throw new AiMlJudgeUnavailableError({
      code: "UNKNOWN",
      retryable: false,
      attemptCount: attempts.length,
      attempts: Object.freeze([...attempts]),
    });
  }
}

function validateMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new RangeError("AI/ML judge maxAttempts must be between 1 and 3");
  }
  return value;
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > 60_000) {
    throw new RangeError("AI/ML judge timeout must be between 1s and 60s");
  }
  return value;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelayMs(attempt: number, randomValue: number): number {
  const boundedRandom = Math.min(1, Math.max(0, randomValue));
  const jitter = 0.75 + boundedRandom * 0.5;
  return Math.min(1_000, Math.round(150 * 2 ** (attempt - 1) * jitter));
}

function elapsedMs(startedAt: number, finishedAt: number): number {
  return Math.max(0, Math.round(finishedAt - startedAt));
}

function safeTokenCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function safeUsage(
  usage: OpenAiJudgeTransportUsage | undefined,
): AiMlJudgeTokenUsage {
  return {
    inputTokens: safeTokenCount(usage?.inputTokens),
    outputTokens: safeTokenCount(usage?.outputTokens),
    cachedTokens: safeTokenCount(usage?.cachedTokens),
    reasoningTokens: safeTokenCount(usage?.reasoningTokens),
  };
}

function classifyFailure(error: unknown): ClassifiedFailure {
  if (error instanceof AiMlSemanticValidationError) {
    return {
      code: "SEMANTIC_INVALID",
      classification: "semantic_invalid",
      retryable: true,
      httpStatus: null,
    };
  }
  if (error instanceof z.ZodError) {
    return {
      code: "SCHEMA_INVALID",
      classification: "schema_invalid",
      retryable: true,
      httpStatus: null,
    };
  }
  if (error instanceof OpenAiJudgeTransportError) {
    if (error.kind === "network") {
      return {
        code: "NETWORK",
        classification: "network",
        retryable: true,
        httpStatus: null,
      };
    }
    if (error.kind === "timeout") {
      return {
        code: "TIMEOUT",
        classification: "timeout",
        retryable: true,
        httpStatus: null,
      };
    }
    if (error.kind === "refusal") {
      return {
        code: "REFUSAL",
        classification: "refusal",
        retryable: true,
        httpStatus: null,
      };
    }
    if (error.kind === "incomplete") {
      return {
        code: "INCOMPLETE",
        classification: "incomplete",
        retryable: true,
        httpStatus: null,
      };
    }
    if (error.httpStatus === 429) {
      return {
        code: "RATE_LIMIT",
        classification: "rate_limit",
        retryable: true,
        httpStatus: 429,
      };
    }
    if (error.httpStatus === 408) {
      return {
        code: "TIMEOUT",
        classification: "timeout",
        retryable: true,
        httpStatus: 408,
      };
    }
    if (error.httpStatus !== null && error.httpStatus >= 500) {
      return {
        code: "PROVIDER_5XX",
        classification: "provider_5xx",
        retryable: true,
        httpStatus: error.httpStatus,
      };
    }
    return {
      code: "PROVIDER_4XX",
      classification: "provider_4xx",
      retryable: false,
      httpStatus: error.httpStatus,
    };
  }
  return {
    code: "UNKNOWN",
    classification: "unknown",
    retryable: false,
    httpStatus: null,
  };
}
