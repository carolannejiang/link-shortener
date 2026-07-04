import { NextRequest, NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { relyingParty, listCredentials, storeChallenge } from "@/lib/webauthn";

export const runtime = "nodejs";

// Step 1 of a passkey login. Public: proving the passkey IS the authentication.
export async function POST(req: NextRequest) {
  const { rpID } = relyingParty(req);
  const creds = await listCredentials();

  if (creds.length === 0) {
    return NextResponse.json(
      { error: "No passkeys registered yet." },
      { status: 400 },
    );
  }

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
    allowCredentials: creds.map((c) => ({
      id: c.id,
      transports: c.transports as never,
    })),
  });

  const flowId = await storeChallenge(options.challenge);
  return NextResponse.json({ flowId, options });
}
