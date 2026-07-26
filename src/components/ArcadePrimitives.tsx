import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonTone = "gold" | "cyan" | "ghost" | "danger";

export function ArcadeButton({
  children,
  className = "",
  tone = "gold",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  tone?: ButtonTone;
}) {
  return (
    <button
      className={`arcade-button arcade-button--${tone} ${className}`.trim()}
      {...props}
    >
      <span>{children}</span>
    </button>
  );
}

export function ArcadeLink({
  children,
  href,
  tone = "gold",
}: {
  children: ReactNode;
  href: string;
  tone?: ButtonTone;
}) {
  return (
    <Link className={`arcade-button arcade-button--${tone}`} href={href}>
      <span>{children}</span>
    </Link>
  );
}

export function PixelPanel({
  children,
  className = "",
  label,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <section className={`pixel-panel ${className}`.trim()}>
      {label && <div className="pixel-panel__label">{label}</div>}
      {children}
    </section>
  );
}

export function StatusLamp({
  label,
  tone = "dim",
}: {
  label: string;
  tone?: "cyan" | "gold" | "coral" | "dim";
}) {
  return (
    <span className={`status-lamp status-lamp--${tone}`}>
      <span aria-hidden="true" className="status-lamp__dot" />
      {label}
    </span>
  );
}
