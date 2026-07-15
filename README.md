# carolanne.link — a private link shortener

A tiny Next.js app that turns long URLs into short ones under your own domain
(e.g. `carolanne.link/career`). One locked admin page lets you add links from
any browser; new links work the instant you save them. Each link gets a QR
code, click/scan analytics, a private note, and an on/off switch.

## How it works (the whole thing in five pieces)

1. **`proxy.ts`** runs before every request. For a path like `/career` it looks
   the slug up in Redis and, if it exists, redirects to the real URL (carrying
   any query params along). It also records each hit — device, browser, rough
   location, QR vs. direct — after the redirect is already on its way.
2. **`app/api/links/route.ts`** is the admin-only API that lists, creates,
   disables, annotates, and deletes links.
3. **`app/admin/page.tsx`** is the page you actually use: unlock, paste a long
   URL, pick a short name, save. QR codes, per-link notes, and a stats panel
   live here too.
4. **`lib/auth.ts` + `app/api/auth/*`** handle unlocking, with either the
   `ADMIN_PASSWORD` environment variable (never in the code) or a passkey
   (Touch ID / Face ID). Both hand out a session cookie so you stay signed in.
5. **Redis** (added through the Vercel Marketplace) remembers everything:
   links, counters, notes, sessions, and passkeys.

Nothing here is edge-magic: the slug → URL map is a single Redis hash called
`links`, and every link is just one field in it.

## Deploy it (about 15 minutes)

You need a [Vercel](https://vercel.com) account, a GitHub account (Vercel deploys
from a Git repo), and your domain `carolanne.link`.

### 1. Put the code on GitHub
Create a new empty repo on GitHub, then from this folder:

```bash
git init
git add .
git commit -m "link shortener"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

### 2. Import to Vercel
Go to vercel.com/new, pick the repo, and click **Deploy**. The first deploy will
succeed but the links won't work yet — it has no database and no password. Next
two steps fix that.

### 3. Add the database
In your new Vercel project: **Storage → Create / Connect Database → Redis**
(any Marketplace Redis provider — Upstash is the simplest). Create it and connect
it to this project. Vercel automatically adds the connection variables
(`KV_REST_API_URL` and `KV_REST_API_TOKEN`, or the `UPSTASH_REDIS_REST_*`
versions — the code accepts either).

### 4. Add your admin password
**Settings → Environment Variables → Add:**

| Name | Value |
| --- | --- |
| `ADMIN_PASSWORD` | a long password you choose |

### 5. Redeploy
**Deployments → ⋯ on the latest one → Redeploy.** Environment variables only
take effect on a fresh deploy, so this step matters.

### 6. Point the domain at it
**Settings → Domains → Add `carolanne.link`.** Vercel shows you the exact DNS
records (or nameservers) to set at whoever you bought the domain from. Once DNS
propagates, Vercel issues the HTTPS certificate automatically.

### 7. Use it
Visit `https://carolanne.link/admin`, enter your password, and create a link —
slug `career`, destination your long URL. Then open `carolanne.link/career`. Done.

## Running it on your own computer (optional)

```bash
npm install
cp .env.local.example .env.local      # then fill in the 3 values (see below)
node scripts/local-redis.mjs          # terminal 1: throwaway in-memory Redis
npm run dev                           # terminal 2: open http://localhost:3000/admin
```

`ADMIN_PASSWORD` is whatever you like. For the two Redis values, either point
at the local stand-in started above (no account needed; data resets when it
restarts):

```
KV_REST_API_URL=http://127.0.0.1:8079
KV_REST_API_TOKEN=anything
```

or copy the real values out of the Vercel Storage page to work against the
production database. In production itself you set neither — Vercel provides
them.

## Development

```bash
npm run lint        # ESLint (Next.js rules)
npm run typecheck   # tsc --noEmit
npm test            # vitest unit tests
```

GitHub Actions runs all three plus `next build` on every push and PR.

## Good to know

- **Slugs** can contain lowercase letters, numbers, and dashes. `admin` and
  `api` are reserved so they can't shadow the real pages. Visitors who type
  `/Career` still land on `/career` — lookups are case-insensitive.
- **Redirects are temporary (HTTP 307) on purpose.** That way, if you ever
  repoint `/career` somewhere new, browsers won't keep using a cached old target.
- **Query params are forwarded.** `carolanne.link/career?utm_source=x` passes
  `utm_source=x` through to the destination (the internal `src=qr` marker is
  stripped).
- **Click counts mean humans.** Link-preview bots (iMessage, Slack, and other
  unfurlers) still show up in a link's event log, but don't bump its counters.
- **Saving a slug that already exists overwrites it** — that's how you update a
  link.
- **Unlocking creates a 30-day session**, refreshed every time you use it, so
  devices you actually use stay signed in. Log out to end one early.
- Password guesses are rate-limited (10/minute per IP), and passkey unlocks
  require Touch ID / Face ID / PIN — not just possession of the device.
- The password is still the root of trust. Make `ADMIN_PASSWORD` long, and if
  you ever think it leaked, change it in Vercel and redeploy.
