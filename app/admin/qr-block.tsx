"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { S } from "./styles";

// Pixel size of the PNG that Copy / Download produce — print resolution, per
// the design, while the on-screen preview stays small.
const QR_EXPORT_SIZE = 1024;

// The full origin (scheme + host) used to build absolute QR-code URLs.
// Falls back to the production domain during prerendering.
function shortOrigin() {
  if (typeof window !== "undefined") return window.location.origin;
  return "https://carolanne.link";
}

// The value a link's QR code encodes: the absolute short URL, tagged with
// ?src=qr so the proxy can count scans separately from ordinary clicks.
// Exported for the mobile dashboard's offscreen QR download.
export function qrValue(slug: string) {
  return `${shortOrigin()}/${slug}?src=qr`;
}

// The detail pane's QR panel: a small preview plus Copy / Download buttons
// that both read from an offscreen print-resolution canvas. Rendered with
// key={slug} so switching links resets any lingering "✓ Copied".
export function QrPanel({ slug }: { slug: string }) {
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
    a.download = `${slug}-qr.png`;
    a.click();
  }

  return (
    <div style={S.qrPanel}>
      <div style={S.qrBox}>
        <QRCodeCanvas value={qrValue(slug)} size={112} marginSize={2} />
      </div>
      <div ref={exportRef} style={S.qrHidden} aria-hidden>
        <QRCodeCanvas value={qrValue(slug)} size={QR_EXPORT_SIZE} marginSize={2} />
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
