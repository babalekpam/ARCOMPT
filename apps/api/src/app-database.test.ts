import { describe, expect, it } from "vitest";
import { applicationDatabaseUrl } from "./app-database.js";

describe("API database login", () => {
  it("uses the managed development connection outside production", () => {
    expect(applicationDatabaseUrl({ NODE_ENV: "development" })).toBeUndefined();
  });

  it("refuses to fall back to the privileged managed connection in production", () => {
    expect(() => applicationDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: "postgres://owner@db/app" }))
      .toThrow("APP_DATABASE_URL absent");
  });

  it("chooses only the separately configured production app login", () => {
    expect(applicationDatabaseUrl({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://owner@db/app",
      APP_DATABASE_URL: "postgres://restricted@db/app",
    })).toBe("postgres://restricted@db/app");
  });
});