import type { Metadata } from "next";

import { JoinRoomGate } from "@/components/JoinRoomGate";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = { title: "Private invite" };

export default async function JoinPage({
  params,
}: {
  params: Promise<{ roomCode: string }>;
}) {
  const { roomCode } = await params;
  return (
    <div className="site-shell">
      <SiteHeader compact />
      <main id="main-content">
        <JoinRoomGate roomCode={roomCode} />
      </main>
    </div>
  );
}
