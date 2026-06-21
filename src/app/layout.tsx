import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Thabiti — provably correct usage metering",
  description:
    "Watermark-bounded temporal determinism: the billed aggregate for a window is byte-identical across replays and immutable once sealed.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
