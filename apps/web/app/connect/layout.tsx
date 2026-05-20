import { Suspense, type ReactNode } from "react";

export default function ConnectLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <section className="module-shell" style={{ maxWidth: 620, margin: "0 auto" }}>
          <div className="panel" style={{ padding: 22 }}>
            <p className="muted">Loading…</p>
          </div>
        </section>
      }
    >
      {children}
    </Suspense>
  );
}
