import type { Metadata } from "next";

import { CreateBattlePanel } from "@/components/CreateBattlePanel";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = { title: "Create battle" };

export default function CreateBattlePage() {
  return (
    <div className="site-shell">
      <SiteHeader compact />
      <main id="main-content">
        <CreateBattlePanel />
      </main>
    </div>
  );
}
