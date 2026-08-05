"use client";

import { useState, type ReactNode } from "react";
import type { HitEvent as Hit, LinkInfo } from "@/lib/links";
import { M } from "./mobile-styles";

// ─── Visit formatting, shared with the details sheet in mobile.tsx ──────────

// A short device name for a visit row: the model minus its vendor — "Apple
// iPhone" → "iPhone", "Google Pixel 9" → "Pixel 9" — with a Mac's "Macintosh"
// shortened. Falls back to the capitalized device class.
export function deviceName(h: Hit): string {
  const model = h.model
    ?.replace(/^(Apple|Google|Samsung|Xiaomi|Huawei|OnePlus|Motorola|OPPO)\s+/i, "")
    .replace("Macintosh", "Mac");
  if (model) return model;
  return h.device.charAt(0).toUpperCase() + h.device.slice(1);
}

// Browser without its version: "Chrome 128" → "Chrome".
export function browserName(h: Hit): string {
  return h.browser.replace(/\s[\d.]+$/, "");
}

export function place(h: Hit): string {
  return [h.city, h.country].filter(Boolean).join(", ");
}

// Where the visit came from, as shown in the right column: "QR" or "web".
export function srcLabel(h: Hit): string {
  return h.src === "qr" ? "QR" : "web";
}

// "Aug 5, 9:12 AM" — for the sheet's compact visit rows.
export function whenShort(t: number): string {
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// "Jul 18", or "Jul 2025" once it's from another year.
export function shortDate(ms: number): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    ...(sameYear ? { day: "numeric" } : { year: "numeric" }),
  });
}

export type VisitFilter = "all" | "mobile" | "desktop" | "qr";

export function matchesFilter(h: Hit, f: VisitFilter): boolean {
  if (f === "mobile") return h.device === "mobile" || h.device === "tablet";
  if (f === "desktop") return h.device === "desktop";
  if (f === "qr") return h.src === "qr";
  return true;
}

// ─── Clicks chart ───────────────────────────────────────────────────────────

const RANGES = { week: "Week", month: "Month", all: "All time" } as const;
type RangeKey = keyof typeof RANGES;

// Bucket hits into one count per local calendar day for the last `days` days,
// oldest first (same shape as the desktop stats chart).
function dailyBuckets(hits: Hit[], days: number) {
  const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const buckets = Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() - (days - 1 - i));
    return { key: dayKey(d), label: shortDate(d.getTime()), count: 0 };
  });
  const index = new Map(buckets.map((b, i) => [b.key, i]));
  for (const h of hits) {
    const i = index.get(dayKey(new Date(h.t)));
    if (i !== undefined) buckets[i].count++;
  }
  return buckets;
}

// How many daily bars "All time" spans: from the oldest logged hit to today,
// kept within something a phone can render.
function spanDays(hits: Hit[]): number {
  if (hits.length === 0) return 7;
  const oldest = Math.min(...hits.map((h) => h.t));
  const days = Math.ceil((Date.now() - oldest) / 86_400_000) + 1;
  return Math.min(Math.max(days, 7), 120);
}

// The "Clicks" card: range toggle, summary numbers, daily bars with the peak
// day highlighted, and start / peak / end axis labels. Denied visits (link
// was off) aren't clicks, so callers pass them pre-filtered.
function ChartCard({ hits }: { hits: Hit[] }) {
  const [range, setRange] = useState<RangeKey>("month");
  const days = range === "week" ? 7 : range === "month" ? 30 : spanDays(hits);
  const buckets = dailyBuckets(hits, days);
  const counts = buckets.map((b) => b.count);
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(...counts);
  const peak = max > 0 ? counts.lastIndexOf(max) : -1;
  const windowStart = new Date();
  windowStart.setHours(0, 0, 0, 0);
  windowStart.setDate(windowStart.getDate() - (days - 1));
  const scans = hits.filter(
    (h) => h.src === "qr" && h.t >= windowStart.getTime(),
  ).length;
  const perDay = (total / days).toFixed(1);

  return (
    <div style={M.chartCard}>
      <div style={M.chartHead}>
        <span style={M.label}>Clicks</span>
        <div style={M.rangeSeg}>
          {Object.entries(RANGES).map(([key, name]) => (
            <button
              key={key}
              type="button"
              onClick={() => setRange(key as RangeKey)}
              style={range === key ? M.rangeBtnActive : M.rangeBtn}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <div style={M.chartStats}>
        <span>
          <span style={M.statStrong}>{total}</span> clicks
        </span>
        <span>
          <span style={M.statStrong}>{scans}</span> scans
        </span>
        <span>
          <span style={M.statStrong}>{perDay}</span> / day
        </span>
        {peak >= 0 && (
          <span>
            peak{" "}
            <span style={M.statStrong}>
              {buckets[peak].label} · {max}
            </span>
          </span>
        )}
      </div>
      <div
        style={{ ...M.bars, gap: buckets.length > 40 ? 1 : 3 }}
        role="img"
        aria-label={`Clicks per day, last ${days} days`}
      >
        {buckets.map((b, i) => (
          <div
            key={b.key}
            title={`${b.label}: ${b.count}`}
            style={{
              ...M.bar,
              height: max ? `${Math.max((b.count / max) * 100, 3)}%` : "3%",
              opacity: b.count ? 1 : 0.35,
              ...(i === peak ? { background: "var(--accent)" } : {}),
            }}
          />
        ))}
      </div>
      <div style={M.axis}>
        <span>{buckets[0].label}</span>
        {peak >= 0 && (
          <span>
            {buckets[peak].label} · {max} {max === 1 ? "click" : "clicks"}
          </span>
        )}
        <span>{buckets[buckets.length - 1].label}</span>
      </div>
    </div>
  );
}

// ─── Full visit log (the "See all" screen) ──────────────────────────────────

// "Today" / "Yesterday" headers, then short dates.
function dayLabel(t: number): string {
  const startOf = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round(
    (startOf(new Date()) - startOf(new Date(t))) / 86_400_000,
  );
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return shortDate(t);
}

function timeOnly(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function VisitsScreen({
  slug,
  link,
  hits,
  error,
  onBack,
}: {
  slug: string;
  link: LinkInfo;
  hits?: Hit[];
  error?: boolean;
  onBack: () => void;
}) {
  const [filter, setFilter] = useState<VisitFilter>("all");
  const all = hits ?? [];
  const filtered = all.filter((h) => matchesFilter(h, filter));

  const chips: { key: VisitFilter; name: string; count: number }[] = [
    { key: "all", name: "All", count: Math.max(link.clicks, 0) },
    {
      key: "mobile",
      name: "Mobile",
      count: all.filter((h) => matchesFilter(h, "mobile")).length,
    },
    {
      key: "desktop",
      name: "Desktop",
      count: all.filter((h) => matchesFilter(h, "desktop")).length,
    },
    { key: "qr", name: "QR", count: Math.max(link.scans, 0) },
  ];
  const chipTotal = chips.find((c) => c.key === filter)?.count ?? 0;

  // The list groups visits under day headers, newest first (API order).
  const rows: ReactNode[] = [];
  let lastDay = "";
  filtered.forEach((h, i) => {
    const day = dayLabel(h.t);
    if (day !== lastDay) {
      rows.push(
        <div key={`day-${day}`} style={{ ...M.label, ...M.dayLabel }}>
          {day}
        </div>,
      );
      lastDay = day;
    }
    rows.push(
      <div key={`${h.t}-${i}`} style={M.logRow}>
        <div style={M.logLeft}>
          <span style={M.logTime}>{timeOnly(h.t)}</span>
          <span style={M.logMeta}>
            {[deviceName(h), h.os, h.browser].join(" · ")}
          </span>
        </div>
        <div style={M.logRight}>
          <span style={M.logPlace}>{place(h) || h.ref || "—"}</span>
          <span style={h.denied ? M.logSrcDenied : M.logSrc}>
            {srcLabel(h)}
            {h.denied && " · 404"}
          </span>
        </div>
      </div>,
    );
  });

  return (
    <div style={M.screen}>
      <div style={M.vHead}>
        <div style={M.vHeadRow}>
          <button type="button" onClick={onBack} style={M.back}>
            ‹ /{slug}
          </button>
          <div style={M.vTitle}>Recent visits</div>
          <span style={M.vSpacer} />
        </div>
        <div style={M.chips}>
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setFilter(c.key)}
              style={filter === c.key ? M.chipActive : M.chip}
              aria-pressed={filter === c.key}
            >
              {c.name} {c.count}
            </button>
          ))}
        </div>
      </div>
      {hits === undefined ? (
        <div style={M.vEmpty}>{error ? "Couldn't load visits." : "Loading…"}</div>
      ) : all.length === 0 ? (
        <div style={M.vEmpty}>No visits recorded yet.</div>
      ) : (
        <div style={M.vScroll}>
          <ChartCard hits={filtered.filter((h) => !h.denied)} />
          {rows.length > 0 ? (
            rows
          ) : (
            <div style={M.vEmpty}>No visits match this filter.</div>
          )}
          <div style={M.vFooter}>
            {chipTotal > filtered.length
              ? `Showing ${filtered.length} of ${chipTotal} visits`
              : `${filtered.length} ${filtered.length === 1 ? "visit" : "visits"}`}
          </div>
        </div>
      )}
    </div>
  );
}
