"use client";

import { useState } from "react";
import { QrExport } from "./qr-block";
import { S } from "./styles";

// Standalone QR generator in the sidebar: paste any URL and copy / download
// its QR code without creating a short link. Everything happens client-side —
// nothing is saved. Collapsed to one text row until opened.
export function QrMaker() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const value = text.trim();

  return (
    <div style={S.qrMaker}>
      <button
        type="button"
        onClick={() => setOpen((cur) => !cur)}
        style={S.qrMakerToggle}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} QR code for any URL
      </button>
      {open && (
        <div style={S.qrMakerBody}>
          <input
            type="text"
            inputMode="url"
            className="field"
            placeholder="Paste any URL"
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={S.createInput}
            aria-label="QR code content"
          />
          {/* key={value} resets a lingering "✓ Copied" when the URL changes. */}
          {value && <QrExport key={value} value={value} fileName="qr-code.png" />}
        </div>
      )}
    </div>
  );
}
