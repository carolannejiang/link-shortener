"use client";

import type { HitEvent as Hit } from "@/lib/links";
import { S } from "./styles";

// How many of the fetched hits get rendered as individual rows (the
// breakdown chips still count all of them).
const STATS_SHOWN = 25;

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
// the most recent hits. `hits` is undefined while loading; `error` marks a
// failed fetch (any previously loaded list stays visible).
export function StatsBlock({ hits, error }: { hits?: Hit[]; error?: boolean }) {
  if (error && !hits)
    return (
      <div style={S.statsBlock}>
        Stats failed to load — close and reopen to retry.
      </div>
    );
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
        {hits.slice(0, STATS_SHOWN).map((h, i) => (
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
      {hits.length > STATS_SHOWN && (
        <div style={S.hitMeta}>
          Showing {STATS_SHOWN} of {hits.length} recent hits.
        </div>
      )}
    </div>
  );
}
