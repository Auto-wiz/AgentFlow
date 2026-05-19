import type { Metadata } from "next";

import "./globals.css";

import { AppChrome } from "./components/app-chrome";
import { WorkspaceAuthGate } from "./components/workspace-auth-gate";
import { WorkspaceAuthProvider } from "./components/workspace-auth-provider";

export const metadata: Metadata = {
  title: "AgentFlow",
  description: "GoHighLevel appointments and payment tracking"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WorkspaceAuthProvider>
          <WorkspaceAuthGate />
          <AppChrome>{children}</AppChrome>
        </WorkspaceAuthProvider>
      </body>
    </html>
  );
}
