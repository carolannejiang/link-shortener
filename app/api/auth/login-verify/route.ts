import { NextRequest, NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { startSession } from "@/lib/auth";
import {
  relyingParty,
  takeChallenge,
  getCredential,
  updateCounter,
  fromBase64url,
} from "@/lib/webauthn";

export const runtime = "nodejs";

// Step 2 of a passkey login: verify the browser's assertion and, if good,
// hand out a session cookie.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const flowId = String(body?.flowId ?? "");
  const response = body?.response;

  const expectedChallenge = await takeChallenge(flowId);
  if (!expectedChallenge || !response?.id) {
    return NextResponse.json(
      { error: "Login expired. Try again." },
      { status: 400 },
    );
  }

  const cred = await getCredential(response.id);
  if (!cred) {
    return NextResponse.json(
      { error: "Unknown passkey." },
      { status: 400 },
    );
  }

  const { rpID, origin } = relyingParty(req);

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: cred.id,
        publicKey: fromBase64url(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Could not verify this passkey." },
      { status: 400 },
    );
  }

  if (!verification.verified) {
    return NextResponse.json(
      { error: "Passkey verification failed." },
      { status: 401 },
    );
  }

  await updateCounter(cred.id, verification.authenticationInfo.newCounter);

  const res = NextResponse.json({ verified: true });
  await startSession(res);
  return res;
}
