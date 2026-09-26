import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedClerkProvider } from "./ManagedClerkProvider";

vi.mock("@clerk/nextjs", () => ({ ClerkProvider: () => null }));
afterEach(() => vi.unstubAllGlobals());
const key = (host: string) => `pk_live_${Buffer.from(`clerk.${host}$`).toString("base64").replace(/=+$/, "")}`;

describe("managed Clerk provider SSR and browser wiring", () => {
  it("passes request-resolved key and empty proxy through during SSR", () => {
    const element = ManagedClerkProvider({ hosting: "managed", publishableKey: key("www.example.com"), proxyUrl: "", children: "content" });
    expect(element.props.publishableKey).toBe(key("www.example.com"));
    expect(element.props.proxyUrl).toBe("");
    expect(element.props.children).toBe("content");
  });
  it("uses browser hostname (not port) while preserving supplied proxy and appearance", () => {
    vi.stubGlobal("window", { location: { hostname: "second.example.com", host: "second.example.com:443" } });
    const appearance = { variables: { colorPrimary: "#0369a1" } };
    const element = ManagedClerkProvider({ hosting: "managed", publishableKey: key("first.example.com"), proxyUrl: "/provided-proxy", appearance, children: null });
    expect(element.props.publishableKey).toBe(key("second.example.com"));
    expect(element.props.proxyUrl).toBe("/provided-proxy");
    expect(element.props.appearance).toBe(appearance);
  });
  it("leaves explicit external tenant keys unchanged in the browser", () => {
    vi.stubGlobal("window", { location: { hostname: "vps.example.com" } });
    expect(ManagedClerkProvider({ hosting: "external", publishableKey: key("external.example.com"), children: null }).props.publishableKey).toBe(key("external.example.com"));
  });
});