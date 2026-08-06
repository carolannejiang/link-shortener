"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { HitEvent as Hit, LinkInfo } from "@/lib/links";
import { dailyStats, DailyBars, VisitRow } from "../../stats-card";
import { S } from "../../styles";

// Rows per page of the visit table.
const PAGE_SIZE = 12;

// The chart mirrors the dashboard's default month view.
const CHART_DAYS = 30;

const FILTERS = {
  all: "All",
  clicks: "Clicks",
  qr: "QR scans",
} as const;
type FilterKey = keyof typeof FILTERS;

function matchesFilter(h: Hit, f: FilterKey): boolean {
  if (f === "clicks") return h.src !== "qr";
  if (f === "qr") return h.src === "qr";
  return true;
}

// The short-link domain for display. Falls back to the production domain
// during prerendering (the page only shows data after a client fetch anyway).
function shortHost() {
  if (typeof window !== "undefined") return window.location.host;
  return "carolanne.link";
}

// The full visit history for one link: source filter + daily chart + a
// paginated table, with the filter and page mirrored in the URL
// (?source=qr&page=2) so the view survives reloads.
export default function VisitsPage() {
  const params = useParams<{ slug: string }>();
  const slug = String(params.slug ?? "").toLowerCase();

  const [state, setState] = useState<
    "loading" | "unauthorized" | "missing" | "error" | "ready"
  >("loading");
  const [link, setLink] = useState<LinkInfo | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  // Initial filter/page come from the URL. The prerender only ever shows the
  // loading shell, so reading location in the initializer is hydration-safe.
  const [filter, setFilter] = useState<FilterKey>(() => {
    if (typeof window === "undefined") return "all";
    const s = new URLSearchParams(window.location.search).get("source");
    return s === "qr" || s === "clicks" ? s : "all";
  });
  const [page, setPage] = useState(() => {
    if (typeof window === "undefined") return 1;
    const n = Number(new URLSearchParams(window.location.search).get("page"));
    return Number.isInteger(n) && n > 1 ? n : 1;
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // The session cookie authenticates both calls; a 401 means the
        // dashboard needs unlocking first.
        const [linksRes, statsRes] = await Promise.all([
          fetch("/api/links"),
          fetch(`/api/links?stats=${encodeURIComponent(slug)}`),
        ]);
        if (linksRes.status === 401 || statsRes.status === 401) {
          if (!cancelled) setState("unauthorized");
          return;
        }
        if (!linksRes.ok || !statsRes.ok) throw new Error();
        const linksData = await linksRes.json().catch(() => ({}));
        const statsData = await statsRes.json().catch(() => ({}));
        if (cancelled) return;
        const info: LinkInfo | undefined = linksData.links?.[slug];
        if (!info) {
          setState("missing");
          return;
        }
        setLink(info);
        setHits((statsData.events ?? []).filter(Boolean));
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  function syncUrl(f: FilterKey, p: number) {
    const q = new URLSearchParams();
    if (f !== "all") q.set("source", f);
    if (p > 1) q.set("page", String(p));
    const qs = q.toString();
    window.history.replaceState(
      null,
      "",
      qs ? `?${qs}` : window.location.pathname,
    );
  }

  function changeFilter(f: FilterKey) {
    setFilter(f);
    setPage(1);
    syncUrl(f, 1);
  }

  function changePage(p: number) {
    setPage(p);
    syncUrl(filter, p);
  }

  const host = shortHost();
  const back = (
    <Link href={`/admin?link=${encodeURIComponent(slug)}`} style={S.visBack}>
      ‹ Back to /{slug}
    </Link>
  );

  if (state !== "ready" || !link) {
    return (
      <main style={S.visPage}>
        {back}
        <p style={S.visMsg}>
          {state === "loading" && "Loading…"}
          {state === "unauthorized" &&
            "Your session expired — unlock the dashboard first."}
          {state === "missing" && `There's no link called /${slug}.`}
          {state === "error" && "Couldn't load visits — refresh to retry."}
        </p>
      </main>
    );
  }

  const filtered = hits.filter((h) => matchesFilter(h, filter));
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const cur = Math.min(page, totalPages);
  const start = (cur - 1) * PAGE_SIZE;
  const shown = filtered.slice(start, start + PAGE_SIZE);

  // Header counts for the current filter. Totals prefer the true all-time
  // counters (the event log is capped); the device split comes from the log.
  const counterTotal =
    filter === "all"
      ? link.clicks
      : filter === "qr"
        ? link.scans
        : link.clicks - link.scans;
  const total = Math.max(counterTotal, filtered.length);
  const byDevice = (d: string) =>
    filtered.filter((h) => h.device === d).length;

  const daily = dailyStats(
    filtered.filter((h) => !h.denied),
    CHART_DAYS,
  );

  return (
    <main style={S.visPage}>
      {back}
      <div style={S.visHeadRow}>
        <div>
          <h2 style={S.visTitle}>
            All visits — {host}/{slug}
          </h2>
          <div style={S.visCounts}>
            <span>
              <span style={S.statStrong}>{total}</span> total
            </span>
            <span>
              <span style={S.statStrong}>{byDevice("mobile")}</span> mobile
            </span>
            <span>
              <span style={S.statStrong}>{byDevice("desktop")}</span> desktop
            </span>
            <span>
              <span style={S.statStrong}>{byDevice("tablet")}</span> tablet
            </span>
          </div>
        </div>
        <div style={S.segmented}>
          {Object.entries(FILTERS).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => changeFilter(key as FilterKey)}
              style={{
                ...S.segBtn,
                ...(filter === key ? S.segBtnActive : {}),
              }}
              aria-pressed={filter === key}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={S.visChart}>
        <DailyBars {...daily} days={CHART_DAYS} />
      </div>

      <div style={S.visTableHead}>
        <span style={S.colWhenWide}>When</span>
        <span style={S.colWhereWide}>Where</span>
        <span style={S.thDevice}>Device</span>
        <span>Source</span>
      </div>
      {shown.map((h, i) => (
        <VisitRow key={`${h.t}-${start + i}`} h={h} wide />
      ))}
      {filtered.length === 0 && (
        <p style={S.visMsg}>
          {hits.length === 0
            ? "No visits recorded yet."
            : "No visits match this filter."}
        </p>
      )}

      <div style={S.pager}>
        <span>
          {filtered.length > 0
            ? `${start + 1}–${start + shown.length} of ${filtered.length}`
            : "0 visits"}
        </span>
        <div style={S.pagerBtns}>
          <button
            type="button"
            onClick={() => changePage(cur - 1)}
            disabled={cur <= 1}
            style={{ ...S.pageBtn, ...(cur <= 1 ? S.pageBtnDisabled : {}) }}
          >
            ‹ Prev
          </button>
          <button
            type="button"
            onClick={() => changePage(cur + 1)}
            disabled={cur >= totalPages}
            style={{
              ...S.pageBtn,
              ...(cur >= totalPages ? S.pageBtnDisabled : {}),
            }}
          >
            Next ›
          </button>
        </div>
      </div>
    </main>
  );
}
