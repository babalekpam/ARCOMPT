// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Metadata, Viewport } from "next";
import { I18nProvider } from "@/lib/i18n-client";
import { getMessages, translate } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n-server";
import { ServiceWorkerRegistrar } from "@/components/pwa/ServiceWorkerRegistrar";
import { ClerkProvider } from "@clerk/nextjs";
import { enUS, frFR } from "@clerk/localizations";
import { shadcn } from "@clerk/themes";
import { parseClerkHosting } from "@/lib/clerk-hosting";
import "./globals.css";

/**
 * La description du site est ce que montrent un moteur de recherche et une
 * carte de partage : elle suit la langue choisie, comme le reste de
 * l'interface. Elle est donc calculée par requête et non figée à la
 * compilation.
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return {
    title: { default: "ARCOMPT", template: "%s · ARCOMPT" },
    description: translate(locale, "app.tagline"),
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
}

export const viewport: Viewport = {
  themeColor: "#0f172a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const clerkHosting = parseClerkHosting(process.env.NEXT_PUBLIC_CLERK_HOSTING);
  const clerkProxyUrl = process.env.NEXT_PUBLIC_CLERK_PROXY_URL?.trim();
  return (
    <html lang={locale}>
      <body suppressHydrationWarning className="min-h-screen bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        <ClerkProvider
          {...(clerkHosting === "managed" && clerkProxyUrl ? { proxyUrl: clerkProxyUrl } : {})}
          localization={locale === "fr" ? frFR : enUS}
          appearance={{
            theme: shadcn,
            options: {
              logoImageUrl: "/brand/arcompt-mark-128.png",
            },
            variables: {
              colorPrimary: "#0369a1",
              colorForeground: "#0f172a",
              colorMutedForeground: "#64748b",
              colorBackground: "#ffffff",
              colorInput: "#ffffff",
              colorInputForeground: "#0f172a",
              colorNeutral: "#cbd5e1",
              borderRadius: "0.75rem",
              fontFamily: "inherit",
            },
            elements: {
              card: "shadow-none border border-slate-200",
              cardBox: "bg-white rounded-2xl",
              logoImage: "h-12 w-12 object-contain",
              formButtonPrimary: "bg-sky-700 hover:bg-sky-800",
              footerActionLink: "text-sky-700 hover:text-sky-900",
            },
          }}
        >
          <I18nProvider locale={locale} messages={getMessages(locale)}>
            {children}
            <ServiceWorkerRegistrar />
          </I18nProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
