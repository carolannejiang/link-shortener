import { NextRequest, NextResponse } from "next/server";
import { hasValidSession } from "@/lib/auth";
import { hasCredentials } from "@/lib/webauthn";

export const runtime = "nodejs";

// Lets the admin page decide what to show on load: whether a "Unlock with
// Touch ID" button makes sense, and whether we're already logged in.
export async function GET(req: NextRequest) {
  const [hasPasskey, authenticated] = await Promise.all([
    hasCredentials(),
    hasValidSession(req),
  ]);
  return NextResponse.json({ hasPasskey, authenticated });
}
