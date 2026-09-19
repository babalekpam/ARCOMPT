import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ARCOMPT",
  description: "La comptabilité intelligente des PME de l'espace OHADA.",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-screen bg-white text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">{children}</body>
    </html>
  );
}
