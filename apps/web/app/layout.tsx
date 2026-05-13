import type { Metadata } from "next";
import Link from "next/link";

import "./globals.css";

export const metadata: Metadata = {
  title: "AgentFlow",
  description: "Centralized GoHighLevel pending replies inbox"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="shell">
          <header className="header">
            <Link href="/">
              <div className="eyebrow">AgentFlow</div>
              <h1>Unified agency inbox</h1>
            </Link>
            <div className="badge-row">
              <Link className="button secondary" href="/threads">
                Pending replies
              </Link>
              <Link className="button secondary" href="/appointments">
                Appointments
              </Link>
            </div>
          </header>
          {children}
        </main>
      </body>
    </html>
  );
}
