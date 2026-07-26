import type { Metadata } from "next";

import { HistoryView } from "@/components/HistoryView";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = { title: "Player profile" };

export default function ProfilePage() {
  return (
    <div className="site-shell">
      <SiteHeader compact />
      <main className="history-page" id="main-content">
        <HistoryView />
      </main>
    </div>
  );
}
