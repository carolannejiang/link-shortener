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

// How many visits the dashboard card lists before pointing at "View all".
const RECENT_SHOWN = 6;

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
// oldest first. Days with no hits stay as zero-height bars, so quiet days
// read as gaps instead of shrinking the chart.
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

// The daily bar chart plus its start / peak / end axis, shared by the Stats
// card and the full history page. The peak bar is the dark one.
export function DailyBars({
  buckets,
  max,
  peak,
  days,
}: ReturnType<typeof dailyStats> & { days: number }) {
  return (
    <>
      <div
        style={{ ...S.chart, gap: buckets.length > 40 ? 1 : 3 }}
        role="img"
        aria-label={`Visits per day, last ${days} days`}
      >
        {buckets.map((b, i) => (
          <div
            key={b.key}
            title={`${b.label}: ${b.count}`}
            style={{
              ...S.bar,
              height: max ? `${Math.max((b.count / max) * 100, 3)}%` : "3%",
              opacity: b.count ? 1 : 0.35,
              ...(i === peak ? S.barPeak : {}),
            }}
          />
        ))}
      </div>
      <div style={S.axis}>
        <span>{buckets[0].label}</span>
        {peak >= 0 ? (
          <span>
            {buckets[peak].label} · {max} {max === 1 ? "click" : "clicks"}
          </span>
        ) : (
          <span />
        )}
        <span>{buckets[buckets.length - 1].label}</span>
      </div>
    </>
  );
}

const RANGES = {
  week: "Last week",
  month: "Last month",
  all: "All time",
} as const;
type RangeKey = keyof typeof RANGES;

// The detail pane's Stats card: range toggle, summary numbers, daily bars,
// and the latest few visits with a link to the full history. `hits` is
// undefined while loading; `error` marks a failed fetch. `clicks` is the
// link's all-time counter, for the "N of M visits" footer.
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
          {hits.slice(0, RECENT_SHOWN).map((h, i) => (
            <VisitRow key={`${h.t}-${i}`} h={h} />
          ))}
          <div style={S.visitsFoot}>
            <span>
              {Math.min(RECENT_SHOWN, hits.length)} of{" "}
              {Math.max(clicks, hits.length)} visits
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
