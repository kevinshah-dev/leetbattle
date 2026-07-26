import type { Metadata } from "next";

import { BattleView } from "@/components/BattleView";

export const metadata: Metadata = { title: "Live battle" };

export default async function BattlePage({
  params,
}: {
  params: Promise<{ roomCode: string }>;
}) {
  const { roomCode } = await params;
  return <BattleView roomCode={roomCode} />;
}
