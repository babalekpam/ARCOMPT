import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PlatformAiPage from "./page";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), admin: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAuthContext: mocks.auth }));
vi.mock("@/lib/platform", () => ({ getPlatformAdmin: mocks.admin }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/components/platform/PlatformAiSettings", () => ({ PlatformAiSettings: () => <div>Paramètres protégés</div> }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({});
  mocks.admin.mockResolvedValue(true);
  mocks.redirect.mockImplementation(() => { throw new Error("redirect"); });
});
describe("platform AI route guard", () => {
  it("requires authentication and server-verified platform privileges", async () => {
    const html = renderToStaticMarkup(await PlatformAiPage());
    expect(mocks.auth).toHaveBeenCalledOnce();
    expect(mocks.admin).toHaveBeenCalledOnce();
    expect(html).toContain("Fournisseurs IA");
    expect(html).toContain("Paramètres protégés");
    expect(html).toContain('href="/platform"');
  });
  it("redirects ordinary users before rendering credentials", async () => {
    mocks.admin.mockResolvedValue(false);
    await expect(PlatformAiPage()).rejects.toThrow("redirect");
    expect(mocks.redirect).toHaveBeenCalledWith("/dashboard");
  });
  it("never probes admin settings after authentication fails", async () => {
    mocks.auth.mockRejectedValue(new Error("expired"));
    await expect(PlatformAiPage()).rejects.toThrow("expired");
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});
