import type { ReactNode } from "react";

import { AdminSettingsSubnav } from "./admin-settings-subnav";

export default function AdminSettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AdminSettingsSubnav />
      {children}
    </>
  );
}
