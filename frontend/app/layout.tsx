import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "IPS AI — Centralized AI Brain",
  description:
    "IPS, Inc. private AI platform — oilfield electrical services intelligence for Southeast New Mexico and the Permian Basin.",
  icons: { icon: "/ips-logo.png" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
