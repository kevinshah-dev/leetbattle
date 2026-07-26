export interface RealtimeHeartbeatStore<Snapshot> {
  touchSession(sessionId: string, actorUserId: string): Promise<boolean>;
  connectSession(input: {
    actorUserId: string;
    roomId: string;
    matchId: string;
    sessionId: string;
  }): Promise<{ sessionId: string; snapshot: Snapshot }>;
}

export type RealtimeHeartbeatResult<Snapshot> =
  | { reactivated: false; snapshot: null }
  | { reactivated: true; snapshot: Snapshot };

/**
 * Refreshes an active session, or re-enters through the normal connection
 * transaction if maintenance marked it stale while the transport stayed open.
 */
export async function refreshRealtimeSessionHeartbeat<Snapshot>(
  store: RealtimeHeartbeatStore<Snapshot>,
  input: {
    actorUserId: string;
    roomId: string;
    matchId: string;
    sessionId: string;
  },
): Promise<RealtimeHeartbeatResult<Snapshot>> {
  if (await store.touchSession(input.sessionId, input.actorUserId)) {
    return { reactivated: false, snapshot: null };
  }

  const connected = await store.connectSession(input);
  return { reactivated: true, snapshot: connected.snapshot };
}
