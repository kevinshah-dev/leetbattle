import { clerkMiddleware } from "@clerk/nextjs/server";

const configuredParty =
  process.env.APP_ORIGIN ?? "https://leetbattle.cenough.games";
let authorizedParty: string;
try {
  const parsed = new URL(configuredParty);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("APP_ORIGIN must use http or https.");
  }
  authorizedParty = parsed.origin;
} catch (error) {
  throw new Error("APP_ORIGIN must be a valid absolute HTTP(S) origin.", {
    cause: error,
  });
}

// Authentication and room membership are still enforced inside every API route.
// Keep the deprecated filename while OpenNext lacks Next 16 Node Proxy support:
// middleware.ts runs at the supported Edge interception layer.
// Binding Clerk cookies to the one configured origin prevents a leaked
// subdomain cookie from being replayed by a different party.
export default clerkMiddleware({ authorizedParties: [authorizedParty] });

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
