import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TON — Hitta ljud. Behåll musiken.",
  description:
    "Sök, lyssna och spara musik med tydliga licenser från Internet Archive och Wikimedia Commons. Konvertera dina egna ljudfiler till riktig MP3.",
  applicationName: "TON Music Downloader",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#111310",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="sv">
      <body>{children}</body>
    </html>
  );
}
