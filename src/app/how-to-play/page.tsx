import type { Metadata } from "next";

import { ArcadeLink, PixelPanel } from "@/components/ArcadePrimitives";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = { title: "How to play" };

const rounds = [
  {
    number: "01",
    title: "Open a private room",
    body: "The host chooses Easy, Medium, or Hard and shares the unlisted invite with one friend.",
  },
  {
    number: "02",
    title: "Choose your loadout",
    body: "Each player independently selects Python or Java. The problem stays sealed until both players mark ready.",
  },
  {
    number: "03",
    title: "Fight on one clock",
    body: "After 3, 2, 1, FIGHT, both players see the same original problem and authoritative start time.",
  },
  {
    number: "04",
    title: "Clear every hidden test",
    body: "Run published samples freely. Submit against the hidden suite. The earliest accepted submission wins.",
  },
];

export default function HowToPlayPage() {
  return (
    <div className="site-shell">
      <SiteHeader />
      <main className="how-page" id="main-content">
        <header className="page-heading">
          <p className="eyebrow">Match manual // v1.0</p>
          <h1>
            Know the rules.
            <br />
            <span>Keep your edge.</span>
          </h1>
          <p>
            LeetBattle is a focused two-player race. There is no public
            matchmaking, spectator mode, chat, or leaderboard.
          </p>
        </header>
        <section className="round-steps" aria-label="Four steps to play">
          {rounds.map((round) => (
            <article className="round-step" key={round.number}>
              <span>{round.number}</span>
              <div>
                <h2>{round.title}</h2>
                <p>{round.body}</p>
              </div>
            </article>
          ))}
        </section>
        <div className="rules-grid">
          <PixelPanel label="JUDGE RULES">
            <dl className="rules-list">
              <div>
                <dt>Run samples</dt>
                <dd>
                  Published cases only. Limited to one run every two seconds.
                </dd>
              </div>
              <div>
                <dt>Submit</dt>
                <dd>All hidden cases. One active execution per player.</dd>
              </div>
              <div>
                <dt>Missed submission</dt>
                <dd>
                  A 10-second server-enforced cooldown after a judged failure.
                </dd>
              </div>
              <div>
                <dt>Winner</dt>
                <dd>
                  The earliest server-received accepted solution, with
                  deterministic tie-breaks.
                </dd>
              </div>
            </dl>
          </PixelPanel>
          <PixelPanel label="FAIR PLAY & RECOVERY">
            <dl className="rules-list">
              <div>
                <dt>Opponent view</dt>
                <dd>
                  Status and aggregate progress only. Source code and judge
                  details stay private.
                </dd>
              </div>
              <div>
                <dt>Reconnect</dt>
                <dd>
                  Your local draft returns after refresh. Active players have a
                  60-second grace period.
                </dd>
              </div>
              <div>
                <dt>Rematch</dt>
                <dd>
                  Both players must opt in within 30 seconds. A fresh problem
                  and language choice follow.
                </dd>
              </div>
              <div>
                <dt>External tools</dt>
                <dd>
                  This MVP protects game state and tests; it does not monitor
                  your device or browser tabs.
                </dd>
              </div>
            </dl>
          </PixelPanel>
        </div>
        <div className="how-page__cta">
          <ArcadeLink href="/battle/new">Create a battle</ArcadeLink>
          <ArcadeLink href="/" tone="ghost">
            Back home
          </ArcadeLink>
        </div>
      </main>
    </div>
  );
}
