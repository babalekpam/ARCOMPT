"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export const isPlatformPath = (pathname: string) => pathname === "/platform" || pathname.startsWith("/platform/");

const items = [
  { href: "/platform", label: "Vue d’ensemble", icon: "overview" },
  { href: "/platform#organizations", label: "Organisations", icon: "organizations" },
  { href: "/platform/ai", label: "Fournisseurs IA", mobileLabel: "IA", icon: "ai" },
  { href: "/account", label: "Mon compte", mobileLabel: "Compte", icon: "account" },
] as const;

function PlatformIcon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    organizations: <><path d="M4 21V4h10v17M14 10h6v11M2 21h20M7 8h4M7 12h4M7 16h4M17 14h1M17 18h1" /></>,
    ai: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4M10 10h4v4h-4z" /></>,
    account: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export function PlatformNav({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();
  return <nav aria-label={mobile ? "Navigation mobile plateforme" : "Administration plateforme"} className={`platform-nav ${mobile ? "platform-nav-mobile fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t md:hidden" : "platform-nav-desktop flex flex-col gap-1"}`}>
    {!mobile && <p className="px-3 pb-2 pt-2 text-[11px] font-semibold uppercase tracking-wider">Administration plateforme</p>}
    {items.map((item) => <Link key={item.href} href={item.href} aria-current={pathname === item.href ? "page" : undefined}>
      <PlatformIcon name={item.icon} /><span>{"mobileLabel" in item && mobile ? item.mobileLabel : item.label}</span>
    </Link>)}
    {!mobile && <Link href="/account/security"><PlatformIcon name="account" /><span>Sécurité du compte</span></Link>}
  </nav>;
}
