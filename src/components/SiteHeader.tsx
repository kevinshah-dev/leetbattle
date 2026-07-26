import Link from "next/link";

import { BrandMark } from "./BrandMark";
import { ClerkAuthControls } from "./ClerkAuthControls";

export function SiteHeader({ compact = false }: { compact?: boolean }) {
  return (
    <header className={`site-header${compact ? " site-header--compact" : ""}`}>
      <BrandMark compact={compact} />
      <nav aria-label="Primary" className="site-nav">
        <Link href="/how-to-play">How to play</Link>
        <Link href="/history">History</Link>
      </nav>
      <ClerkAuthControls compact={compact} />
    </header>
  );
}
