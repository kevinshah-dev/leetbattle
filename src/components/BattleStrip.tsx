import type { MatchState, PlayerHud } from "./api-client";

function activityLabel(player: PlayerHud | null) {
  if (!player) return "Waiting for challenger";
  if (!player.connected) return "Disconnected";
  const labels: Record<PlayerHud["activity"], string> = {
    WAITING: "Thinking",
    READY: "Ready",
    THINKING: "Thinking",
    COMPILING: "Compiling",
    JUDGING: "Judging hidden tests",
    COOLDOWN: "Cooling down",
    VERIFYING: "Accepted · verifying",
    ACCEPTED: "Accepted",
    DISCONNECTED: "Disconnected",
  };
  return labels[player.activity];
}

function ProgressRail({
  player,
  reverse = false,
}: {
  player: PlayerHud | null;
  reverse?: boolean;
}) {
  const total = Math.max(1, player?.totalTests || 10);
  const passed = Math.max(0, Math.min(total, player?.bestPassed || 0));
  const visibleSegments = 10;
  const lit = Math.round((passed / total) * visibleSegments);
  return (
    <div
      aria-label={
        player
          ? `${player.bestPassed} of ${player.totalTests || "unknown"} hidden tests passed`
          : "No challenger progress"
      }
      className={`hud-progress${reverse ? " hud-progress--reverse" : ""}`}
      role="meter"
      aria-valuemax={total}
      aria-valuemin={0}
      aria-valuenow={passed}
    >
      {Array.from({ length: visibleSegments }, (_, index) => (
        <i className={index < lit ? "is-lit" : ""} key={index} />
      ))}
    </div>
  );
}

function Fighter({
  player,
  side,
}: {
  player: PlayerHud | null;
  side: "left" | "right";
}) {
  const activity =
    player?.connected === false
      ? "DISCONNECTED"
      : player?.activity || "WAITING";
  return (
    <div
      className={`pit-fighter pit-fighter--${side} pit-fighter--${activity.toLowerCase()}`}
      aria-hidden="true"
    >
      <span className="pit-fighter__signal" />
      <span className="pit-fighter__head">
        <i />
        <b />
      </span>
      <span className="pit-fighter__torso">
        <i />
      </span>
      <span className="pit-fighter__arm pit-fighter__arm--lead" />
      <span className="pit-fighter__arm pit-fighter__arm--rear" />
      <span className="pit-fighter__legs" />
      <span className="pit-fighter__impact" />
    </div>
  );
}

export function BattleStrip({
  centerLabel,
  opponent,
  self,
  state,
  timer,
}: {
  centerLabel?: string;
  opponent: PlayerHud | null;
  self: PlayerHud;
  state: MatchState;
  timer: string;
}) {
  return (
    <section
      aria-label="Live battle status"
      className={`battle-strip battle-strip--${state.toLowerCase()}`}
    >
      <div className="player-hud player-hud--self">
        <div className="player-hud__line">
          <strong>{self.username}</strong>
          <span>P1 · YOU</span>
        </div>
        <ProgressRail player={self} />
        <div className="player-hud__status">
          <span className={self.connected ? "is-online" : ""} />
          {activityLabel(self)}
        </div>
      </div>
      <div className="battle-strip__pit" aria-hidden="true">
        <div className="pit-sky">
          <i />
          <i />
          <i />
        </div>
        <Fighter player={self} side="left" />
        <div className="pit-center-mark">
          <b>{centerLabel || "VS"}</b>
          <span className="tabular">{timer}</span>
        </div>
        <Fighter player={opponent} side="right" />
        <div className="pit-floor">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className="player-hud player-hud--opponent">
        <div className="player-hud__line">
          <strong>{opponent?.username || "OPEN SLOT"}</strong>
          <span>P2 · RIVAL</span>
        </div>
        <ProgressRail player={opponent} reverse />
        <div className="player-hud__status">
          <span className={opponent?.connected ? "is-online" : ""} />
          {activityLabel(opponent)}
        </div>
      </div>
    </section>
  );
}
