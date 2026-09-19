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
