"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { S } from "./styles";

// The full origin (scheme + host) used to build absolute QR-code URLs.
// Falls back to the production domain during prerendering.
function shortOrigin() {
  if (typeof window !== "undefined") return window.location.origin;
  return "https://carolanne.link";
}

// The value a link's QR code encodes: the absolute short URL, tagged with
// ?src=qr so the proxy can count scans separately from ordinary clicks.
function qrValue(slug: string) {
  return `${shortOrigin()}/${slug}?src=qr`;
}

// A QR code (PNG) for one link. It's copied to the clipboard automatically when
// it appears, with buttons to copy again or download it.
export function QrBlock({ slug }: { slug: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("");

  function canvasPng(): Promise<Blob | null> {
    const canvas = ref.current?.querySelector("canvas");
    if (!canvas) return Promise.resolve(null);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  async function copy() {
    try {
      const blob = await canvasPng();
      if (!blob) throw new Error("no image");
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      setStatus("Copied to clipboard ✓");
    } catch {
      // Browsers block clipboard writes without a fresh click / when the tab
      // isn't focused — fall back to asking the user to press the button.
      setStatus('Press "Copy PNG" to copy');
    }
  }

  async function download() {
    const canvas = ref.current?.querySelector("canvas");
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${slug}-qr.png`;
    a.click();
  }

  // Best-effort auto-copy as soon as the code renders. The status setState
  // inside copy() only fires after the async clipboard write resolves, so the
  // sync-setState rule's complaint is a false positive here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    copy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={S.qrBlock}>
      <div ref={ref} style={S.qrCanvas}>
        <QRCodeCanvas value={qrValue(slug)} size={148} marginSize={2} />
      </div>
      <div style={S.actions}>
        <button type="button" onClick={copy} style={S.secondaryBtn}>
          Copy PNG
        </button>
        <button type="button" onClick={download} style={S.secondaryBtn}>
          Download PNG
        </button>
      </div>
      {status && <span style={S.hitMeta}>{status}</span>}
    </div>
  );
}
