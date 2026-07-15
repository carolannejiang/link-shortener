import { NextRequest, NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { relyingParty, listCredentials, storeChallenge } from "@/lib/webauthn";
import { clientIp, strike } from "@/lib/rate-limit";
import { bad, tooMany } from "@/lib/api";

export const runtime = "nodejs";

// Challenge starts allowed per IP per minute. A real login needs one or two.
const OPTIONS_PER_MINUTE = 10;

// Step 1 of a passkey login. Public: proving the passkey IS the authentication.
export async function POST(req: NextRequest) {
  // This endpoint writes a challenge to Redis on every call, so cap how fast
  // one address can spin them up.
  if ((await strike("login-options", clientIp(req))) > OPTIONS_PER_MINUTE) {
    return tooMany();
  }

  const { rpID } = relyingParty(req);
  const creds = await listCredentials();

  if (creds.length === 0) {
    return bad("No passkeys registered yet.");
  }

  const options = await generateAuthenticationOptions({
    rpID,
    // "required": the authenticator must actually verify the person (Touch ID,
    // Face ID, PIN) — presence of the device alone isn't enough for admin.
    userVerification: "required",
    allowCredentials: creds.map((c) => ({
      id: c.id,
      transports: c.transports,
    })),
  });

  const flowId = await storeChallenge(options.challenge);
  return NextResponse.json({ flowId, options });
}
