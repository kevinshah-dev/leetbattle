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
