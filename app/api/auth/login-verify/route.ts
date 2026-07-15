import { NextRequest, NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { startSession } from "@/lib/auth";
import { bad, readJson, unauthorized } from "@/lib/api";
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
  const body = await readJson<{
    flowId?: unknown;
    response?: AuthenticationResponseJSON;
  }>(req);
  const flowId = String(body?.flowId ?? "");
  const response = body?.response;

  const expectedChallenge = await takeChallenge(flowId);
  if (!expectedChallenge || !response?.id) {
    return bad("Login expired. Try again.");
  }

  const cred = await getCredential(response.id);
  if (!cred) {
    return bad("Unknown passkey.");
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
    return bad("Could not verify this passkey.");
  }

  if (!verification.verified) {
    return unauthorized("Passkey verification failed.");
  }

  await updateCounter(cred.id, verification.authenticationInfo.newCounter);

  const res = NextResponse.json({ verified: true });
  await startSession(res);
  return res;
}
