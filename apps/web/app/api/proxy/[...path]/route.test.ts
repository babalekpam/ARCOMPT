import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { acceptsMutationOrigin } from "@/lib/proxy-origin";

const request = (headers: Record<string, string>) => new NextRequest("https://internal.example/api/proxy/session/bootstrap", { method: "POST", headers });

describe("authenticated API proxy mutation origin", () => {
  it("accepts browser requests from the same origin", () => {
    expect(acceptsMutationOrigin(request({ "sec-fetch-site": "same-origin", origin: "https://app.example" }))).toBe(true);
  });

  it("rejects same-site sibling origins and cross-site requests", () => {
    expect(acceptsMutationOrigin(request({ "sec-fetch-site": "same-site", origin: "https://other.example" }))).toBe(false);
    expect(acceptsMutationOrigin(request({ "sec-fetch-site": "cross-site", origin: "https://external.example" }))).toBe(false);
  });

  it("checks explicit Origin when a client does not send Fetch Metadata", () => {
    expect(acceptsMutationOrigin(request({ origin: "https://internal.example" }))).toBe(true);
    expect(acceptsMutationOrigin(request({ origin: "https://other.example" }))).toBe(false);
  });
});