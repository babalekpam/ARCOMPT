import { describe, expect, it } from "vitest";
import { formatMemberReference, mapMember } from "./organization-service.js";

const member = {
  company_id: "company-1",
  company_name: "Bêta SARL",
  user_id: "user-1",
  registration_number: "7",
  email: null,
  display_name: "Member",
  role: "ACCOUNTANT",
};

describe("visible member references", () => {
  it("uses company name, current exercise and the platform-wide registration order", () => {
    expect(formatMemberReference("Bêta SARL", "2026", "7")).toBe("BETA-SARL-2026-000007");
    expect(mapMember({ ...member, exercise_code: "2026" }).reference).toBe("BETA-SARL-2026-000007");
    expect(mapMember({ ...member, exercise_code: "2027" }).reference).toBe("BETA-SARL-2027-000007");
  });

  it("does not pretend an exercise is current when none is configured", () => {
    expect(mapMember({ ...member, exercise_code: null }).reference).toBeNull();
  });

  it("rejects a missing registration number instead of using an unstable row rank", () => {
    expect(() => mapMember({ ...member, registration_number: null, exercise_code: "2026" })).toThrow();
  });
});