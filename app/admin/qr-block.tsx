"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { SITE_HOST } from "@/lib/site";
import { S } from "./styles";

// Pixel size of the PNG that Copy / Download produce — print resolution, per
// the design, while the on-screen preview stays small.
const QR_EXPORT_SIZE = 1024;

// The full origin (scheme + host) used to build absolute QR-code URLs.
// Falls back to the configured site host during prerendering.
function shortOrigin() {
  if (typeof window !== "undefined") return window.location.origin;
  return `https://${SITE_HOST}`;
}

// The value a link's QR code encodes: the absolute short URL, tagged with
// ?src=qr so the proxy can count scans separately from ordinary clicks.
// Exported for the mobile dashboard's offscreen QR download.
export function qrValue(slug: string) {
  return `${shortOrigin()}/${slug}?src=qr`;
}

// Extra short-link domains for printed QR codes, from the build-time
// NEXT_PUBLIC_QR_DOMAINS list (comma-separated bare hosts). The proxy only
// looks at the path, so any domain attached to this deployment resolves the
// same slugs — the toggle just changes which host the QR encodes.
const ALT_QR_HOSTS = (process.env.NEXT_PUBLIC_QR_DOMAINS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

// A QR code with Copy / Download buttons that both read from an offscreen
// print-resolution canvas. Shared by the detail pane's QrPanel (short links)
// and the sidebar's QrMaker (arbitrary URLs).
export function QrExport({
  value,
  fileName,
}: {
  value: string;
  fileName: string;
}) {
  const exportRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function exportCanvas(): HTMLCanvasElement | null {
    return exportRef.current?.querySelector("canvas") ?? null;
  }

  async function copy() {
    try {
      const canvas = exportCanvas();
      if (!canvas) throw new Error("no canvas");
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!blob) throw new Error("no image");
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — the Download button still works.
    }
  }

  function download() {
    const canvas = exportCanvas();
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = fileName;
    a.click();
  }

  return (
    <div style={S.qrPanel}>
      <div style={S.qrBox}>
        <QRCodeCanvas value={value} size={112} marginSize={2} />
      </div>
      <div ref={exportRef} style={S.qrHidden} aria-hidden>
        <QRCodeCanvas value={value} size={QR_EXPORT_SIZE} marginSize={2} />
      </div>
      <button
        type="button"
        onClick={copy}
        style={{ ...S.qrCopyBtn, ...(copied ? S.qrCopyBtnCopied : {}) }}
      >
        {copied ? "✓ Copied" : "Copy QR code"}
      </button>
      <button type="button" onClick={download} style={S.qrDownloadBtn}>
        Download PNG
      </button>
    </div>
  );
}

// The detail pane's QR panel for a short link. Rendered with key={slug} so
// switching links resets any lingering "✓ Copied". When alternate QR domains
// are configured, a segmented toggle picks which host the code encodes; the
// current host stays the default and the filename marks alternate-domain
// downloads so the PNGs don't collide.
export function QrPanel({ slug }: { slug: string }) {
  const ownHost = typeof window !== "undefined" ? window.location.host : "";
  const hosts = ALT_QR_HOSTS.filter((h) => h !== ownHost);
  const [altHost, setAltHost] = useState<string | null>(null);

  const qr = altHost ? (
    <QrExport
      key={altHost}
      value={`https://${altHost}/${slug}?src=qr`}
      fileName={`${altHost}-${slug}-qr.png`}
    />
  ) : (
    <QrExport key="own" value={qrValue(slug)} fileName={`${slug}-qr.png`} />
  );

  if (hosts.length === 0) return qr;

  return (
    <div style={S.qrPanel}>
      <div style={S.segmented}>
        <button
          type="button"
          onClick={() => setAltHost(null)}
          style={{ ...S.segBtn, ...(altHost ? {} : S.segBtnActive) }}
        >
          {ownHost || "this site"}
        </button>
        {hosts.map((h) => (
          <button
            key={h}
            type="button"
            onClick={() => setAltHost(h)}
            style={{ ...S.segBtn, ...(altHost === h ? S.segBtnActive : {}) }}
          >
            {h}
          </button>
        ))}
      </div>
      {qr}
    </div>
  );
}
