import type { Metadata } from "next";
import "./globals.css";
import { SITE_HOST } from "@/lib/site";

export const metadata: Metadata = {
  title: SITE_HOST,
  robots: { index: false, follow: false }, // don't let search engines index it
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
