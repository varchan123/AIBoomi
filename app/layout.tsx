import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Plant Copilot",
  description: "AI plant memory for faster, evidence-grounded RCA",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
