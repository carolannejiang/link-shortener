"use client";

import type { HitEvent as Hit } from "@/lib/links";
import { S } from "./styles";

// How many of the fetched hits get rendered as individual rows (the
// breakdown chips still count all of them).
const STATS_SHOWN = 25;

// How many days the activity chart spans, counting back from today.
const CHART_DAYS = 14;

// Bucket hits into one count per local calendar day for the last `days` days,
// oldest first. Days with no hits stay in the list as zero-height bars, so the
// chart keeps a steady width and the gaps read as quiet days.
function dailyCounts(
  hits: Hit[],
  days: number,
): { key: string; label: string; count: number }[] {
  const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const buckets = Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() - (days - 1 - i));
    return {
      key: dayKey(d),
      label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      count: 0,
    };
  });
  const index = new Map(buckets.map((b, i) => [b.key, i]));
  for (const h of hits) {
    const i = index.get(dayKey(new Date(h.t)));
    if (i !== undefined) buckets[i].count++;
  }
  return buckets;
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
  const daily = dailyCounts(hits, CHART_DAYS);
  const peak = Math.max(1, ...daily.map((d) => d.count));
  const recent = daily.reduce((sum, d) => sum + d.count, 0);

  return (
    <div style={S.statsBlock}>
      <div>
        <div style={S.chart} role="img" aria-label={`Hits per day, last ${CHART_DAYS} days`}>
          {daily.map((d) => (
            <div key={d.key} style={S.chartCol} title={`${d.label}: ${d.count}`}>
              <div
                style={{
                  ...S.chartBar,
                  height: `${(d.count / peak) * 100}%`,
                  opacity: d.count ? 1 : 0.25,
                }}
              />
            </div>
          ))}
        </div>
        <div style={S.hitMeta}>
          Last {CHART_DAYS} days · {recent} {recent === 1 ? "hit" : "hits"}
          {daily[0] && ` · ${daily[0].label}–${daily[daily.length - 1].label}`}
        </div>
      </div>
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
