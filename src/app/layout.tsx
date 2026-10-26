import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SlateMail — Email, with room to think",
  description: "A private, considered email client for Gmail.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
