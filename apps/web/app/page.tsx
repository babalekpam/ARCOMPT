// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Metadata } from "next";
import { LandingPage } from "@/components/landing/LandingPage";
import { getLandingCopy } from "@/components/landing/content";
import { getLocale } from "@/lib/i18n-server";

export async function generateMetadata(): Promise<Metadata> {
  const copy = getLandingCopy(await getLocale());
  return {
    title: "ARCOMPT",
    description: copy.hero.body,
  };
}

export default async function HomePage() {
  const locale = await getLocale();
  return <LandingPage locale={locale} />;
}