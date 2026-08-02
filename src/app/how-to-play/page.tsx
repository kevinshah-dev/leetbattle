import type { Metadata } from "next";

import { ArcadeLink, PixelPanel } from "@/components/ArcadePrimitives";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = { title: "How to play" };

const rounds = [
  {
    number: "01",
    title: "Choose your mode",
    body: "Practice solo or open a private battle for one friend, then choose Easy, Medium, or Hard.",
  },
  {
    number: "02",
    title: "Choose your loadout",
    body: "Select Python or Java. A duel waits for both players; a practice run starts when your own loadout is ready.",
  },
  {
    number: "03",
    title: "Reveal on the server clock",
    body: "After the countdown, the server reveals one original problem at an authoritative start time.",
  },
  {
    number: "04",
    title: "Clear every hidden test",
    body: "Run published samples and submit against the hidden suite. Duels reward the earliest accepted solution; practice leaves your record unchanged.",
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
            LeetBattle supports private two-player races and focused solo
            practice. There is no public matchmaking, spectator mode, chat, or
            leaderboard.
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
                <dt>Outcome</dt>
                <dd>
                  Duels use the earliest server-received accepted solution with
                  deterministic tie-breaks. Practice only asks you to pass.
                </dd>
              </div>
            </dl>
          </PixelPanel>
          <PixelPanel label="FAIR PLAY & RECOVERY">
            <dl className="rules-list">
              <div>
                <dt>Duel privacy</dt>
                <dd>
                  Status and aggregate progress only. Source code and judge
                  details stay private.
                </dd>
              </div>
              <div>
                <dt>Reconnect</dt>
                <dd>
                  Your local draft returns after refresh. Duels use a 60-second
                  grace period; practice disconnects do not become forfeits.
                </dd>
              </div>
              <div>
                <dt>Rematch</dt>
                <dd>
                  Duels give both players 30 seconds to opt in. Practice offers
                  a fresh solo run instead.
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
          <ArcadeLink href="/battle/new?mode=practice" tone="cyan">
            Practice solo
          </ArcadeLink>
          <ArcadeLink href="/" tone="ghost">
            Back home
          </ArcadeLink>
        </div>
      </main>
    </div>
  );
}
