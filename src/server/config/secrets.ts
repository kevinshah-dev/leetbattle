export const INTERNAL_SECRET_PLACEHOLDERS = Object.freeze({
  REALTIME_TICKET_SECRET: "replace_with_at_least_32_random_bytes",
  RUNNER_INTERNAL_SECRET: "replace_with_a_different_32_byte_secret",
  ROOM_INVITE_SECRET: "replace_with_a_third_32_byte_secret",
  REALTIME_NOTIFY_SECRET: "replace_with_a_fourth_32_byte_secret",
} as const);

export type InternalSecretName = keyof typeof INTERNAL_SECRET_PLACEHOLDERS;
export type CoreInternalSecretName = Exclude<
  InternalSecretName,
  "REALTIME_NOTIFY_SECRET"
>;

const placeholderValues = new Set<string>(
  Object.values(INTERNAL_SECRET_PLACEHOLDERS),
);

/**
 * Validates a server-only secret without ever including its value in an error.
 * Every published .env.example sentinel is rejected for every secret name.
 */
export function requireInternalSecret(
  name: InternalSecretName,
  value: string | null | undefined,
): string {
  if (!value) throw new Error(`${name} is required`);
  if (placeholderValues.has(value)) {
    throw new Error(`${name} must not use an example placeholder value`);
  }
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  return value;
}

export function requireDistinctInternalSecrets(
  values: Readonly<Record<CoreInternalSecretName, string | null | undefined>>,
): Readonly<Record<CoreInternalSecretName, string>> {
  const validated = {
    REALTIME_TICKET_SECRET: requireInternalSecret(
      "REALTIME_TICKET_SECRET",
      values.REALTIME_TICKET_SECRET,
    ),
    RUNNER_INTERNAL_SECRET: requireInternalSecret(
      "RUNNER_INTERNAL_SECRET",
      values.RUNNER_INTERNAL_SECRET,
    ),
    ROOM_INVITE_SECRET: requireInternalSecret(
      "ROOM_INVITE_SECRET",
      values.ROOM_INVITE_SECRET,
    ),
  };
  if (new Set(Object.values(validated)).size !== 3) {
    throw new Error("Internal service secrets must be distinct");
  }
  return Object.freeze(validated);
}

export function requireAllDistinctInternalSecrets(
  values: Readonly<Record<InternalSecretName, string | null | undefined>>,
): Readonly<Record<InternalSecretName, string>> {
  const core = requireDistinctInternalSecrets(values);
  const notification = requireInternalSecret(
    "REALTIME_NOTIFY_SECRET",
    values.REALTIME_NOTIFY_SECRET,
  );
  const validated = {
    ...core,
    REALTIME_NOTIFY_SECRET: notification,
  };
  if (new Set(Object.values(validated)).size !== 4) {
    throw new Error("Internal service secrets must be distinct");
  }
  return Object.freeze(validated);
}
