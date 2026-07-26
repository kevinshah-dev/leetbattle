import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import {
  hasValidNotifySecret,
  matchIdFromVerifiedTicket,
  RequestFault,
} from "../../cloudflare/realtime/src/validation";
import { INTERNAL_SECRET_PLACEHOLDERS } from "@/server/config/secrets";

const secret = `ticket-${"a".repeat(40)}`;
const key = new TextEncoder().encode(secret);
const matchId = "f53ab767-3b0f-4c3d-b730-31f9d073f6a9";

async function ticket(overrides: { audience?: string } = {}) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({ matchId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject("user_123")
    .setJti("ticket_123")
    .setIssuer("leetbattle-web")
    .setAudience(overrides.audience ?? "leetbattle-realtime")
    .setIssuedAt(now)
    .setExpirationTime(now + 45)
    .sign(key);
}

describe("Cloudflare realtime admission routing", () => {
  it("routes only a correctly signed, audience-bound ticket", async () => {
    await expect(
      matchIdFromVerifiedTicket(await ticket(), secret),
    ).resolves.toBe(matchId);
  });

  it("rejects a fabricated or incorrectly scoped token before DO routing", async () => {
    const fabricated = await ticket({ audience: "another-service" });
    await expect(
      matchIdFromVerifiedTicket(fabricated, secret),
    ).rejects.toBeInstanceOf(RequestFault);

    const [header, payload] = fabricated.split(".");
    await expect(
      matchIdFromVerifiedTicket(`${header}.${payload}.invalid`, secret),
    ).rejects.toBeInstanceOf(RequestFault);
  });

  it("rejects published placeholder ticket secrets at the edge", async () => {
    await expect(
      matchIdFromVerifiedTicket(
        await ticket(),
        INTERNAL_SECRET_PLACEHOLDERS.REALTIME_TICKET_SECRET,
      ),
    ).rejects.toThrow(/placeholder/);
  });
});

describe("Cloudflare realtime notification authentication", () => {
  it("rejects published placeholder notification secrets", async () => {
    const placeholder = INTERNAL_SECRET_PLACEHOLDERS.REALTIME_NOTIFY_SECRET;
    const request = new Request(
      "https://realtime.example.test/internal/notify",
      {
        headers: { authorization: `Bearer ${placeholder}` },
      },
    );

    await expect(hasValidNotifySecret(request, placeholder)).rejects.toThrow(
      /placeholder/,
    );
  });
});
