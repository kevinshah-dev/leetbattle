import Link from "next/link";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      aria-label="LeetBattle home"
      className={`brand-mark${compact ? " brand-mark--compact" : ""}`}
      href="/"
    >
      <span aria-hidden="true" className="brand-bracket brand-bracket--left" />
      <span className="brand-words">
        <span>LEET</span>
        <span>BATTLE</span>
      </span>
      <span aria-hidden="true" className="brand-bolt" />
      <span aria-hidden="true" className="brand-bracket brand-bracket--right" />
    </Link>
  );
}
