import { describe, expect, it } from "vitest";
import { shouldShowPlatformPicker } from "./platform";

describe("platform admin dashboard routing", () => {
  it("goes to the picker only until an admin selects a company", () => {
    expect(shouldShowPlatformPicker(true, null)).toBe(true);
    expect(shouldShowPlatformPicker(true, "cccccccc-cccc-4ccc-8ccc-cccccccccccc")).toBe(false);
    expect(shouldShowPlatformPicker(false, null)).toBe(false);
    expect(shouldShowPlatformPicker(false, "cccccccc-cccc-4ccc-8ccc-cccccccccccc")).toBe(false);
  });
});