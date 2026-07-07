"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";

type Link = {
  url: string;
  clicks: number;
  scans: number;
  disabled: boolean;
  note: string;
};
type Links = Record<string, Link>;

type Hit = {
  t: number;
  src: "qr" | "direct";
  device: string;
  os: string;
  browser: string;
  model?: string;
  ref?: string;
  country?: string;
  city?: string;
};

// The short-link domain, used only to render previews like carolanne.link/career.
// Falls back to whatever host the admin page is loaded from.
function shortHost() {
  if (typeof window !== "undefined") return window.location.host;
  return "carolanne.link";
}

// The full origin (scheme + host) used to build absolute QR-code URLs.
function shortOrigin() {
  if (typeof window !== "undefined") return window.location.origin;
  return "https://carolanne.link";
}

// The value a link's QR code encodes: the absolute short URL, tagged with
// ?src=qr so the proxy can count scans separately from ordinary clicks.
function qrValue(slug: string) {
  return `${shortOrigin()}/${slug}?src=qr`;
}

// A QR code (PNG) for one link. It's copied to the clipboard automatically when
// it appears, with buttons to copy again or download it.
function QrBlock({ slug }: { slug: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("");

  function canvasPng(): Promise<Blob | null> {
    const canvas = ref.current?.querySelector("canvas");
    if (!canvas) return Promise.resolve(null);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  async function copy() {
    try {
      const blob = await canvasPng();
      if (!blob) throw new Error("no image");
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      setStatus("Copied to clipboard ✓");
    } catch {
      // Browsers block clipboard writes without a fresh click / when the tab
      // isn't focused — fall back to asking the user to press the button.
      setStatus('Press "Copy PNG" to copy');
    }
  }

  async function download() {
    const canvas = ref.current?.querySelector("canvas");
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${slug}-qr.png`;
    a.click();
  }

  // Best-effort auto-copy as soon as the code renders.
  useEffect(() => {
    copy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={S.qrBlock}>
      <div ref={ref} style={S.qrCanvas}>
        <QRCodeCanvas value={qrValue(slug)} size={148} marginSize={2} />
      </div>
      <div style={S.actions}>
        <button type="button" onClick={copy} style={S.secondaryBtn}>
          Copy PNG
        </button>
        <button type="button" onClick={download} style={S.secondaryBtn}>
          Download PNG
        </button>
      </div>
      {status && <span style={S.hitMeta}>{status}</span>}
    </div>
  );
}

// Format a hit timestamp compactly, e.g. "Jul 6, 2:04 PM".
function fmtTime(t: number): string {
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Count hits by one field, biggest first: [["mobile", 12], ["desktop", 3]].
function tally(hits: Hit[], key: keyof Hit): [string, number][] {
  const counts: Record<string, number> = {};
  for (const h of hits) {
    const v = String(h[key] ?? "unknown");
    counts[v] = (counts[v] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function place(h: Hit): string {
  return [h.city, h.country].filter(Boolean).join(", ");
}

// The expandable analytics panel for one link: a few breakdowns plus a list of
// the most recent hits.
function StatsBlock({ hits }: { hits: Hit[] | undefined }) {
  if (hits === undefined) return <div style={S.statsBlock}>Loading…</div>;
  if (hits.length === 0)
    return <div style={S.statsBlock}>No visits recorded yet.</div>;

  const devices = tally(hits, "device");

  return (
    <div style={S.statsBlock}>
      <div style={S.chips}>
        {devices.map(([name, n]) => (
          <span key={name} style={S.chip}>
            {name} {n}
          </span>
        ))}
      </div>
      <div style={S.hitList}>
        {hits.slice(0, 25).map((h, i) => (
          <div key={i} style={S.hitRow}>
            <span style={S.hitTime}>{fmtTime(h.t)}</span>
            <span>
              {h.device} · {h.os} · {h.browser}
            </span>
            <span style={S.hitMeta}>
              {[h.model, place(h), h.ref, h.src === "qr" ? "QR" : null]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        ))}
      </div>
      {hits.length > 25 && (
        <div style={S.hitMeta}>Showing 25 of {hits.length} recent hits.</div>
      )}
    </div>
  );
}

// A friendly label for the passkey we're about to create, based on the device.
function deviceLabel() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/iphone/i.test(ua)) return "iPhone";
  if (/ipad/i.test(ua)) return "iPad";
  if (/android/i.test(ua)) return "Android phone";
  if (/mac/i.test(ua)) return "Mac";
  if (/windows/i.test(ua)) return "Windows PC";
  return "This device";
}

// Turn WebAuthn/browser errors into something readable. Cancelling Touch ID
// throws a NotAllowedError, which we don't want to show raw.
function friendly(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === "NotAllowedError") return "Cancelled or timed out.";
  return e?.message ?? "Something went wrong.";
}

export default function Admin() {
  const [booting, setBooting] = useState(true);
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [hasPasskey, setHasPasskey] = useState(false);
  const [links, setLinks] = useState<Links>({});
  const [slug, setSlug] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [statsFor, setStatsFor] = useState<string | null>(null);
  const [statsData, setStatsData] = useState<Record<string, Hit[]>>({});
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  // Only send the password header when we actually have a password typed in;
  // otherwise the session cookie does the authenticating.
  function authHeaders(): Record<string, string> {
    return password ? { "x-admin-password": password } : {};
  }

  // Wrapper around the links API that surfaces a friendly error message.
  async function api(method: string, body?: unknown) {
    const res = await fetch("/api/links", {
      method,
      headers: {
        "content-type": "application/json",
        ...authHeaders(),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
    return data;
  }

  async function loadLinks() {
    const { links } = await api("GET");
    setLinks(links ?? {});
    setUnlocked(true);
  }

  // On load, ask the server whether a passkey exists and whether we're already
  // signed in (via a session cookie from a previous visit). The links list is
  // fetched at the same time as the status check — it just 401s harmlessly
  // when we aren't signed in — so a returning visit costs one round trip.
  useEffect(() => {
    (async () => {
      try {
        const [statusRes, linksRes] = await Promise.all([
          fetch("/api/auth/status"),
          fetch("/api/links"),
        ]);
        const status = await statusRes.json().catch(() => ({}));
        setHasPasskey(Boolean(status.hasPasskey));
        if (status.authenticated && linksRes.ok) {
          const data = await linksRes.json().catch(() => ({}));
          setLinks(data.links ?? {});
          setUnlocked(true);
        }
      } catch {
        // Ignore — the user can still unlock manually.
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  async function unlockWithPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await loadLinks();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function unlockWithTouchID() {
    setError("");
    setBusy(true);
    try {
      const optRes = await fetch("/api/auth/login-options", { method: "POST" });
      const optData = await optRes.json();
      if (!optRes.ok) throw new Error(optData.error ?? "Couldn't start login.");

      const assertion = await startAuthentication({ optionsJSON: optData.options });

      const verRes = await fetch("/api/auth/login-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowId: optData.flowId, response: assertion }),
      });
      const verData = await verRes.json();
      if (!verRes.ok || !verData.verified) {
        throw new Error(verData.error ?? "Passkey login failed.");
      }

      await loadLinks(); // session cookie is now set
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  }

  async function setupTouchID() {
    setError("");
    setInfo("");
    setBusy(true);
    try {
      const optRes = await fetch("/api/auth/register-options", {
        method: "POST",
        headers: authHeaders(),
      });
      const optData = await optRes.json();
      if (!optRes.ok) throw new Error(optData.error ?? "Couldn't start setup.");

      const attestation = await startRegistration({ optionsJSON: optData.options });

      const verRes = await fetch("/api/auth/register-verify", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          flowId: optData.flowId,
          response: attestation,
          label: deviceLabel(),
        }),
      });
      const verData = await verRes.json();
      if (!verRes.ok || !verData.verified) {
        throw new Error(verData.error ?? "Passkey setup failed.");
      }

      setHasPasskey(true);
      setInfo("Touch ID is set up on this device. You can use it to unlock next time.");
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Best effort.
    } finally {
      setUnlocked(false);
      setPassword("");
      setLinks({});
      setInfo("");
      setBusy(false);
    }
  }

  async function addLink(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await api("POST", { slug, url });
      setLinks((prev) => ({
        ...prev,
        [data.slug]: {
          url: data.url,
          clicks: prev[data.slug]?.clicks ?? 0,
          scans: prev[data.slug]?.scans ?? 0,
          disabled: false,
          note: prev[data.slug]?.note ?? "",
        },
      }));
      setSlug("");
      setUrl("");
      setQrFor(data.slug); // reveal the QR code for the link we just made
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Toggle the analytics panel for a link, lazily fetching its hit log the
  // first time it's opened.
  async function toggleStats(s: string) {
    if (statsFor === s) {
      setStatsFor(null);
      return;
    }
    setStatsFor(s);
    if (statsData[s]) return; // already loaded
    try {
      const res = await fetch(`/api/links?stats=${encodeURIComponent(s)}`, {
        headers: authHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const hits: Hit[] = (data.events ?? []).filter(Boolean);
        setStatsData((prev) => ({ ...prev, [s]: hits }));
      }
    } catch {
      // Leave it in the loading state; the user can retry by toggling.
    }
  }

  // Open (or close) the note editor for a link, seeding the textarea with its
  // current note.
  function toggleNote(s: string) {
    if (noteFor === s) {
      setNoteFor(null);
      return;
    }
    setNoteDraft(links[s]?.note ?? "");
    setNoteFor(s);
  }

  async function saveNote(s: string) {
    setError("");
    setBusy(true);
    try {
      const note = noteDraft.trim();
      await api("PATCH", { slug: s, note });
      setLinks((prev) => ({ ...prev, [s]: { ...prev[s], note } }));
      setNoteFor(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleLink(s: string, disabled: boolean) {
    setError("");
    setBusy(true);
    try {
      await api("PATCH", { slug: s, disabled });
      setLinks((prev) => ({ ...prev, [s]: { ...prev[s], disabled } }));
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
        <div style={S.header}>
          <h1 style={S.h1}>carolanne.link</h1>
          {unlocked && (
            <button onClick={logout} disabled={busy} style={S.textBtn}>
              Log out
            </button>
          )}
        </div>

        {booting ? (
          <p style={S.muted}>Loading…</p>
        ) : !unlocked ? (
          <div style={S.form}>
            {hasPasskey && (
              <>
                <button
                  type="button"
                  onClick={unlockWithTouchID}
                  disabled={busy}
                  style={S.primary}
                >
                  {busy ? "Waiting for Touch ID…" : "🔓 Unlock with Touch ID"}
                </button>
                <div style={S.divider}>
                  <span style={S.dividerText}>or use your password</span>
                </div>
              </>
            )}

            <form onSubmit={unlockWithPassword} style={S.form}>
              <label style={S.label}>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus={!hasPasskey}
                  style={S.input}
                />
              </label>
              <button
                type="submit"
                disabled={busy || !password}
                style={hasPasskey ? S.secondary : S.primary}
              >
                {busy ? "Checking…" : "Unlock"}
              </button>
            </form>
          </div>
        ) : (
          <>
            <section style={S.section}>
              <h2 style={S.sectionLabel}>New link</h2>
              <form onSubmit={addLink} style={S.form}>
                <label style={S.label}>
                  Destination URL
                  <input
                    type="text"
                    inputMode="url"
                    placeholder="example.com/a/very/long/url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    style={S.input}
                    required
                  />
                </label>
                <label style={S.label}>
                  Short name (optional)
                  <div style={S.slugRow}>
                    <span style={S.slugPrefix}>{host}/</span>
                    <input
                      type="text"
                      placeholder="leave blank for a random one"
                      value={slug}
                      onChange={(e) =>
                        setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
                      }
                      style={{ ...S.input, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}
                    />
                  </div>
                </label>
                <button type="submit" disabled={busy || !url} style={S.primary}>
                  {busy ? "Saving…" : "Save link"}
                </button>
              </form>
            </section>

            <section style={S.section}>
              <h2 style={S.sectionLabel}>
                Links{entries.length > 0 && ` · ${entries.length}`}
              </h2>
              {entries.length === 0 ? (
                <p style={S.muted}>No links yet — add one above to get started.</p>
              ) : (
                <ul style={S.list}>
                  {entries.map(([s, u]) => (
                    <li key={s} style={{ ...S.item, opacity: u.disabled ? 0.6 : 1 }}>
                      <div style={S.itemHead}>
                        <a
                          href={`/${s}`}
                          target="_blank"
                          rel="noreferrer"
                          style={S.shortLink}
                        >
                          {host}/{s}
                        </a>
                        {u.disabled && <span style={S.disabledTag}>disabled</span>}
                        <span style={S.clicks}>
                          {u.clicks} {u.clicks === 1 ? "click" : "clicks"}
                          {u.scans > 0 &&
                            ` · ${u.scans} scan${u.scans === 1 ? "" : "s"}`}
                        </span>
                      </div>
                      <div style={S.dest} title={u.url}>
                        → {u.url}
                      </div>
                      {u.note && <div style={S.note}>📝 {u.note}</div>}
                      <div style={S.toolbar}>
                        <button
                          onClick={() => toggleStats(s)}
                          disabled={busy}
                          style={S.secondaryBtn}
                          aria-label={`${statsFor === s ? "Hide" : "Show"} stats for ${s}`}
                        >
                          {statsFor === s ? "Hide stats" : "Stats"}
                        </button>
                        <button
                          onClick={() => toggleNote(s)}
                          disabled={busy}
                          style={S.secondaryBtn}
                          aria-label={`${noteFor === s ? "Close" : "Edit"} note for ${s}`}
                        >
                          {noteFor === s ? "Close note" : u.note ? "Edit note" : "Note"}
                        </button>
                        <button
                          onClick={() => setQrFor((cur) => (cur === s ? null : s))}
                          disabled={busy}
                          style={S.secondaryBtn}
                          aria-label={`${qrFor === s ? "Hide" : "Show"} QR code for ${s}`}
                        >
                          {qrFor === s ? "Hide QR" : "QR"}
                        </button>
                        <button
                          onClick={() => toggleLink(s, !u.disabled)}
                          disabled={busy}
                          style={S.secondaryBtn}
                          aria-label={`${u.disabled ? "Enable" : "Disable"} ${s}`}
                        >
                          {u.disabled ? "Enable" : "Disable"}
                        </button>
                        <button
                          onClick={() => removeLink(s)}
                          disabled={busy}
                          style={{ ...S.delete, marginLeft: "auto" }}
                          aria-label={`Delete ${s}`}
                        >
                          Delete
                        </button>
                      </div>
                      {noteFor === s && (
                      <div style={S.noteEditor}>
                        <textarea
                          value={noteDraft}
                          onChange={(e) => setNoteDraft(e.target.value)}
                          placeholder="Private note about this link — only you see it here."
                          rows={3}
                          maxLength={2000}
                          style={S.textarea}
                        />
                        <div style={S.noteActions}>
                          <button
                            type="button"
                            onClick={() => saveNote(s)}
                            disabled={busy}
                            style={S.secondaryBtn}
                          >
                            {busy ? "Saving…" : "Save note"}
                          </button>
                        </div>
                      </div>
                    )}
                    {statsFor === s && <StatsBlock hits={statsData[s]} />}
                    {qrFor === s && <QrBlock slug={s} />}
                  </li>
                ))}
              </ul>
            )}
            </section>

            <div style={S.footer}>
              <span style={S.muted}>
                {hasPasskey
                  ? "Touch ID is available on registered devices."
                  : "Skip the password next time:"}
              </span>
              <button
                type="button"
                onClick={setupTouchID}
                disabled={busy}
                style={S.secondary}
              >
                {hasPasskey ? "Add this device to Touch ID" : "Set up Touch ID"}
              </button>
            </div>
          </>
        )}

        {info && <p style={S.info}>{info}</p>}
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
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    margin: "0 0 1.5rem",
  },
  h1: { fontSize: "1.5rem", fontWeight: 600, margin: 0 },
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
  secondary: {
    padding: ".55rem .9rem",
    fontSize: ".9rem",
    fontWeight: 600,
    color: "var(--fg)",
    background: "var(--field-bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    cursor: "pointer",
  },
  textBtn: {
    padding: ".3rem .5rem",
    fontSize: ".85rem",
    color: "var(--muted)",
    background: "transparent",
    border: "none",
    cursor: "pointer",
  },
  divider: {
    display: "grid",
    placeItems: "center",
    position: "relative",
    margin: ".25rem 0",
  },
  dividerText: {
    fontSize: ".8rem",
    color: "var(--muted)",
    background: "var(--bg, #000)",
    padding: "0 .6rem",
  },
  section: { marginBottom: "1.75rem" },
  sectionLabel: {
    fontSize: ".7rem",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: ".07em",
    color: "var(--muted)",
    margin: "0 0 .75rem",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: ".75rem",
    flexWrap: "wrap",
    paddingTop: "1.25rem",
    borderTop: "1px solid var(--border)",
    fontSize: ".85rem",
  },
  list: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: ".5rem" },
  item: {
    display: "flex",
    flexDirection: "column",
    gap: ".55rem",
    padding: ".75rem .85rem",
    border: "1px solid var(--border)",
    borderRadius: 8,
  },
  itemHead: {
    display: "flex",
    alignItems: "center",
    gap: ".5rem",
    flexWrap: "wrap",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: ".4rem",
    flexWrap: "wrap",
  },
  qrBlock: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: ".6rem",
    paddingTop: ".25rem",
  },
  qrCanvas: {
    padding: ".6rem",
    background: "#fff",
    borderRadius: 8,
    lineHeight: 0,
  },
  statsBlock: {
    display: "flex",
    flexDirection: "column",
    gap: ".6rem",
    paddingTop: ".25rem",
    fontSize: ".8rem",
    color: "var(--muted)",
  },
  chips: { display: "flex", flexWrap: "wrap", gap: ".35rem" },
  chip: {
    padding: ".15rem .5rem",
    background: "var(--field-bg)",
    border: "1px solid var(--border)",
    borderRadius: 999,
    fontSize: ".75rem",
    color: "var(--fg)",
  },
  hitList: { display: "grid", gap: ".25rem" },
  hitRow: {
    display: "grid",
    gap: ".1rem",
    padding: ".35rem 0",
    borderTop: "1px solid var(--border)",
  },
  hitTime: { color: "var(--fg)", fontWeight: 600 },
  hitMeta: { fontSize: ".75rem", color: "var(--muted)" },
  shortLink: { fontWeight: 600, textDecoration: "none" },
  clicks: {
    marginLeft: "auto",
    fontSize: ".75rem",
    color: "var(--muted)",
    whiteSpace: "nowrap",
  },
  disabledTag: {
    fontSize: ".7rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: ".03em",
    color: "var(--danger)",
    border: "1px solid var(--danger)",
    borderRadius: 4,
    padding: "0 .35rem",
  },
  actions: { display: "flex", gap: ".4rem", flexShrink: 0 },
  secondaryBtn: {
    padding: ".4rem .6rem",
    fontSize: ".8rem",
    color: "var(--fg)",
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 6,
    cursor: "pointer",
  },
  dest: {
    fontSize: ".8rem",
    color: "var(--muted)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  note: {
    fontSize: ".8rem",
    color: "var(--fg)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  noteEditor: {
    display: "flex",
    flexDirection: "column",
    gap: ".5rem",
    paddingTop: ".25rem",
  },
  noteActions: { display: "flex", justifyContent: "flex-end" },
  textarea: {
    width: "100%",
    padding: ".65rem .75rem",
    fontSize: ".9rem",
    fontFamily: "inherit",
    color: "var(--fg)",
    background: "var(--field-bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    resize: "vertical",
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
  info: {
    marginTop: "1rem",
    padding: ".6rem .75rem",
    fontSize: ".9rem",
    color: "var(--accent)",
    border: "1px solid var(--accent)",
    borderRadius: 8,
  },
  error: {
    marginTop: "1rem",
    padding: ".6rem .75rem",
    fontSize: ".9rem",
    color: "var(--danger)",
    border: "1px solid var(--danger)",
    borderRadius: 8,
  },
};
