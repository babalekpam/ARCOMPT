import { describe, expect, it } from "vitest";
import { adminModeLabel, isAdminActivationContinuation, ADMIN_MFA_CONTINUATION, type AdminModeStatus } from "./admin-mode-ui";

const base: AdminModeStatus = { eligible: false, active: false, expiresAt: null };
describe("administrator mode UI", () => {
  it("distinguishes unavailable authority, approval, eligibility, activation and expiry", () => {
    expect(adminModeLabel(base)).toContain("non autorisé");
    expect(adminModeLabel({ ...base, eligible: true })).toContain("disponible");
    expect(adminModeLabel({ ...base, eligible: true, approvedPending: true })).toContain("approuvée");
    expect(adminModeLabel({ ...base, eligible: true, approvedPending: true, active: true })).toContain("actif");
    expect(adminModeLabel({ ...base, eligible: true, canReturn: true })).toContain("expiré ou révoqué");
  });
  it("accepts only a fixed local activation intent, never an arbitrary return URL", () => {
    expect(ADMIN_MFA_CONTINUATION).toBe("/account/security?admin=activate");
    expect(isAdminActivationContinuation("/account/security", "?admin=activate")).toBe(true);
    expect(isAdminActivationContinuation("/account/security", "?next=https://evil.example")).toBe(false);
    expect(isAdminActivationContinuation("/platform", "?admin=activate")).toBe(false);
    expect(isAdminActivationContinuation("/account/security", "?admin=deactivate")).toBe(false);
  });
});
