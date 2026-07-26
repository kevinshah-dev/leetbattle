import type { Metadata } from "next";

import { SiteHeader } from "@/components/SiteHeader";
import { UsernameOnboarding } from "@/components/UsernameOnboarding";

export const metadata: Metadata = { title: "Choose your callsign" };

function safeReturnTo(value: string | string[] | undefined) {
  const target = Array.isArray(value) ? value[0] : value;
  return target?.startsWith("/") && !target.startsWith("//") ? target : "/";
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const query = await searchParams;
  return (
    <div className="site-shell">
      <SiteHeader compact />
      <main id="main-content">
        <UsernameOnboarding returnTo={safeReturnTo(query.returnTo)} />
      </main>
    </div>
  );
}
