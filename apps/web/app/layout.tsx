import type { Metadata, Viewport } from "next";
import { I18nProvider } from "@/lib/i18n-client";
import { getMessages } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n-server";
import { ServiceWorkerRegistrar } from "@/components/pwa/ServiceWorkerRegistrar";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ARCOMPT", template: "%s · ARCOMPT" },
  description: "La comptabilité intelligente des PME de l'espace OHADA.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "ARCOMPT", statusBarStyle: "default" },
  // Le logo est matriciel : pas de favicon SVG. `favicon.ico` porte les trames
  // 16/32/48 sur plaque blanche — voir docs/BRAND.md, § « Lisibilité en petit ».
  icons: {
    icon: [
      { url: "/favicon.ico", type: "image/x-icon", sizes: "48x48 32x32 16x16" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale}>
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        <I18nProvider locale={locale} messages={getMessages(locale)}>
          {children}
          <ServiceWorkerRegistrar />
        </I18nProvider>
      </body>
    </html>
  );
}
