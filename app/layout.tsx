import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Video Dubbing",
  description: "Client-side AI dubbing with OpenAI and ffmpeg.wasm"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
