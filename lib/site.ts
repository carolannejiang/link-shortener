// The domain this deployment serves short links from, e.g. "carolanne.link".
// Shown as the page title, the admin header, and the passkey provider name,
// and used as the fallback host while pages prerender (before window exists).
// Build-time (NEXT_PUBLIC_*): set it in Vercel's env settings and redeploy.
export const SITE_HOST = process.env.NEXT_PUBLIC_SITE_HOST || "localhost:3000";
