import type { Metadata } from "next";

import { CreateBattlePanel } from "@/components/CreateBattlePanel";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = { title: "Start a game" };

export default async function CreateBattlePage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode } = await searchParams;
  return (
    <div className="site-shell">
      <SiteHeader compact />
      <main id="main-content">
        <CreateBattlePanel
          initialMode={mode === "practice" ? "PRACTICE" : "DUEL"}
        />
      </main>
    </div>
  );
}
