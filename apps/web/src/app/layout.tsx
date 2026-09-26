import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

// The CSP nonce (src/middleware.ts) is per request, so pages cannot be prerendered at build
// time: a static page would carry no nonce and its scripts would be blocked.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Plataforma LegalTech de Tránsito y Transporte",
  description: "Plataforma en construcción.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-screen bg-white text-slate-900 antialiased">{children}</body>
    </html>
  );
}
