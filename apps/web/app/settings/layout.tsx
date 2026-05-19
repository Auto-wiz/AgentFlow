import type { ReactNode } from "react";

import { SettingsSubnav } from "./settings-subnav";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <section className="module-shell">
      <SettingsSubnav />
      {children}
    </section>
  );
}
