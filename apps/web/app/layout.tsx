import type { Metadata } from "next";
import { AppChrome } from "./components/app-chrome";

import "./globals.css";

export const metadata: Metadata = {
  title: "AgentFlow",
  description: "Centralized GoHighLevel pending replies inbox"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppChrome>{children}</AppChrome>
      </body>
    </html>
  );
}
