import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "carolanne.link",
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
