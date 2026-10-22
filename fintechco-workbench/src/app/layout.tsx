import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FinTechCo Agentic Workbench",
  description: "Live headless Claude Code workflows across SRE, Data Science and Quant teams.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
