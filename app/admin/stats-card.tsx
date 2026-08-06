"use client";

import { useState } from "react";
import Link from "next/link";
import type { HitEvent as Hit } from "@/lib/links";
import {
  browserName,
  deviceName,
  place,
  shortDate,
  whenShort,
} from "./mobile-visits";
import { S } from "./styles";


// Where the visit came from, as shown in the Source column: a scan of the
// link's QR code, the referring site, or a direct open.
export function sourceLabel(h: Hit): string {
  if (h.src === "qr") return "QR scan";
  return h.ref || "Direct";
}

// "iPhone · Safari" — the Device column. Devices without a model (typical
// for desktops) fall back to their OS name; "Mobile Safari" reads as Safari.
export function deviceLine(h: Hit): string {
  const device = h.model ? deviceName(h) : h.os.replace(/\s[\d.]+$/, "");
  const browser = browserName(h).replace(/^Mobile /, "");
  return `${device} · ${browser}`;
}

// One visit row, shared by the dashboard's Recent visits and the full history
// page (which uses the roomier column widths).
export function VisitRow({ h, wide }: { h: Hit; wide?: boolean }) {
  return (
    <div style={S.visitRow}>
      <span style={{ ...S.vWhen, ...(wide ? S.colWhenWide : {}) }}>
        {whenShort(h.t)}
      </span>
      <span style={{ ...S.vWhere, ...(wide ? S.colWhereWide : {}) }}>
        {place(h) || "—"}
      </span>
      <span style={S.vDevice}>{deviceLine(h)}</span>
      <span style={{ ...S.vSource, ...(h.denied ? S.vSourceDenied : {}) }}>
        {sourceLabel(h)}
        {h.denied && " · 404"}
      </span>
    </div>
  );
}

// Bucket hits into one count per local calendar day for the last `days` days,
// oldest first, with the QR share broken out for the tooltip. Days with no
// hits stay at zero, so quiet days read as gaps instead of shrinking the chart.
function dailyBuckets(hits: Hit[], days: number) {
  const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const buckets = Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() - (days - 1 - i));
    return { key: dayKey(d), label: shortDate(d.getTime()), count: 0, qr: 0 };
  });
  const index = new Map(buckets.map((b, i) => [b.key, i]));
  for (const h of hits) {
    const i = index.get(dayKey(new Date(h.t)));
    if (i !== undefined) {
      buckets[i].count++;
      if (h.src === "qr") buckets[i].qr++;
    }
  }
  return buckets;
}

// How many daily bars "All time" spans: oldest logged hit through today,
// within something the chart can still render legibly.
function spanDays(hits: Hit[]): number {
  if (hits.length === 0) return 7;
  const oldest = Math.min(...hits.map((h) => h.t));
  const days = Math.ceil((Date.now() - oldest) / 86_400_000) + 1;
  return Math.min(Math.max(days, 7), 120);
}

export function dailyStats(hits: Hit[], days: number) {
  const buckets = dailyBuckets(hits, days);
  const counts = buckets.map((b) => b.count);
  const max = Math.max(...counts);
  // Ties break to the most recent day, matching the mobile chart.
  const peak = max > 0 ? counts.lastIndexOf(max) : -1;
  return { buckets, max, peak };
}

// The y-scale's top: `max` rounded up so both gridlines (top and midline)
// land on whole counts.
function niceCeil(max: number): number {
  for (let pow = 1; ; pow *= 10) {
    for (const s of [1, 2, 5]) {
      if (s * pow * 2 >= max) return s * pow * 2;
    }
  }
}

// ~4 evenly spaced bucket indexes for the x-axis date labels, always
// including the first and last day.
function xTicks(n: number): number[] {
  return [...new Set([0, 1, 2, 3].map((i) => Math.round((i * (n - 1)) / 3)))];
}

// Chart geometry, mirrored by S.chart's grid rows: the plot's total height,
// and the headroom above the top gridline where the peak label rides.
const PLOT_H = 96;
const SCALE_H = PLOT_H - 18;

// The daily bar chart shared by the Stats card and the full history page:
// gridlines on a rounded scale, date ticks, the peak bar in the accent with
// its count labeled, and a tooltip that follows the pointer (or the arrow
// keys, once the chart is focused). Zero days draw no bar — only baseline.
export function DailyBars({
  buckets,
  max,
  peak,
  days,
}: ReturnType<typeof dailyStats> & { days: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = buckets.length;
  const top = niceCeil(max);
  const y = (v: number) => (v / top) * SCALE_H;
  // Non-zero days always get a visible bar, even when the scale dwarfs them.
  const barH = (c: number) => (c === 0 ? 0 : Math.max(y(c), 2));
  const centerPct = (i: number) => ((i + 0.5) / n) * 100;
  const clampPct = (pct: number, m: number) =>
    Math.min(Math.max(pct, m), 100 - m);

  return (
    <div style={S.chart}>
      <div style={S.chartYGutter} aria-hidden>
        {[top, top / 2, 0].map((v) => (
          <span key={v} style={{ ...S.chartYLabel, bottom: y(v) }}>
            {v}
          </span>
        ))}
      </div>
      <div
        style={S.chartPlot}
        role="img"
        aria-label={
          `Visits per day, last ${days} days` +
          (peak >= 0 ? `; peak ${max} on ${buckets[peak].label}` : "")
        }
        tabIndex={0}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover((h) => h ?? n - 1)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const step = e.key === "ArrowLeft" ? -1 : 1;
          setHover((h) => Math.min(Math.max((h ?? n - 1) + step, 0), n - 1));
        }}
      >
        {[0, top / 2, top].map((v) => (
          <div key={v} style={{ ...S.chartGridline, bottom: y(v) }} />
        ))}
        <div style={S.chartSlotRow}>
          {buckets.map((b, i) => (
            <div
              key={b.key}
              style={{ ...S.chartSlot, ...(i === hover ? S.chartSlotHover : {}) }}
              onPointerEnter={() => setHover(i)}
            >
              {b.count > 0 && (
                <div
                  style={{
                    ...S.bar,
                    height: barH(b.count),
                    ...(i === peak ? S.barPeak : {}),
                  }}
                />
              )}
            </div>
          ))}
        </div>
        {peak >= 0 && (
          <span
            style={{
              ...S.chartPeakLabel,
              left: `${clampPct(centerPct(peak), 3)}%`,
              bottom: barH(max) + 4,
            }}
          >
            {max}
          </span>
        )}
        {hover !== null && (
          <div
            style={{
              ...S.chartTip,
              left: `${clampPct(centerPct(hover), 12)}%`,
            }}
          >
            <span style={S.chartTipValue}>
              {buckets[hover].count}{" "}
              {buckets[hover].count === 1 ? "visit" : "visits"}
            </span>
            <span style={S.chartTipMeta}>
              {" · "}
              {buckets[hover].label}
              {hover === n - 1 && " (so far)"}
              {buckets[hover].qr > 0 && ` · ${buckets[hover].qr} QR`}
            </span>
          </div>
        )}
      </div>
      <span />
      <div style={S.chartXAxis} aria-hidden>
        {xTicks(n).map((i, k, arr) => (
          <span
            key={i}
            style={{
              ...S.chartXLabel,
              ...(k === 0
                ? { left: 0 }
                : k === arr.length - 1
                  ? { right: 0 }
                  : {
                      left: `${centerPct(i)}%`,
                      transform: "translateX(-50%)",
                    }),
            }}
          >
            {buckets[i].label}
          </span>
        ))}
      </div>
    </div>
  );
}

const RANGES = {
  week: "Last week",
  month: "Last month",
  all: "All time",
} as const;
type RangeKey = keyof typeof RANGES;

// The detail pane's Stats card: range toggle, summary numbers, daily bars,
// and the recent visits, which fill whatever window height remains (and
// scroll in place past that). `hits` is undefined while loading; `error`
// marks a failed fetch. `clicks` is the link's all-time counter, for the
// "N of M visits" footer.
export function StatsCard({
  slug,
  clicks,
  hits,
  error,
}: {
  slug: string;
  clicks: number;
  hits?: Hit[];
  error?: boolean;
}) {
  const [range, setRange] = useState<RangeKey>("month");

  let body: React.ReactNode;
  if (error && !hits) {
    body = (
      <p style={S.statsMsg}>
        Stats failed to load — reselect the link to retry.
      </p>
    );
  } else if (hits === undefined) {
    body = <p style={S.statsMsg}>Loading…</p>;
  } else if (hits.length === 0) {
    body = <p style={S.statsMsg}>No visits recorded yet.</p>;
  } else {
    // Denied visits (link was off — the visitor saw a 404) aren't clicks, so
    // they stay out of the chart and counts; the visit rows still show them.
    const counted = hits.filter((h) => !h.denied);
    const days =
      range === "week" ? 7 : range === "month" ? 30 : spanDays(counted);
    const windowStart = new Date();
    windowStart.setHours(0, 0, 0, 0);
    windowStart.setDate(windowStart.getDate() - (days - 1));
    const inWindow = counted.filter((h) => h.t >= windowStart.getTime());
    const scans = inWindow.filter((h) => h.src === "qr").length;
    const daily = dailyStats(counted, days);

    const byDevice = (d: string) => hits.filter((h) => h.device === d).length;

    body = (
      <>
        <div style={S.statsSummary}>
          <span>
            <span style={S.statStrong}>{inWindow.length}</span> clicks
          </span>
          <span>
            <span style={S.statStrong}>{scans}</span> scans
          </span>
          <span>
            <span style={S.statStrong}>
              {(inWindow.length / days).toFixed(1)}
            </span>{" "}
            / day
          </span>
          {daily.peak >= 0 && (
            <span>
              peak{" "}
              <span style={S.statStrong}>
                {daily.buckets[daily.peak].label} · {daily.max}
              </span>
            </span>
          )}
        </div>
        <DailyBars {...daily} days={days} />
        <div style={S.visitsSection}>
          <div style={S.visitsHeadRow}>
            <span style={S.visitsTitle}>Recent visits</span>
            <span style={S.visitsBreakdown}>
              <span>
                <span style={S.statStrong}>{byDevice("mobile")}</span> mobile
              </span>
              <span>
                <span style={S.statStrong}>{byDevice("desktop")}</span> desktop
              </span>
              <span>
                <span style={S.statStrong}>{byDevice("tablet")}</span> tablet
              </span>
            </span>
          </div>
          <div style={S.visitsList}>
            {hits.map((h, i) => (
              <VisitRow key={`${h.t}-${i}`} h={h} />
            ))}
          </div>
          <div style={S.visitsFoot}>
            <span>
              {hits.length} of {Math.max(clicks, hits.length)} visits
            </span>
            <Link href={`/admin/${slug}/visits`} style={S.viewAllLink}>
              View all
            </Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <div style={S.statsCard}>
      <div style={S.statsHeadRow}>
        <span style={S.listLabel}>Stats</span>
        <div style={S.segmented}>
          {Object.entries(RANGES).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setRange(key as RangeKey)}
              style={{ ...S.segBtn, ...(range === key ? S.segBtnActive : {}) }}
              aria-pressed={range === key}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {body}
    </div>
  );
}
