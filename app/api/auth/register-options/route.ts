import { NextRequest, NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { authorized } from "@/lib/auth";
import { clientIp, strike } from "@/lib/rate-limit";
import { tooMany, unauthorized } from "@/lib/api";
import {
  relyingParty,
  RP_NAME,
  listCredentials,
  storeChallenge,
} from "@/lib/webauthn";

export const runtime = "nodejs";

// Challenge starts allowed per IP per minute — same budget as login-options.
const OPTIONS_PER_MINUTE = 10;

// Step 1 of adding a passkey. Only an already-authenticated admin (password or
// existing session) can register a new device.
export async function POST(req: NextRequest) {
  // Like login-options, every call writes a challenge to Redis, so cap how
  // fast one address can spin them up — even one holding a valid session.
  if ((await strike("register-options", clientIp(req))) > OPTIONS_PER_MINUTE) {
    return tooMany();
  }
  if (!(await authorized(req))) return unauthorized();

  const { rpID } = relyingParty(req);
  const existing = await listCredentials();

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: "admin",
    userID: new TextEncoder().encode("admin"),
    attestationType: "none",
    // Don't let the same authenticator register twice.
    excludeCredentials: existing.map((c) => ({
      id: c.id,
      transports: c.transports,
    })),
    authenticatorSelection: {
      // "platform" = the device's own built-in authenticator (Touch ID on a
      // Mac, Face ID / fingerprint on a phone) instead of the cross-device
      // "use your phone or tablet" QR flow.
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      // "required": the authenticator must actually verify the person (Touch
      // ID, Face ID, PIN) — presence of the device alone isn't enough.
      userVerification: "required",
    },
  });

  const flowId = await storeChallenge(options.challenge);
  return NextResponse.json({ flowId, options });
}
