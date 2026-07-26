export interface PlayerSafeAcknowledgement {
  readonly accepted: true;
}

const ACCEPTED: PlayerSafeAcknowledgement = Object.freeze({ accepted: true });

/**
 * WebSocket commands are followed by authoritative snapshots/events. The raw
 * service return can contain internal identifiers, so ACKs deliberately carry
 * only this allowlisted receipt.
 */
export function playerSafeAcknowledgement(
  internalResult: unknown,
): PlayerSafeAcknowledgement {
  void internalResult;
  return ACCEPTED;
}
