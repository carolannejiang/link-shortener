import { NextRequest, NextResponse } from "next/server";
import { redis, LINKS_KEY } from "@/lib/redis";

// This runs on the server (Node runtime) before the request reaches a page.
// For any path like /career it looks the slug up in Redis and, if found,
// fires a redirect to the real destination. Unknown paths fall through.
export async function proxy(req: NextRequest) {
  const slug = decodeURIComponent(req.nextUrl.pathname.slice(1)); // drop leading "/"

  if (!slug) return NextResponse.next(); // homepage

  const url = await redis.hget<string>(LINKS_KEY, slug);

  if (url) {
    // 307 = temporary redirect. We deliberately avoid 301/308 (permanent),
    // because browsers cache those hard — if you ever repoint /career to a
    // new URL, a permanent redirect could keep sending people to the old one.
    return NextResponse.redirect(url, 307);
  }

  return NextResponse.next();
}

// Don't run the proxy on framework internals, the admin UI, the API,
// or obvious static files. Everything else is treated as a possible slug.
export const config = {
  matcher: ["/((?!_next/|admin|api/|favicon.ico|robots.txt|sitemap.xml).*)"],
};
