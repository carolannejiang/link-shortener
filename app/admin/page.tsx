"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import type { HitEvent as Hit, LinkInfo } from "@/lib/links";
import { isExpired } from "@/lib/links";
import { MobileDashboard } from "./mobile";
import { QrBlock } from "./qr-block";
import { StatsBlock } from "./stats-block";
import { S } from "./styles";

type Links = Record<string, LinkInfo>;

// Orderings for the links list. Each maps to a comparator below; ties (and
// links created before dates were tracked) fall back to name order.
const SORTS = {
  newest: "Newest",
  name: "Name",
  clicks: "Clicks",
  scans: "Scans",
} as const;
type SortKey = keyof typeof SORTS;

function compareLinks(sortBy: SortKey) {
  return ([aSlug, a]: [string, LinkInfo], [bSlug, b]: [string, LinkInfo]) => {
    if (sortBy === "newest" && b.created !== a.created) return b.created - a.created;
    if (sortBy === "clicks" && b.clicks !== a.clicks) return b.clicks - a.clicks;
    if (sortBy === "scans" && b.scans !== a.scans) return b.scans - a.scans;
    return aSlug.localeCompare(bSlug);
  };
}

// Short created-date label for a list row, e.g. "Jul 18" or "Jul 2025" once
// it's a year old. Links that predate date tracking have created === 0.
function createdLabel(ms: number): string | null {
  if (!ms) return null;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    ...(sameYear ? { day: "numeric" } : { year: "numeric" }),
  });
}

// Format a unix-ms timestamp for an <input type="datetime-local">, in the
// browser's local time. Empty string for "no expiry" (ms === 0).
function toLocalInput(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

// Read a datetime-local input value back into unix ms, or 0 when it's blank or
// unparseable (the "never expires" case).
function fromLocalInput(value: string): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

// Short label for a link's expiry: "expired" once past, otherwise "expires
// Jul 20". Returns null for links that never expire (expiresAt === 0).
function expiryLabel(ms: number): { text: string; past: boolean } | null {
  if (!ms) return null;
  if (isExpired(ms, Date.now())) return { text: "expired", past: true };
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const when = d.toLocaleDateString(undefined, {
    month: "short",
    ...(sameYear ? { day: "numeric" } : { year: "numeric" }),
  });
  return { text: `expires ${when}`, past: false };
}

// Phone-sized viewports get the mobile dashboard (composer + tappable list +
// details sheet) instead of the two-column desktop layout. False during
// prerendering; the real value lands with the first client render.
const MOBILE_QUERY = "(max-width: 640px)";

function subscribeToMedia(onChange: () => void) {
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribeToMedia,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}

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
  const isMobile = useIsMobile();
  const [booting, setBooting] = useState(true);
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [hasPasskey, setHasPasskey] = useState(false);
  const [links, setLinks] = useState<Links>({});
  const [slug, setSlug] = useState("");
  const [url, setUrl] = useState("");
  // Optional comma-separated tags for the new link.
  const [tags, setTags] = useState("");
  // The new-link form either takes a destination URL or combines the slug
  // with an existing link (it then follows that link's destination).
  const [mode, setMode] = useState<"url" | "combine">("url");
  const [combineWith, setCombineWith] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [statsFor, setStatsFor] = useState<string | null>(null);
  const [statsData, setStatsData] = useState<Record<string, Hit[]>>({});
  const [statsError, setStatsError] = useState<Record<string, boolean>>({});
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  // The link whose destination/expiry editor is open, plus its draft fields.
  const [editFor, setEditFor] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState("");
  const [editExpires, setEditExpires] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editParams, setEditParams] = useState("");
  // Slug most recently copied to the clipboard, for a transient "Copied ✓".
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  // Filters over the links list: a free-text query and an optional tag.
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // Remember the chosen ordering across visits. The links list only renders
  // after a client-side unlock, so the prerender never sees this value and
  // reading localStorage in the initializer is hydration-safe.
  const [sortBy, setSortBy] = useState<SortKey>(() => {
    if (typeof window === "undefined") return "newest";
    const saved = localStorage.getItem("linkSort");
    return saved && saved in SORTS ? (saved as SortKey) : "newest";
  });

  function changeSort(key: SortKey) {
    setSortBy(key);
    localStorage.setItem("linkSort", key);
  }

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
        // Only trust the body of an OK response — a 429/500 error body must
        // not be mistaken for "no passkey, not signed in".
        const status = statusRes.ok
          ? await statusRes.json().catch(() => ({}))
          : {};
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
      const optData = await optRes.json().catch(() => ({}));
      if (!optRes.ok) throw new Error(optData.error ?? "Couldn't start login.");

      const assertion = await startAuthentication({ optionsJSON: optData.options });

      const verRes = await fetch("/api/auth/login-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowId: optData.flowId, response: assertion }),
      });
      const verData = await verRes.json().catch(() => ({}));
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
      const optData = await optRes.json().catch(() => ({}));
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
      const verData = await verRes.json().catch(() => ({}));
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
      setEditFor(null);
      setCopiedSlug(null);
      setSearch("");
      setTagFilter(null);
      setStatsData({});
      setStatsError({});
      setBusy(false);
    }
  }

  // Create (or overwrite) a link. The desktop form submits via addLink below;
  // the mobile composer calls this directly with its URL + slug.
  async function submitLink(base: { slug: string; url?: string; aliasOf?: string }) {
    setError("");
    setBusy(true);
    try {
      // Omit blank tags so overwriting an existing slug keeps its stored tags.
      const data = await api("POST", { ...base, ...(tags.trim() ? { tags } : {}) });
      setLinks((prev) => ({
        ...prev,
        [data.slug]: {
          url: data.url,
          clicks: prev[data.slug]?.clicks ?? 0,
          scans: prev[data.slug]?.scans ?? 0,
          disabled: false,
          disabledAt: 0,
          note: prev[data.slug]?.note ?? "",
          created: prev[data.slug]?.created || Date.now(),
          expiresAt: data.expiresAt ?? 0,
          tags: data.tags ?? prev[data.slug]?.tags ?? [],
          params: prev[data.slug]?.params ?? "",
          aliasOf: data.aliasOf,
        },
      }));
      setSlug("");
      setUrl("");
      setTags("");
      setCombineWith("");
      setQrFor(data.slug); // reveal the QR code for the link we just made
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function addLink(e: React.FormEvent) {
    e.preventDefault();
    submitLink(mode === "combine" ? { slug, aliasOf: combineWith } : { slug, url });
  }

  // Fetch the recent per-hit events for one link into statsData. Used by the
  // desktop stats panel and the mobile details sheet / visit log alike; any
  // previously loaded list stays visible while the refresh is in flight.
  async function loadStats(s: string) {
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

  // Toggle the analytics panel for a link, fetching fresh data on every open.
  function toggleStats(s: string) {
    if (statsFor === s) {
      setStatsFor(null);
      return;
    }
    setStatsFor(s);
    loadStats(s);
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

  // Store a link's note. Reports success so callers (the desktop editor and
  // the mobile sheet) know whether to close their editing UI.
  async function saveNoteFor(s: string, rawNote: string): Promise<boolean> {
    setError("");
    setBusy(true);
    try {
      const note = rawNote.trim();
      await api("PATCH", { slug: s, note });
      setLinks((prev) => ({ ...prev, [s]: { ...prev[s], note } }));
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveNote(s: string) {
    if (await saveNoteFor(s, noteDraft)) setNoteFor(null);
  }

  // Repoint just the destination URL — the mobile sheet's "Edit destination".
  async function saveUrlFor(s: string, rawUrl: string): Promise<boolean> {
    setError("");
    setBusy(true);
    try {
      const data = await api("PATCH", { slug: s, url: rawUrl.trim() });
      setLinks((prev) => ({
        ...prev,
        [s]: { ...prev[s], url: data.url ?? prev[s].url },
      }));
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Open (or close) the destination/expiry editor for a link, seeding the
  // fields with its current values.
  function toggleEdit(s: string) {
    if (editFor === s) {
      setEditFor(null);
      return;
    }
    setEditUrl(links[s]?.url ?? "");
    setEditExpires(toLocalInput(links[s]?.expiresAt ?? 0));
    setEditTags((links[s]?.tags ?? []).join(", "));
    setEditParams(links[s]?.params ?? "");
    setEditFor(s);
  }

  async function saveEdit(s: string) {
    setError("");
    setBusy(true);
    try {
      const expiresAt = fromLocalInput(editExpires);
      // Combined links follow their target's URL, so only send a URL edit for
      // regular links; expiry, tags, and params always apply.
      const body: {
        slug: string;
        expiresAt: number;
        tags: string;
        params: string;
        url?: string;
      } = { slug: s, expiresAt, tags: editTags, params: editParams };
      if (!links[s]?.aliasOf) body.url = editUrl.trim();
      const data = await api("PATCH", body);
      setLinks((prev) => ({
        ...prev,
        [s]: {
          ...prev[s],
          url: data.url ?? prev[s].url,
          expiresAt,
          tags: data.tags ?? prev[s].tags,
          params: data.params ?? prev[s].params,
        },
      }));
      setEditFor(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Copy a link's full short URL to the clipboard, with a brief confirmation.
  async function copyShort(s: string) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/${s}`);
      setCopiedSlug(s);
      setTimeout(() => setCopiedSlug((cur) => (cur === s ? null : cur)), 1500);
    } catch {
      setError("Couldn't copy — your browser blocked clipboard access.");
    }
  }

  // Download the links currently shown (respecting the active filter and sort)
  // and their counters as a CSV, straight from the loaded list — no request.
  function exportCsv() {
    const cell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const header = [
      "short_url",
      "slug",
      "destination",
      "clicks",
      "scans",
      "disabled",
      "expires_at",
      "tags",
      "params",
      "combined_with",
      "note",
      "created",
    ];
    const rows = entries.map(([s, u]) =>
      [
        `${host}/${s}`,
        s,
        u.url,
        u.clicks,
        u.scans,
        u.disabled ? "yes" : "no",
        u.expiresAt ? new Date(u.expiresAt).toISOString() : "",
        u.tags.join(" "),
        u.params,
        u.aliasOf ?? "",
        u.note,
        u.created ? new Date(u.created).toISOString() : "",
      ]
        .map(cell)
        .join(","),
    );
    const csv = [header.map(cell).join(","), ...rows].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "links.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function toggleLink(s: string, disabled: boolean) {
    setError("");
    setBusy(true);
    try {
      await api("PATCH", { slug: s, disabled });
      setLinks((prev) => ({
        ...prev,
        [s]: {
          ...prev[s],
          disabled,
          // Mirror the server's stamp: set on disable (keeping an existing
          // one), cleared on enable.
          disabledAt: disabled ? prev[s].disabledAt || Date.now() : 0,
        },
      }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Delete a link (after a confirm). Reports whether it actually happened so
  // the mobile sheet knows whether to close.
  async function removeLink(s: string): Promise<boolean> {
    // Combined links that follow this one are deleted with it (the server
    // cascades), so the confirm names them up front.
    const dependents = Object.keys(links).filter((k) => links[k].aliasOf === s);
    const warning = dependents.length
      ? ` The combined link${dependents.length === 1 ? "" : "s"} ${dependents
          .map((d) => `/${d}`)
          .join(", ")} point${dependents.length === 1 ? "s" : ""} here and will be deleted too.`
      : "";
    if (!confirm(`Delete /${s}?${warning}`)) return false;
    setError("");
    setBusy(true);
    try {
      await api("DELETE", { slug: s });
      setLinks((prev) => {
        const next = { ...prev };
        delete next[s];
        for (const d of dependents) delete next[d];
        return next;
      });
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const host = shortHost();
  const hasLinks = Object.keys(links).length > 0;
  // Every tag in use, for the filter row.
  const allTags = [...new Set(Object.values(links).flatMap((l) => l.tags))].sort();
  // Apply the tag filter and free-text search, then the chosen ordering.
  const query = search.trim().toLowerCase();
  const entries = Object.entries(links)
    .filter(([s, u]) => {
      if (tagFilter && !u.tags.includes(tagFilter)) return false;
      if (query) {
        const haystack = `${s} ${u.url} ${u.note} ${u.tags.join(" ")} ${
          u.aliasOf ?? ""
        }`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    })
    .sort(compareLinks(sortBy));

  // Phones get the mobile dashboard once unlocked (the lock screen below is
  // already a single column). It shows every link — the desktop-only search
  // and tag filters don't apply — sorted the same way.
  if (unlocked && isMobile) {
    return (
      <MobileDashboard
        host={host}
        links={links}
        entries={Object.entries(links).sort(compareLinks(sortBy))}
        url={url}
        slug={slug}
        onUrl={setUrl}
        onSlug={(v) => setSlug(v.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
        sortBy={sortBy}
        sortOptions={Object.entries(SORTS)}
        onSort={(k) => changeSort(k as SortKey)}
        busy={busy}
        error={error}
        copiedSlug={copiedSlug}
        stats={statsData}
        statsErrors={statsError}
        onAdd={() => submitLink({ slug, url })}
        onCopy={copyShort}
        onLoadStats={loadStats}
        onToggle={toggleLink}
        onSaveNote={saveNoteFor}
        onSaveUrl={saveUrlFor}
        onDelete={removeLink}
        onLogout={logout}
      />
    );
  }

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
                  <div style={S.modeRow} role="tablist" aria-label="Link type">
                    <button
                      type="button"
                      onClick={() => setMode("url")}
                      style={mode === "url" ? S.modeBtnActive : S.modeBtn}
                      aria-pressed={mode === "url"}
                    >
                      New URL
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("combine")}
                      style={mode === "combine" ? S.modeBtnActive : S.modeBtn}
                      aria-pressed={mode === "combine"}
                    >
                      Combine links
                    </button>
                  </div>
                  {mode === "url" ? (
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
                  ) : (
                    <label style={S.label}>
                      Follows existing link
                      <select
                        value={combineWith}
                        onChange={(e) => setCombineWith(e.target.value)}
                        style={S.input}
                        required
                      >
                        <option value="">Choose a link…</option>
                        {Object.entries(links)
                          .filter(([, u]) => !u.aliasOf)
                          .sort(([a], [b]) => a.localeCompare(b))
                          .map(([s]) => (
                            <option key={s} value={s}>
                              /{s}
                            </option>
                          ))}
                      </select>
                      <span style={S.hint}>
                        The new link always redirects wherever the chosen link
                        points — even if you change it later.
                      </span>
                    </label>
                  )}
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
                  <label style={S.label}>
                    Tags (optional)
                    <input
                      type="text"
                      placeholder="comma-separated, e.g. job-search, social"
                      value={tags}
                      onChange={(e) => setTags(e.target.value)}
                      style={S.input}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={busy || (mode === "combine" ? !combineWith : !url)}
                    style={S.primary}
                  >
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
              <div style={S.listHeader}>
                <h2 style={{ ...S.sectionLabel, margin: 0 }}>
                  Links{entries.length > 0 && ` · ${entries.length}`}
                </h2>
                <div style={S.listHeaderTools}>
                  {entries.length > 0 && (
                    <button
                      type="button"
                      onClick={exportCsv}
                      style={S.secondaryBtn}
                    >
                      Export CSV
                    </button>
                  )}
                  {entries.length > 1 && (
                    <label style={S.sortLabel}>
                      Sort
                      <select
                        value={sortBy}
                        onChange={(e) => changeSort(e.target.value as SortKey)}
                        style={S.sortSelect}
                      >
                        {Object.entries(SORTS).map(([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              </div>
              {hasLinks && (
                <div style={S.filterBar}>
                  <input
                    type="search"
                    placeholder="Search links…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={S.filterInput}
                    aria-label="Search links"
                  />
                  {allTags.length > 0 && (
                    <div style={S.tagRow}>
                      <button
                        type="button"
                        onClick={() => setTagFilter(null)}
                        style={tagFilter === null ? S.tagChipActive : S.tagChip}
                      >
                        All
                      </button>
                      {allTags.map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() =>
                            setTagFilter((cur) => (cur === t ? null : t))
                          }
                          style={tagFilter === t ? S.tagChipActive : S.tagChip}
                        >
                          #{t}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {!hasLinks ? (
                <p style={S.muted}>No links yet — add one above to get started.</p>
              ) : entries.length === 0 ? (
                <p style={S.muted}>No links match your search or tag filter.</p>
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
                        {u.aliasOf && <span style={S.aliasTag}>combined</span>}
                        {u.disabled && <span style={S.disabledTag}>disabled</span>}
                        {(() => {
                          const ex = expiryLabel(u.expiresAt);
                          return ex ? (
                            <span style={ex.past ? S.disabledTag : S.expiryTag}>
                              {ex.text}
                            </span>
                          ) : null;
                        })()}
                        <span style={S.clicks}>
                          {u.clicks} {u.clicks === 1 ? "click" : "clicks"}
                          {u.scans > 0 &&
                            ` · ${u.scans} scan${u.scans === 1 ? "" : "s"}`}
                          {createdLabel(u.created) && ` · ${createdLabel(u.created)}`}
                        </span>
                      </div>
                      <div style={S.dest} title={u.url}>
                        {u.aliasOf
                          ? `↳ follows /${u.aliasOf} → ${u.url ? compactUrl(u.url) : "(missing)"}`
                          : `→ ${compactUrl(u.url)}`}
                      </div>
                      {u.note && <div style={S.note}>📝 {u.note}</div>}
                      {u.tags.length > 0 && (
                        <div style={S.tagRow}>
                          {u.tags.map((t) => (
                            <button
                              key={t}
                              type="button"
                              onClick={() =>
                                setTagFilter((cur) => (cur === t ? null : t))
                              }
                              style={tagFilter === t ? S.tagChipActive : S.tagChip}
                              aria-label={`Filter by tag ${t}`}
                            >
                              #{t}
                            </button>
                          ))}
                        </div>
                      )}
                      <div style={S.toolbar}>
                        <button
                          onClick={() => copyShort(s)}
                          disabled={busy}
                          style={S.secondaryBtn}
                          aria-label={`Copy short URL for ${s}`}
                        >
                          {copiedSlug === s ? "Copied ✓" : "Copy"}
                        </button>
                        <button
                          onClick={() => toggleStats(s)}
                          disabled={busy}
                          style={S.secondaryBtn}
                          aria-label={`${statsFor === s ? "Hide" : "Show"} stats for ${s}`}
                        >
                          {statsFor === s ? "Hide stats" : "Stats"}
                        </button>
                        <button
                          onClick={() => toggleEdit(s)}
                          disabled={busy}
                          style={S.secondaryBtn}
                          aria-label={`${editFor === s ? "Close" : "Open"} editor for ${s}`}
                        >
                          {editFor === s ? "Close edit" : "Edit"}
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
                      {editFor === s && (
                        <div style={S.noteEditor}>
                          {!u.aliasOf && (
                            <label style={S.label}>
                              Destination URL
                              <input
                                type="text"
                                inputMode="url"
                                value={editUrl}
                                onChange={(e) => setEditUrl(e.target.value)}
                                style={S.input}
                              />
                            </label>
                          )}
                          <label style={S.label}>
                            Tags
                            <input
                              type="text"
                              placeholder="comma-separated, e.g. job-search, social"
                              value={editTags}
                              onChange={(e) => setEditTags(e.target.value)}
                              style={S.input}
                            />
                          </label>
                          <label style={S.label}>
                            Default query params
                            <input
                              type="text"
                              inputMode="url"
                              placeholder="utm_source=resume&utm_medium=qr"
                              value={editParams}
                              onChange={(e) => setEditParams(e.target.value)}
                              style={S.input}
                            />
                            <span style={S.hint}>
                              Added to the destination on every redirect. A
                              visitor&apos;s own query params still win.
                            </span>
                          </label>
                          <label style={S.label}>
                            Expires (optional)
                            <input
                              type="datetime-local"
                              value={editExpires}
                              onChange={(e) => setEditExpires(e.target.value)}
                              style={S.input}
                            />
                            <span style={S.hint}>
                              After this time the link stops redirecting. Leave
                              blank so it never expires.
                            </span>
                          </label>
                          <div style={S.noteActions}>
                            {editExpires && (
                              <button
                                type="button"
                                onClick={() => setEditExpires("")}
                                disabled={busy}
                                style={{ ...S.secondaryBtn, marginRight: "auto" }}
                              >
                                Clear expiry
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => saveEdit(s)}
                              disabled={busy || (!u.aliasOf && !editUrl.trim())}
                              style={S.secondaryBtn}
                            >
                              {busy ? "Saving…" : "Save changes"}
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
