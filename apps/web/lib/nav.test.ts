import { describe, expect, it } from "vitest";
import { isActivePath, MAIN_NAV } from "./nav";

describe("invitation navigation", () => {
  it("links the main navigation to the existing invitation screen", () => {
    expect(MAIN_NAV.find((item) => item.labelKey === "nav.invitations")?.href).toBe("/firm/members");
  });

  it("highlights invitations without highlighting Cabinet twice", () => {
    expect(isActivePath("/firm/members", "/firm/members")).toBe(true);
    expect(isActivePath("/firm/members", "/firm")).toBe(false);
    expect(isActivePath("/firm/review", "/firm")).toBe(true);
  });
});