import type { Metadata } from "next";

import { LobbyView } from "@/components/LobbyView";

export const metadata: Metadata = { title: "Battle lobby" };

export default async function LobbyPage({
  params,
}: {
  params: Promise<{ roomCode: string }>;
}) {
  const { roomCode } = await params;
  return <LobbyView roomCode={roomCode} />;
}
