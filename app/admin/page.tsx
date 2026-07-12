"use client";

import { useEffect, useState } from "react";
import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import type { HitEvent as Hit, LinkInfo } from "@/lib/links";
import { QrBlock } from "./qr-block";
import { StatsBlock } from "./stats-block";
import { S } from "./styles";

type Links = Record<string, LinkInfo>;

// The short-link domain, used only to render previews like carolanne.link/career.
// Falls back to the production domain during prerendering.
function shortHost() {
  if (typeof window !== "undefined") return window.location.host;
  return "carolanne.link";
}

// The destination as shown in the links list: scheme stripped and capped, so
// a long URL doesn't dominate the row. Hovering the row (title attribute)
// still reveals the full URL.
function compactUrl(url: string, max = 60): string {
  const bare = url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return bare.length > max ? `${bare.slice(0, max - 1)}…` : bare;
}

// A friendly label for the passkey we're about to create, based on the device.
function deviceLabel() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/iphone/i.test(ua)) return "iPhone";
  // iPadOS reports itself as a Mac; the touch screen gives it away.
  const touches = typeof navigator !== "undefined" ? navigator.maxTouchPoints : 0;
  if (/ipad/i.test(ua) || (/mac/i.test(ua) && touches > 1)) return "iPad";
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
  const [statsError, setStatsError] = useState<Record<string, boolean>>({});
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  // Only send the password header while unlocking; once a session cookie
  // exists it does the authenticating and the password is wiped from state.
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
    if (res.status === 401 && !password) {
      // The session expired mid-use: drop back to the lock screen instead of
      // failing every button with a cryptic error.
      setUnlocked(false);
      throw new Error("Your session expired — unlock again.");
    }
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
      // Trade the password for a session cookie so the unlock survives
      // reloads, then stop sending the password anywhere.
      const res = await fetch("/api/auth/password-login", {
        method: "POST",
        headers: authHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Wrong password.");
      setPassword("");
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
      setQrFor(null);
      setStatsFor(null);
      setNoteFor(null);
      setStatsData({});
      setStatsError({});
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

  // Toggle the analytics panel for a link. Fetches fresh data on every open;
  // any previously loaded list stays visible while the refresh is in flight.
  async function toggleStats(s: string) {
    if (statsFor === s) {
      setStatsFor(null);
      return;
    }
    setStatsFor(s);
    setStatsError((prev) => ({ ...prev, [s]: false }));
    try {
      const res = await fetch(`/api/links?stats=${encodeURIComponent(s)}`, {
        headers: authHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error();
      const hits: Hit[] = (data.events ?? []).filter(Boolean);
      setStatsData((prev) => ({ ...prev, [s]: hits }));
    } catch {
      setStatsError((prev) => ({ ...prev, [s]: true }));
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
      <div style={unlocked ? S.card : S.cardNarrow}>
        <div style={S.header}>
          <h1 style={S.h1}>carolanne.link</h1>
          {unlocked && (
            <button onClick={logout} disabled={busy} style={S.textBtn}>
              Log out
            </button>
          )}
        </div>

        {info && (
          <p style={S.info} role="status">
            {info}
          </p>
        )}
        {error && (
          <p style={S.error} role="alert">
            {error}
          </p>
        )}

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
                  autoComplete="current-password"
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
          <div style={S.columns}>
            <div style={S.sidebar}>
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
            </div>

            <section style={{ ...S.section, ...S.mainCol }}>
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
                        → {compactUrl(u.url)}
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
                      {statsFor === s && (
                        <StatsBlock hits={statsData[s]} error={statsError[s]} />
                      )}
                      {qrFor === s && <QrBlock slug={s} />}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
