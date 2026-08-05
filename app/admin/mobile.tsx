"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import type { HitEvent as Hit, LinkInfo } from "@/lib/links";
import { isExpired } from "@/lib/links";
import { qrValue } from "./qr-block";
import { M } from "./mobile-styles";
import {
  VisitsScreen,
  browserName,
  deviceName,
  shortDate,
  srcLabel,
  whenShort,
} from "./mobile-visits";

// The phone-sized admin dashboard, rendered by app/admin/page.tsx on small
// viewports. Flow, per the design: dashboard with the composer expanded →
// tap a link for inline quick actions (Copy / Save QR / Details) → Details
// opens a bottom sheet → "See all" opens the full visit log. All data and
// mutations stay in page.tsx and arrive here as props.
export type MobileDashboardProps = {
  host: string;
  links: Record<string, LinkInfo>;
  entries: [string, LinkInfo][]; // sorted for display
  url: string;
  slug: string;
  onUrl: (v: string) => void;
  onSlug: (v: string) => void;
  sortBy: string;
  sortOptions: [string, string][];
  onSort: (key: string) => void;
  busy: boolean;
  error: string;
  copiedSlug: string | null;
  stats: Record<string, Hit[]>;
  statsErrors: Record<string, boolean>;
  onAdd: () => Promise<void>;
  onCopy: (s: string) => void;
  onLoadStats: (s: string) => void;
  onToggle: (s: string, disabled: boolean) => Promise<void>;
  onSaveNote: (s: string, note: string) => Promise<boolean>;
  onSaveUrl: (s: string, url: string) => Promise<boolean>;
  onDelete: (s: string) => Promise<boolean>;
  onLogout: () => void;
};

// The destination as shown in a row or the sheet: scheme stripped; the
// nowrap/ellipsis styles do the truncating.
function bareUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

// True for a link whose expiry has passed — it 404s like a disabled one, so
// the row marks it. (Helper so render stays pure per the hooks linter.)
function hasExpired(u: LinkInfo): boolean {
  return !u.disabled && isExpired(u.expiresAt, Date.now());
}

export function MobileDashboard(props: MobileDashboardProps) {
  const {
    host,
    links,
    entries,
    url,
    slug,
    onUrl,
    onSlug,
    sortBy,
    sortOptions,
    onSort,
    busy,
    error,
    onAdd,
    onCopy,
    onLoadStats,
    onLogout,
  } = props;

  const [expanded, setExpanded] = useState<string | null>(null);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [visitsFor, setVisitsFor] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const qrRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  function showToast(msg: string) {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }

  // Download the offscreen QR canvas as a PNG, confirming with a toast.
  function saveQr(s: string) {
    const canvas = qrRef.current?.querySelector("canvas");
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${s}-qr.png`;
    a.click();
    showToast("✓ QR code saved");
  }

  function openSheet(s: string) {
    setSheetFor(s);
    onLoadStats(s); // fresh visits every open; stale data stays while loading
  }

  const canSave = !busy && url.trim() !== "";
  // The offscreen QR canvas serves whichever link's actions are showing.
  const qrTarget = sheetFor ?? expanded;

  if (visitsFor && links[visitsFor]) {
    return (
      <VisitsScreen
        slug={visitsFor}
        link={links[visitsFor]}
        hits={props.stats[visitsFor]}
        error={props.statsErrors[visitsFor]}
        onBack={() => setVisitsFor(null)}
      />
    );
  }

  return (
    <main style={M.wrap}>
      <div style={M.head}>
        <div style={M.headRow}>
          {/* Brand title, hardcoded like the desktop header (the slug prefix
              below shows the real host). */}
          <h1 style={M.h1}>carolanne.link</h1>
          <button type="button" onClick={onLogout} disabled={busy} style={M.logout}>
            Log out
          </button>
        </div>
        {error && (
          <p style={M.error} role="alert">
            {error}
          </p>
        )}
        <form
          style={M.composer}
          onSubmit={(e) => {
            e.preventDefault();
            onAdd();
          }}
        >
          <input
            type="text"
            inputMode="url"
            placeholder="Paste a destination URL"
            value={url}
            onChange={(e) => onUrl(e.target.value)}
            style={M.input}
            aria-label="Destination URL"
          />
          <div style={M.slugRow}>
            <span style={M.slugPrefix}>{host}/</span>
            <input
              type="text"
              placeholder="random"
              value={slug}
              onChange={(e) => onSlug(e.target.value)}
              style={M.slugInput}
              aria-label="Short name (optional)"
            />
          </div>
          <button
            type="submit"
            disabled={!canSave}
            style={{ ...M.save, ...(canSave ? {} : { opacity: 0.4 }) }}
          >
            {busy ? "Saving…" : "Save link"}
          </button>
        </form>
      </div>

      <div style={M.listBar}>
        <span style={M.label}>Links · {entries.length}</span>
        <label style={M.sortPill}>
          {sortOptions.find(([key]) => key === sortBy)?.[1] ?? "Sort"} ▾
          <select
            value={sortBy}
            onChange={(e) => onSort(e.target.value)}
            style={M.sortSelect}
            aria-label="Sort links"
          >
            {sortOptions.map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={M.list}>
        {entries.length === 0 ? (
          <p style={M.empty}>No links yet — add one above to get started.</p>
        ) : (
          entries.map(([s, u]) => (
            <LinkRow
              key={s}
              s={s}
              u={u}
              active={expanded === s}
              copied={props.copiedSlug === s}
              onTap={() => setExpanded((cur) => (cur === s ? null : s))}
              onCopy={() => onCopy(s)}
              onSaveQr={() => saveQr(s)}
              onDetails={() => openSheet(s)}
            />
          ))
        )}
      </div>

      {sheetFor && links[sheetFor] && (
        <DetailsSheet
          key={sheetFor}
          s={sheetFor}
          u={links[sheetFor]}
          busy={busy}
          copied={props.copiedSlug === sheetFor}
          hits={props.stats[sheetFor]}
          hitsError={props.statsErrors[sheetFor]}
          onClose={() => setSheetFor(null)}
          onCopy={() => onCopy(sheetFor)}
          onDownloadQr={() => saveQr(sheetFor)}
          onToggle={() => props.onToggle(sheetFor, !links[sheetFor].disabled)}
          onSaveNote={(note) => props.onSaveNote(sheetFor, note)}
          onSaveUrl={(u2) => props.onSaveUrl(sheetFor, u2)}
          onDelete={async () => {
            if (await props.onDelete(sheetFor)) setSheetFor(null);
          }}
          onSeeAll={() => setVisitsFor(sheetFor)}
        />
      )}

      {toast && (
        <div style={M.toast} role="status">
          {toast}
        </div>
      )}

      {qrTarget && (
        <div ref={qrRef} style={{ position: "fixed", left: -9999, top: 0 }} aria-hidden>
          <QRCodeCanvas value={qrValue(qrTarget)} size={512} marginSize={2} />
        </div>
      )}
    </main>
  );
}

// One list row: slug + note + destination on the left, counters on the
// right. Tapping toggles the inline quick actions beneath it.
function LinkRow({
  s,
  u,
  active,
  copied,
  onTap,
  onCopy,
  onSaveQr,
  onDetails,
}: {
  s: string;
  u: LinkInfo;
  active: boolean;
  copied: boolean;
  onTap: () => void;
  onCopy: () => void;
  onSaveQr: () => void;
  onDetails: () => void;
}) {
  const expired = hasExpired(u);
  return (
    <div style={active ? M.rowActive : M.row}>
      <button
        type="button"
        onClick={onTap}
        aria-expanded={active}
        style={{
          ...M.rowBtn,
          ...(active ? M.rowBtnActive : {}),
          ...(!active && (u.disabled || expired) ? { opacity: 0.6 } : {}),
        }}
      >
        <div style={M.rowMain}>
          <div style={M.rowSlug}>
            /{s}
            {u.disabled && <span style={M.offBadge}>off</span>}
            {expired && <span style={M.offBadge}>expired</span>}
          </div>
          {u.note && <div style={M.rowNote}>📝 {u.note}</div>}
          <div style={M.rowDest}>
            {u.aliasOf
              ? `↳ /${u.aliasOf} → ${u.url ? bareUrl(u.url) : "(missing)"}`
              : bareUrl(u.url)}
          </div>
        </div>
        <div style={M.rowStats}>
          <div style={M.rowStat}>
            {u.clicks} {u.clicks === 1 ? "click" : "clicks"}
          </div>
          {u.scans > 0 && (
            <div style={M.rowStat}>
              {u.scans} {u.scans === 1 ? "scan" : "scans"}
            </div>
          )}
        </div>
      </button>
      {active && (
        <div style={M.quickRow}>
          <button type="button" onClick={onCopy} style={M.quickPrimary}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
          <button type="button" onClick={onSaveQr} style={M.quickBtn}>
            Save QR
          </button>
          <button type="button" onClick={onDetails} style={M.quickDetails}>
            Details ›
          </button>
        </div>
      )}
    </div>
  );
}

// The details bottom sheet. One layout when the link is on (actions grid,
// note, stats, recent visits), another when it's off ("Turn back on" leads,
// stats gain a red "while off" count, and the visit list shows the 404s).
function DetailsSheet({
  s,
  u,
  busy,
  copied,
  hits,
  hitsError,
  onClose,
  onCopy,
  onDownloadQr,
  onToggle,
  onSaveNote,
  onSaveUrl,
  onDelete,
  onSeeAll,
}: {
  s: string;
  u: LinkInfo;
  busy: boolean;
  copied: boolean;
  hits?: Hit[];
  hitsError?: boolean;
  onClose: () => void;
  onCopy: () => void;
  onDownloadQr: () => void;
  onToggle: () => void;
  onSaveNote: (note: string) => Promise<boolean>;
  onSaveUrl: (url: string) => Promise<boolean>;
  onDelete: () => void;
  onSeeAll: () => void;
}) {
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState(u.url);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(u.note);

  const off = u.disabled;
  const offSince = u.disabledAt;
  const all = hits ?? [];
  const recent = all.filter((h) => !h.denied);
  // Visits while off: denied hits since the link was turned off. Links
  // disabled before the timestamp existed fall back to every denied hit.
  const offHits = all.filter(
    (h) => h.denied && (offSince ? h.t >= offSince : true),
  );

  // A visit row in the sheet: "Aug 5, 9:12 AM · iPhone · Chicago", with the
  // source (or referrer) on the right — struck red with a 404 when denied.
  const visitRow = (h: Hit, i: number) => (
    <div
      key={`${h.t}-${i}`}
      style={{ ...M.visitRow, ...(i > 0 ? M.visitRowLine : {}) }}
    >
      <span style={M.visitLeft}>
        <span style={M.visitWhen}>{whenShort(h.t)}</span> · {deviceName(h)} ·{" "}
        {h.city ?? browserName(h)}
      </span>
      {h.denied ? (
        <span style={M.visitSrcDenied}>{srcLabel(h)} · 404</span>
      ) : (
        <span style={M.visitSrc}>{h.src === "qr" ? "QR" : h.ref ?? "web"}</span>
      )}
    </div>
  );

  return (
    <>
      <button type="button" style={M.scrim} onClick={onClose} aria-label="Close details" />
      <div style={M.sheet} role="dialog" aria-label={`Details for /${s}`}>
        <div style={M.handle} />
        <div style={M.sheetHead}>
          <div style={M.sheetTitle}>
            <div style={M.sheetSlug}>
              /{s}
              {off && <span style={M.offBadge}>off</span>}
            </div>
            <div style={M.sheetDest}>
              {u.aliasOf
                ? `↳ follows /${u.aliasOf}`
                : `→ ${bareUrl(u.url)}`}
            </div>
          </div>
          <button type="button" onClick={onClose} style={M.close} aria-label="Close">
            ✕
          </button>
        </div>

        {off && (
          <button type="button" onClick={onToggle} disabled={busy} style={M.turnOn}>
            Turn back on
          </button>
        )}
        <div style={M.actionGrid}>
          <button
            type="button"
            onClick={onCopy}
            style={off ? M.actionBtn : M.actionPrimary}
          >
            {copied ? "Copied ✓" : "Copy link"}
          </button>
          {!off && (
            <button type="button" onClick={onDownloadQr} style={M.actionBtn}>
              Download QR
            </button>
          )}
          {!u.aliasOf && (
            <button
              type="button"
              onClick={() => {
                setUrlDraft(u.url);
                setEditingUrl((cur) => !cur);
              }}
              style={M.actionBtn}
            >
              Edit destination
            </button>
          )}
          {!off && (
            <button type="button" onClick={onToggle} disabled={busy} style={M.actionBtn}>
              Turn off
            </button>
          )}
        </div>

        {editingUrl && (
          <div style={M.editArea}>
            <input
              type="text"
              inputMode="url"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              style={M.editInput}
              aria-label="Destination URL"
            />
            <div style={M.editActions}>
              <button
                type="button"
                onClick={() => setEditingUrl(false)}
                style={M.editBtn}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !urlDraft.trim()}
                onClick={async () => {
                  if (await onSaveUrl(urlDraft)) setEditingUrl(false);
                }}
                style={M.editSave}
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}

        <div style={M.secRow}>
          <span style={M.label}>Note</span>
          <button
            type="button"
            onClick={() => {
              setNoteDraft(u.note);
              setEditingNote((cur) => !cur);
            }}
            style={M.secEdit}
          >
            {editingNote ? "Cancel" : u.note ? "Edit" : "Add"}
          </button>
        </div>
        {editingNote ? (
          <div style={M.editArea}>
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Private note about this link — only you see it here."
              rows={3}
              maxLength={2000}
              style={M.editTextarea}
            />
            <div style={M.editActions}>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  if (await onSaveNote(noteDraft.trim())) setEditingNote(false);
                }}
                style={M.editSave}
              >
                {busy ? "Saving…" : "Save note"}
              </button>
            </div>
          </div>
        ) : (
          u.note && <div style={M.noteBox}>📝 {u.note}</div>
        )}

        <div style={M.statsRow}>
          <span>
            <span style={M.statStrong}>{u.clicks}</span> clicks
          </span>
          <span>
            <span style={M.statStrong}>{u.scans}</span> QR scans
          </span>
          {off
            ? hits && (
                <span style={{ color: "var(--danger)" }}>
                  <span style={{ fontWeight: 600 }}>{offHits.length}</span> while
                  off
                </span>
              )
            : u.created > 0 && (
                <span>
                  created{" "}
                  <span style={M.statStrong}>{shortDate(u.created)}</span>
                </span>
              )}
        </div>

        <div style={M.visitsHead}>
          <span style={M.label}>{off ? "Visits while off" : "Recent visits"}</span>
          <button type="button" onClick={onSeeAll} style={M.seeAll}>
            See all ›
          </button>
        </div>
        {hits === undefined ? (
          <div style={M.muted}>{hitsError ? "Couldn't load visits." : "Loading…"}</div>
        ) : off ? (
          <>
            {offHits.length === 0 ? (
              <div style={M.muted}>No visits while off yet.</div>
            ) : (
              offHits.slice(0, 2).map(visitRow)
            )}
            {offHits.length > 0 && (
              <div style={M.visitsNote}>
                {offHits.length} {offHits.length === 1 ? "visit" : "visits"}{" "}
                {offSince ? `since turned off ${shortDate(offSince)}` : "while off"}
              </div>
            )}
          </>
        ) : recent.length === 0 ? (
          <div style={M.muted}>No visits recorded yet.</div>
        ) : (
          recent.slice(0, 3).map(visitRow)
        )}

        <button type="button" onClick={onDelete} disabled={busy} style={M.delete}>
          Delete link
        </button>
        <div style={M.deleteHint}>Deleting can’t be undone</div>
      </div>
    </>
  );
}
