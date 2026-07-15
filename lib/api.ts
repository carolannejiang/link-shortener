import { NextRequest, NextResponse } from "next/server";

// Response and parsing helpers shared by every API route, so the same failure
// is always phrased the same way — and a change to the format happens once,
// here, instead of once per route.

export function unauthorized(message = "Not authorized.") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function tooMany() {
  return NextResponse.json(
    { error: "Too many attempts. Try again in a minute." },
    { status: 429 },
  );
}

// The request body as JSON, or null when absent/malformed — routes validate
// field by field anyway, so both cases are handled identically.
export function readJson<T = Record<string, unknown>>(
  req: NextRequest,
): Promise<T | null> {
  return req.json().catch(() => null);
}
