"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BrandLockup } from "@/components/brand/BrandMark";
import { CompanySwitcher } from "./CompanySwitcher";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { UserMenu } from "./UserMenu";
import { isPlatformPath } from "./PlatformNav";
import "./shell.css";

export function ShellRouteScope({ platformAdmin, children }: { platformAdmin: boolean; children: ReactNode }) {
  const global = platformAdmin && isPlatformPath(usePathname());
  return <div data-platform={global} className="app-shell md:grid md:grid-cols-[15rem_minmax(0,1fr)]">{children}</div>;
}

export function WorkspaceOnly({ platformAdmin, children }: { platformAdmin: boolean; children: ReactNode }) {
  const global = platformAdmin && isPlatformPath(usePathname());
  return global ? null : children;
}

export function BrandHomeLink({ name, platformAdmin, desktop = false }: { name: string; platformAdmin: boolean; desktop?: boolean }) {
  const global = platformAdmin && isPlatformPath(usePathname());
  return <Link href={global ? "/platform" : "/dashboard"} className={`brand-home shrink-0 ${desktop ? "mb-4 flex items-center gap-2 px-3 py-2" : "flex items-center gap-2 md:hidden"}`}>
    <BrandLockup name={name} size={desktop ? "md" : "sm"} />
  </Link>;
}

export function ShellHeader({ name, platformAdmin, tenantId, displayName }: { name: string; platformAdmin: boolean; tenantId: string | null; displayName: string }) {
  const global = platformAdmin && isPlatformPath(usePathname());
  return <header className="shell-header sticky top-0 z-20 flex items-center justify-between border-b backdrop-blur">
    <BrandHomeLink name={name} platformAdmin={platformAdmin} />
    <div className="shell-header-controls ml-auto">
      {!global && <CompanySwitcher tenantId={tenantId} platformAdmin={platformAdmin} />}
      <LocaleSwitcher compact />
      <UserMenu displayName={displayName} platformAdmin={platformAdmin} />
    </div>
  </header>;
}
