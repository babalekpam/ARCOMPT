import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UserMenu } from "./UserMenu";
import { SideNav } from "./SideNav";
import { AdminModeSwitch } from "./AdminModeSwitch";

vi.mock("@clerk/nextjs", () => ({ useClerk: () => ({ signOut: vi.fn() }) }));
vi.mock("@/lib/i18n-client", () => ({ useT: () => (key: string) => key }));
vi.mock("next/navigation", () => ({ usePathname: () => "/platform" }));
describe("security and platform navigation", () => {
  it("always exposes security in the account menu but exposes the overview only for verified admins", () => {
    const ordinary = renderToStaticMarkup(<UserMenu displayName="Membre" />);
    expect(ordinary).toContain('href="/account/security"');
    expect(ordinary).not.toContain('href="/platform"');
    const admin = renderToStaticMarkup(<UserMenu displayName="Administrateur" platformAdmin />);
    expect(admin).toContain('href="/platform"');
    expect(admin).toContain("Vue d’ensemble admin");
  });
  it("adds matching security and overview links to the desktop shell", () => {
    const html = renderToStaticMarkup(<SideNav platformAdmin />);
    expect(html).toContain('href="/account/security"');
    expect(html).toContain('href="/platform"');
    expect(html).toContain('aria-current="page"');
  });
  it("shows a loading state rather than suggesting unaudited active access", () => {
    const html = renderToStaticMarkup(<AdminModeSwitch prominent />);
    expect(html).toContain("Vérification de l’accès administrateur");
    expect(html).not.toContain('href="/platform"');
  });
});
