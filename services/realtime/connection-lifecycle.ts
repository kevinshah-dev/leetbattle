export interface CreatedRealtimeSession {
  readonly sessionId: string;
}

export interface ConnectionLifecycleOptions<
  Connected extends CreatedRealtimeSession,
> {
  readonly isOpen: () => boolean;
  readonly subscribeToClose: (listener: () => void) => void;
  readonly connect: () => Promise<Connected>;
  readonly disconnect: (sessionId: string) => Promise<void>;
  readonly activate: (connected: Connected) => void;
  readonly onDisconnectFailure?: () => void;
}

export interface GuardedRealtimeOperationOptions<Result> {
  readonly isCurrent: () => boolean;
  readonly operation: () => Promise<Result>;
  readonly compensate: () => Promise<void>;
}

export type GuardedRealtimeOperationResult<Result> =
  | { readonly completed: true; readonly result: Result }
  | { readonly completed: false; readonly result: null };

/**
 * Prevents an awaited operation from publishing into a superseded socket
 * generation. If the generation closes while I/O is in flight, compensation
 * runs after success or failure so a late heartbeat cannot revive its session.
 */
export async function runGuardedRealtimeOperation<Result>(
  options: GuardedRealtimeOperationOptions<Result>,
): Promise<GuardedRealtimeOperationResult<Result>> {
  if (!options.isCurrent()) return { completed: false, result: null };

  let result: Result;
  try {
    result = await options.operation();
  } catch (error) {
    if (!options.isCurrent()) await options.compensate();
    throw error;
  }
  if (!options.isCurrent()) {
    await options.compensate();
    return { completed: false, result: null };
  }
  return { completed: true, result };
}

/**
 * Couples asynchronous DB session creation to socket lifetime. A close that
 * wins the race rolls back the newly-created session before this resolves.
 */
export async function establishRealtimeSession<
  Connected extends CreatedRealtimeSession,
>(
  options: ConnectionLifecycleOptions<Connected>,
): Promise<"ACTIVE" | "CLOSED"> {
  let closed = !options.isOpen();
  let sessionId: string | null = null;
  let disconnectPromise: Promise<void> | null = null;

  const disconnectCreatedSession = async (): Promise<void> => {
    if (!sessionId) return;
    disconnectPromise ??= options.disconnect(sessionId).catch(() => {
      options.onDisconnectFailure?.();
    });
    await disconnectPromise;
  };

  options.subscribeToClose(() => {
    closed = true;
    void disconnectCreatedSession();
  });

  if (closed) return "CLOSED";

  const connected = await options.connect();
  sessionId = connected.sessionId;
  if (closed || !options.isOpen()) {
    await disconnectCreatedSession();
    return "CLOSED";
  }

  try {
    options.activate(connected);
  } catch (error) {
    await disconnectCreatedSession();
    throw error;
  }
  return "ACTIVE";
}
