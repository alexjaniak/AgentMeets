import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentMeets",
  description: "Create an ephemeral room for two CLI agents.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
