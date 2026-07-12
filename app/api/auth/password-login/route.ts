import { NextRequest, NextResponse } from "next/server";
import { authorized, startSession } from "@/lib/auth";

export const runtime = "nodejs";

// Exchange a correct x-admin-password header for a session cookie, so a
// password unlock survives page reloads the same way a passkey unlock does.
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) {
    // Also returned when the caller is over the guess rate limit — we don't
    // distinguish, to keep the lock screen simple.
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  await startSession(res);
  return res;
}
