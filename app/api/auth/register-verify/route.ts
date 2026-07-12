import { NextRequest, NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { authorized, startSession } from "@/lib/auth";
import {
  relyingParty,
  takeChallenge,
  saveCredential,
  toBase64url,
  MAX_LABEL_LEN,
} from "@/lib/webauthn";

export const runtime = "nodejs";

// Step 2 of adding a passkey: verify what the browser produced, store the
// credential, and log this device in.
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const flowId = String(body?.flowId ?? "");
  const response = body?.response;
  const label =
    String(body?.label ?? "").trim().slice(0, MAX_LABEL_LEN) || "This device";

  const expectedChallenge = await takeChallenge(flowId);
  if (!expectedChallenge || !response) {
    return NextResponse.json(
      { error: "Registration expired. Try again." },
      { status: 400 },
    );
  }

  const { rpID, origin } = relyingParty(req);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
  } catch {
    return NextResponse.json(
      { error: "Could not verify this passkey." },
      { status: 400 },
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json(
      { error: "Passkey verification failed." },
      { status: 400 },
    );
  }

  const { credential } = verification.registrationInfo;
  await saveCredential({
    id: credential.id,
    publicKey: toBase64url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    label,
    createdAt: Date.now(),
  });

  const res = NextResponse.json({ verified: true });
  await startSession(res);
  return res;
}
