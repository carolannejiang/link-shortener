"use client";

import { useState } from "react";

type Links = Record<string, string>;

// The short-link domain, used only to render previews like carolanne.link/career.
// Falls back to whatever host the admin page is loaded from.
function shortHost() {
  if (typeof window !== "undefined") return window.location.host;
  return "carolanne.link";
}

export default function Admin() {
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [links, setLinks] = useState<Links>({});
  const [slug, setSlug] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Wrapper around fetch that always sends the password header and surfaces
  // a friendly error message.
  async function api(method: string, body?: unknown) {
    const res = await fetch("/api/links", {
      method,
      headers: {
        "content-type": "application/json",
        "x-admin-password": password,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
    return data;
  }

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { links } = await api("GET");
      setLinks(links ?? {});
      setUnlocked(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addLink(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await api("POST", { slug, url });
      setLinks((prev) => ({ ...prev, [data.slug]: data.url }));
      setSlug("");
      setUrl("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeLink(s: string) {
    if (!confirm(`Delete /${s}?`)) return;
    setError("");
    setBusy(true);
    try {
      await api("DELETE", { slug: s });
      setLinks((prev) => {
        const next = { ...prev };
        delete next[s];
        return next;
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const host = shortHost();
  const entries = Object.entries(links).sort(([a], [b]) => a.localeCompare(b));

  return (
    <main style={S.page}>
      <div style={S.card}>
        <h1 style={S.h1}>carolanne.link</h1>

        {!unlocked ? (
          <form onSubmit={unlock} style={S.form}>
            <label style={S.label}>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                style={S.input}
              />
            </label>
            <button type="submit" disabled={busy || !password} style={S.primary}>
              {busy ? "Checking…" : "Unlock"}
            </button>
          </form>
        ) : (
          <>
            <form onSubmit={addLink} style={S.form}>
              <label style={S.label}>
                Destination URL
                <input
                  type="url"
                  inputMode="url"
                  placeholder="https://example.com/a/very/long/url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  style={S.input}
                  required
                />
              </label>
              <label style={S.label}>
                Short name
                <div style={S.slugRow}>
                  <span style={S.slugPrefix}>{host}/</span>
                  <input
                    type="text"
                    placeholder="career"
                    value={slug}
                    onChange={(e) =>
                      setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
                    }
                    style={{ ...S.input, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}
                    required
                  />
                </div>
              </label>
              <button type="submit" disabled={busy || !slug || !url} style={S.primary}>
                {busy ? "Saving…" : "Save link"}
              </button>
            </form>

            <hr style={S.hr} />

            {entries.length === 0 ? (
              <p style={S.muted}>No links yet.</p>
            ) : (
              <ul style={S.list}>
                {entries.map(([s, u]) => (
                  <li key={s} style={S.item}>
                    <div style={{ minWidth: 0 }}>
                      <a
                        href={`/${s}`}
                        target="_blank"
                        rel="noreferrer"
                        style={S.shortLink}
                      >
                        {host}/{s}
                      </a>
                      <div style={S.dest} title={u}>
                        → {u}
                      </div>
                    </div>
                    <button
                      onClick={() => removeLink(s)}
                      disabled={busy}
                      style={S.delete}
                      aria-label={`Delete ${s}`}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {error && <p style={S.error}>{error}</p>}
      </div>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100dvh",
    display: "grid",
    placeItems: "start center",
    padding: "min(8vh, 4rem) 1rem",
  },
  card: { width: "100%", maxWidth: 560 },
  h1: { fontSize: "1.5rem", fontWeight: 600, margin: "0 0 1.5rem" },
  form: { display: "grid", gap: "1rem" },
  label: {
    display: "grid",
    gap: ".4rem",
    fontSize: ".85rem",
    color: "var(--muted)",
  },
  input: {
    width: "100%",
    padding: ".65rem .75rem",
    fontSize: "1rem",
    color: "var(--fg)",
    background: "var(--field-bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
  },
  slugRow: { display: "flex", alignItems: "stretch" },
  slugPrefix: {
    display: "flex",
    alignItems: "center",
    padding: "0 .6rem",
    fontSize: ".9rem",
    color: "var(--muted)",
    background: "var(--field-bg)",
    border: "1px solid var(--border)",
    borderRight: "none",
    borderRadius: "8px 0 0 8px",
    whiteSpace: "nowrap",
  },
  primary: {
    padding: ".65rem 1rem",
    fontSize: "1rem",
    fontWeight: 600,
    color: "var(--accent-fg)",
    background: "var(--accent)",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  },
  hr: { border: "none", borderTop: "1px solid var(--border)", margin: "1.5rem 0" },
  list: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: ".5rem" },
  item: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: ".75rem",
    padding: ".6rem .75rem",
    border: "1px solid var(--border)",
    borderRadius: 8,
  },
  shortLink: { fontWeight: 600, textDecoration: "none" },
  dest: {
    fontSize: ".8rem",
    color: "var(--muted)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  delete: {
    flexShrink: 0,
    padding: ".4rem .6rem",
    fontSize: ".8rem",
    color: "var(--danger)",
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 6,
    cursor: "pointer",
  },
  muted: { color: "var(--muted)" },
  error: {
    marginTop: "1rem",
    padding: ".6rem .75rem",
    fontSize: ".9rem",
    color: "var(--danger)",
    border: "1px solid var(--danger)",
    borderRadius: 8,
  },
};
