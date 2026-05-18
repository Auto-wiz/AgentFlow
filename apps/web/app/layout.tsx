import type { Metadata } from "next";
import Link from "next/link";

import "./globals.css";

export const metadata: Metadata = {
  title: "AgentFlow",
  description: "Appointments and payment verification for GoHighLevel"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="shell">
          <header className="header">
            <Link href="/">
              <div className="eyebrow">AgentFlow</div>
              <h1>Appointments payment tracker</h1>
            </Link>
            <div className="badge-row">
              <Link className="button secondary" href="/appointments">
                Appointments
              </Link>
              <Link className="button secondary" href="/debug">
                Debug
              </Link>
            </div>
          </header>
          {children}
        </main>
      </body>
    </html>
  );
}
