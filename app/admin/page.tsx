"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import type { HitEvent as Hit, LinkInfo } from "@/lib/links";
import { isExpired, RESERVED } from "@/lib/links";
import { MobileDashboard } from "./mobile";
import { QrPanel } from "./qr-block";
import { StatsCard } from "./stats-card";
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

// Short created-date label, e.g. "Jul 18" or "Jul 2025" once it's a year old.
// Links that predate date tracking have created === 0.
function createdLabel(ms: number): string | null {
  if (!ms) return null;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    ...(sameYear ? { day: "numeric" } : { year: "numeric" }),
  });
}

// Phone-sized viewports get the mobile dashboard (composer + tappable list +
// details sheet) instead of the two-pane desktop layout. False during
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

// The destination as displayed: scheme and trailing slash stripped; the
// nowrap/ellipsis styles do the truncating.
function bareUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

// Keep slugs to the characters the server accepts as the user types.
function sanitizeSlug(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

// Why a slug can't be used for a new link, or null when it's free. The whole
// links list is already loaded, so availability is a local check.
function slugProblem(slug: string, links: Links): "taken" | "reserved" | null {
  if (RESERVED.has(slug)) return "reserved";
  if (links[slug]) return "taken";
  return null;
}

// True for a link that's off — disabled, or past its expiry — which the list
// and detail header mark with the "off" badge. (Helper so render stays pure
// per the hooks linter.)
function isOff(u: LinkInfo): boolean {
  return u.disabled || isExpired(u.expiresAt, Date.now());
}

// Debounce before flagging a half-typed slug as taken, per the design.
const SLUG_CHECK_MS = 400;

// How long "✓ Copied" confirmations stay before reverting.
const COPY_REVERT_MS = 2000;

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
  // The create form: destination, optional slug, and its inline states.
  const [slug, setSlug] = useState("");
  const [url, setUrl] = useState("");
  const [slugTaken, setSlugTaken] = useState<"taken" | "reserved" | null>(null);
  const [formError, setFormError] = useState("");
  // The slug of the link just created, for the green "Saved" banner.
  const [savedSlug, setSavedSlug] = useState<string | null>(null);
  // The link shown in the detail pane, mirrored to ?link= in the URL.
  const [selected, setSelected] = useState<string | null>(null);
  const [editingDest, setEditingDest] = useState(false);
  const [destDraft, setDestDraft] = useState("");
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  // Slug most recently copied to the clipboard, for a transient "✓ Copied".
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [statsData, setStatsData] = useState<Record<string, Hit[]>>({});
  const [statsError, setStatsError] = useState<Record<string, boolean>>({});
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

  // Fetch the recent per-hit events for one link into statsData. Used by the
  // desktop stats card and the mobile details sheet / visit log alike; any
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

  // Show a link in the detail pane, closing any inline editors, and reflect
  // the choice in the URL so reloads and the visits page's "Back" land here.
  function select(s: string) {
    setSelected(s);
    setEditingDest(false);
    setEditingNote(false);
    setConfirmingDelete(false);
    loadStats(s);
    window.history.replaceState(null, "", `/admin?link=${encodeURIComponent(s)}`);
  }

  // First selection after the links load: the ?link= slug if it exists,
  // otherwise the top of the list. Leaves the URL untouched.
  function initSelection(loaded: Links) {
    const param = new URLSearchParams(window.location.search).get("link");
    const pick =
      param && loaded[param]
        ? param
        : Object.entries(loaded).sort(compareLinks(sortBy))[0]?.[0];
    if (pick) {
      setSelected(pick);
      loadStats(pick);
    }
  }

  async function loadLinks() {
    const { links } = await api("GET");
    setLinks(links ?? {});
    setUnlocked(true);
    initSelection(links ?? {});
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
          initSelection(data.links ?? {});
        }
      } catch {
        // Ignore — the user can still unlock manually.
      } finally {
        setBooting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Availability check for the typed slug: cleared on every keystroke (in the
  // input's onChange), re-flagged here once typing pauses.
  useEffect(() => {
    if (!slug) return;
    const id = window.setTimeout(
      () => setSlugTaken(slugProblem(slug, links)),
      SLUG_CHECK_MS,
    );
    return () => window.clearTimeout(id);
  }, [slug, links]);

  // Esc or a click anywhere outside the confirm row backs out of a delete.
  useEffect(() => {
    if (!confirmingDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmingDelete(false);
    };
    const onDown = (e: PointerEvent) => {
      if (confirmRef.current && !confirmRef.current.contains(e.target as Node)) {
        setConfirmingDelete(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [confirmingDelete]);

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
      setInfo("Touch ID is set up on this device.");
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
      setError("");
      setFormError("");
      setSlugTaken(null);
      setSavedSlug(null);
      setSelected(null);
      setEditingDest(false);
      setEditingNote(false);
      setConfirmingDelete(false);
      setCopiedSlug(null);
      setStatsData({});
      setStatsError({});
      setBusy(false);
      window.history.replaceState(null, "", "/admin");
    }
  }

  // Create a link. The desktop form submits via addLink below; the mobile
  // composer calls this directly with its URL + slug.
  async function submitLink(base: { slug: string; url?: string; aliasOf?: string }) {
    setError("");
    setFormError("");
    setSavedSlug(null);
    setBusy(true);
    try {
      const data = await api("POST", base);
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
      setSlugTaken(null);
      setSavedSlug(data.slug);
      if (!isMobile) select(data.slug);
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function addLink(e: React.FormEvent) {
    e.preventDefault();
    // Re-check availability synchronously in case the debounce hadn't fired.
    const problem = slug ? slugProblem(slug, links) : null;
    if (problem) {
      setSlugTaken(problem);
      return;
    }
    if (busy || !url.trim()) return;
    submitLink({ slug, url });
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

  // Repoint just the destination URL, leaving the slug and stats untouched.
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

  function startEditDest() {
    if (!selected) return;
    setDestDraft(links[selected]?.url ?? "");
    setEditingDest(true);
  }

  async function saveDest() {
    if (!selected || !destDraft.trim()) return;
    if (await saveUrlFor(selected, destDraft)) setEditingDest(false);
  }

  function startEditNote() {
    if (!selected) return;
    setNoteDraft(links[selected]?.note ?? "");
    setEditingNote(true);
  }

  async function saveNote() {
    if (!selected) return;
    if (await saveNoteFor(selected, noteDraft)) setEditingNote(false);
  }

  // Copy a link's full short URL to the clipboard, with a brief confirmation.
  async function copyShort(s: string) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/${s}`);
      setCopiedSlug(s);
      setTimeout(
        () => setCopiedSlug((cur) => (cur === s ? null : cur)),
        COPY_REVERT_MS,
      );
    } catch {
      setError("Couldn't copy — your browser blocked clipboard access.");
    }
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

  // Delete a link (already confirmed). Combined links that follow it are
  // deleted with it (the server cascades). Moves the selection to the next
  // link in the list, or clears it when none remain.
  async function performDelete(s: string): Promise<boolean> {
    const dependents = Object.keys(links).filter((k) => links[k].aliasOf === s);
    setError("");
    setBusy(true);
    try {
      await api("DELETE", { slug: s });
      const gone = new Set([s, ...dependents]);
      setLinks((prev) => {
        const next = { ...prev };
        for (const g of gone) delete next[g];
        return next;
      });
      setConfirmingDelete(false);
      // A "Saved" banner pointing at a now-deleted link would offer to copy
      // a dead URL.
      setSavedSlug((cur) => (cur && gone.has(cur) ? null : cur));
      if (selected && gone.has(selected)) {
        const remaining = entries.map(([k]) => k).filter((k) => !gone.has(k));
        const idx = entries.findIndex(([k]) => k === selected);
        const next = remaining.length
          ? remaining[Math.min(Math.max(idx, 0), remaining.length - 1)]
          : null;
        if (next) select(next);
        else {
          setSelected(null);
          window.history.replaceState(null, "", "/admin");
        }
      }
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  // The mobile sheet confirms with a native dialog; the desktop confirms
  // inline in the action row instead.
  async function removeLink(s: string): Promise<boolean> {
    const dependents = Object.keys(links).filter((k) => links[k].aliasOf === s);
    const warning = dependents.length
      ? ` The combined link${dependents.length === 1 ? "" : "s"} ${dependents
          .map((d) => `/${d}`)
          .join(", ")} point${dependents.length === 1 ? "s" : ""} here and will be deleted too.`
      : "";
    if (!confirm(`Delete /${s}?${warning}`)) return false;
    return performDelete(s);
  }

  const host = shortHost();
  const entries = Object.entries(links).sort(compareLinks(sortBy));
  const hasLinks = entries.length > 0;
  const current = selected ? links[selected] : undefined;

  // Phones get the mobile dashboard once unlocked (the lock screen below is
  // already a single column).
  if (unlocked && isMobile) {
    return (
      <MobileDashboard
        host={host}
        links={links}
        entries={entries}
        url={url}
        slug={slug}
        onUrl={setUrl}
        onSlug={(v) => setSlug(sanitizeSlug(v))}
        sortBy={sortBy}
        sortOptions={Object.entries(SORTS)}
        onSort={(k) => changeSort(k as SortKey)}
        busy={busy}
        error={error || formError}
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

  if (!unlocked) {
    return (
      <main style={S.page}>
        <div style={S.cardNarrow}>
          <div style={S.header}>
            <h1 style={S.h1}>carolanne.link</h1>
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
          ) : (
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
          )}
        </div>
      </main>
    );
  }

  const currentOff = current && isOff(current);

  return (
    <main style={S.shell}>
      <aside style={S.sidebar}>
        <div style={S.sideHead}>
          <div style={S.sideTitleRow}>
            <h1 style={S.sideTitle}>{host}</h1>
            <button onClick={logout} disabled={busy} style={S.textBtn}>
              Log out
            </button>
          </div>
          <form onSubmit={addLink} style={S.createForm}>
            <input
              type="text"
              inputMode="url"
              className="field"
              placeholder="Paste a destination URL"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setFormError("");
              }}
              readOnly={busy}
              style={{ ...S.createInput, ...(busy ? S.inputBusy : {}) }}
              aria-label="Destination URL"
            />
            <div style={S.slugRow}>
              <span
                style={{ ...S.slugPrefix, ...(slugTaken ? S.fieldError : {}) }}
              >
                {host}/
              </span>
              <input
                type="text"
                className="field"
                placeholder="leave blank for random"
                value={slug}
                onChange={(e) => {
                  setSlug(sanitizeSlug(e.target.value));
                  setSlugTaken(null);
                  setFormError("");
                }}
                onBlur={() => slug && setSlugTaken(slugProblem(slug, links))}
                readOnly={busy}
                style={{
                  ...S.slugInput,
                  ...(slugTaken ? S.fieldError : {}),
                  ...(busy ? S.inputBusy : {}),
                }}
                aria-label="Short name (optional)"
              />
            </div>
            {slugTaken === "taken" && (
              <div style={S.slugErrorText} role="alert">
                /{slug} is already in use —{" "}
                <button
                  type="button"
                  onClick={() => select(slug)}
                  style={S.inlineLinkBtn}
                >
                  edit that link
                </button>{" "}
                or pick another name.
              </div>
            )}
            {slugTaken === "reserved" && (
              <div style={S.slugErrorText} role="alert">
                &ldquo;{slug}&rdquo; is reserved and can&apos;t be used as a
                link name.
              </div>
            )}
            <button
              type="submit"
              disabled={busy || !url.trim() || slugTaken !== null}
              style={{
                ...S.saveBtn,
                ...(busy ? S.saveBtnBusy : {}),
                ...(!busy && (!url.trim() || slugTaken) ? S.saveBtnDisabled : {}),
              }}
            >
              {busy ? (
                <>
                  <span className="spinner" aria-hidden />
                  Saving…
                </>
              ) : (
                "Save link"
              )}
            </button>
            {formError && (
              <div style={S.formError} role="alert">
                {formError}
              </div>
            )}
            {savedSlug && (
              <div style={S.banner} role="status">
                <span style={S.bannerText}>
                  Saved —{" "}
                  <span style={S.bannerSlug}>
                    {host}/{savedSlug}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => copyShort(savedSlug)}
                  style={S.bannerCopy}
                >
                  {copiedSlug === savedSlug ? "✓ Copied" : "Copy"}
                </button>
              </div>
            )}
          </form>
        </div>

        <div style={S.listHead}>
          <span style={S.listLabel}>
            Links{hasLinks && ` · ${entries.length}`}
          </span>
          <select
            value={sortBy}
            onChange={(e) => changeSort(e.target.value as SortKey)}
            style={S.sortSelect}
            aria-label="Sort links"
          >
            {Object.entries(SORTS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div style={S.list}>
          {!hasLinks ? (
            <p style={S.listEmpty}>No links yet — add one above.</p>
          ) : (
            entries.map(([s, u]) => {
              const off = isOff(u);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => select(s)}
                  style={{
                    ...S.row,
                    ...(selected === s ? S.rowSelected : {}),
                    ...(off ? { opacity: 0.6 } : {}),
                  }}
                  aria-current={selected === s ? "true" : undefined}
                >
                  <span style={S.rowBody}>
                    <span style={S.rowTop}>
                      <span style={S.rowSlug}>
                        /{s}
                        {off && (
                          <>
                            {" "}
                            <span style={S.offBadge}>off</span>
                          </>
                        )}
                      </span>
                      <span style={S.rowClicks}>
                        {u.clicks} {u.clicks === 1 ? "click" : "clicks"}
                      </span>
                    </span>
                    {u.note && <span style={S.rowNote}>{u.note}</span>}
                    <span style={S.rowDest} title={u.url}>
                      {u.aliasOf
                        ? `follows /${u.aliasOf}`
                        : bareUrl(u.url)}
                    </span>
                  </span>
                  <span style={S.rowChevron} aria-hidden>
                    ›
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div style={S.sideFoot}>
          <button
            type="button"
            onClick={setupTouchID}
            disabled={busy}
            style={S.textBtn}
          >
            {hasPasskey ? "Add this device to Touch ID" : "Set up Touch ID"}
          </button>
          {info && <div style={S.sideFootNote}>{info}</div>}
        </div>
      </aside>

      <section style={S.detail}>
        {error && (
          <p style={S.error} role="alert">
            {error}
          </p>
        )}
        {!current || !selected ? (
          <p style={S.visMsg}>No links yet — create your first one on the left.</p>
        ) : (
          <>
            <div style={S.detailHead}>
              <div style={S.detailHeadLeft}>
                <h2 style={S.detailTitle}>
                  <span style={S.detailTitleText}>
                    {host}/{selected}
                  </span>
                  {currentOff && <span style={S.offBadge}>off</span>}
                </h2>
                {editingDest ? (
                  <input
                    type="text"
                    inputMode="url"
                    className="field"
                    autoFocus
                    value={destDraft}
                    onChange={(e) => setDestDraft(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        saveDest();
                      }
                      if (e.key === "Escape") setEditingDest(false);
                    }}
                    style={S.editInput}
                    aria-label="Destination URL"
                  />
                ) : (
                  <div style={S.detailSub} title={current.url}>
                    {current.aliasOf
                      ? `→ follows /${current.aliasOf} — ${bareUrl(current.url) || "(missing)"}`
                      : `→ ${bareUrl(current.url)}`}
                    {createdLabel(current.created) &&
                      ` · created ${createdLabel(current.created)}`}
                  </div>
                )}
                {editingDest ? (
                  <div style={S.actionRow}>
                    <button
                      onClick={saveDest}
                      disabled={busy || !destDraft.trim()}
                      style={S.btnPrimary}
                    >
                      {busy ? "Saving…" : "Save"}
                    </button>
                    <button
                      onClick={() => setEditingDest(false)}
                      disabled={busy}
                      style={S.btnSecondary}
                    >
                      Cancel
                    </button>
                  </div>
                ) : confirmingDelete ? (
                  <div style={S.actionRow} ref={confirmRef}>
                    <span style={S.confirmText}>
                      Delete <span style={S.confirmSlug}>/{selected}</span>?
                    </span>
                    <button
                      onClick={() => performDelete(selected)}
                      disabled={busy}
                      style={S.btnDangerSolid}
                    >
                      Yes, delete
                    </button>
                    <button
                      onClick={() => setConfirmingDelete(false)}
                      disabled={busy}
                      style={S.btnSecondary}
                    >
                      Keep
                    </button>
                  </div>
                ) : (
                  <div style={S.actionRow}>
                    <button
                      onClick={() => copyShort(selected)}
                      style={{
                        ...S.btnPrimary,
                        minWidth: 96,
                        ...(copiedSlug === selected ? S.btnCopied : {}),
                      }}
                    >
                      {copiedSlug === selected ? "✓ Copied" : "Copy link"}
                    </button>
                    {!current.aliasOf && (
                      <button
                        onClick={startEditDest}
                        disabled={busy}
                        style={S.btnSecondary}
                      >
                        Edit destination
                      </button>
                    )}
                    <button
                      onClick={() => toggleLink(selected, !current.disabled)}
                      disabled={busy}
                      style={S.btnSecondary}
                    >
                      {current.disabled ? "Enable" : "Disable"}
                    </button>
                    <button
                      onClick={() => setConfirmingDelete(true)}
                      disabled={busy}
                      style={S.btnDangerText}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
              <QrPanel key={selected} slug={selected} />
            </div>

            <div style={S.section}>
              <div style={S.sectionLabel}>Note</div>
              {editingNote ? (
                <>
                  <textarea
                    className="field"
                    autoFocus
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setEditingNote(false);
                    }}
                    placeholder="Private note about this link — only you see it here."
                    rows={3}
                    maxLength={2000}
                    style={S.noteTextarea}
                  />
                  <div style={S.noteActions}>
                    <button
                      onClick={saveNote}
                      disabled={busy}
                      style={S.btnPrimary}
                    >
                      {busy ? "Saving…" : "Save"}
                    </button>
                    <button
                      onClick={() => setEditingNote(false)}
                      disabled={busy}
                      style={S.btnSecondary}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : current.note ? (
                <div style={S.noteBox}>
                  {current.note}
                  <button
                    type="button"
                    onClick={startEditNote}
                    style={S.noteEditBtn}
                  >
                    edit
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={startEditNote}
                  style={S.noteAddBox}
                >
                  add note
                </button>
              )}
            </div>

            <StatsCard
              slug={selected}
              clicks={current.clicks}
              hits={statsData[selected]}
              error={statsError[selected]}
            />
          </>
        )}
      </section>
    </main>
  );
}
