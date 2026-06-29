# carolanne.link — a private link shortener

A tiny Next.js app that turns long URLs into short ones under your own domain
(e.g. `carolanne.link/career`). One password-protected admin page lets you add
links from any browser; new links work the instant you save them.

## How it works (the whole thing in four pieces)

1. **`proxy.ts`** runs before every request. For a path like `/career` it looks
   the slug up in Redis and, if it exists, redirects to the real URL. This is
   what makes the short links work.
2. **`app/api/links/route.ts`** is the password-protected API that lists,
   creates, and deletes links. The password lives in an environment variable
   (`ADMIN_PASSWORD`) — never in the code.
3. **`app/admin/page.tsx`** is the page you actually use: type a password, paste
   a long URL, pick a short name, save.
4. **Redis** (added through the Vercel Marketplace) stores every link as one
   `slug → url` pair. It's the only piece that has to remember things.

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
cp .env.local.example .env.local      # then fill in the 3 values
npm install
npm run dev                           # open http://localhost:3000/admin
```

For local use you copy the two Redis values out of the Vercel Storage page into
`.env.local`. In production you don't — Vercel sets them for you.

## Good to know

- **Slugs** can contain lowercase letters, numbers, and dashes. `admin` and
  `api` are reserved so they can't shadow the real pages.
- **Redirects are temporary (HTTP 307) on purpose.** That way, if you ever
  repoint `/career` somewhere new, browsers won't keep using a cached old target.
- **Saving a slug that already exists overwrites it** — that's how you update a
  link.
- The only thing protecting your links is `ADMIN_PASSWORD`. Make it long, and if
  you ever think it leaked, change it in Vercel and redeploy.
