import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";

import { DesktopGate } from "@/components/DesktopGate";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "LeetBattle — Code first. Strike first.",
    template: "%s · LeetBattle",
  },
  description:
    "Private real-time coding battles and AI/ML Arena duels, with solo practice for both challenge types.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#070B12",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider
      publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
    >
      <html lang="en">
        <body>
          <a className="skip-link" href="#main-content">
            Skip to content
          </a>
          {children}
          <DesktopGate />
        </body>
      </html>
    </ClerkProvider>
  );
}
