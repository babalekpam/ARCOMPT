import { describe, expect, it } from "vitest";
import { assertDistinctDatabaseUrls, queueDatabaseUrl } from "./queue-database.js";

describe("queue database login", () => {
  it("requires the dedicated login in production", () => {
    expect(() => queueDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: "postgres://owner/db" }))
      .toThrow("QUEUE_DATABASE_URL absent");
  });

  it("never silently reuses the development connection in production", () => {
    expect(queueDatabaseUrl({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://owner/db",
      QUEUE_DATABASE_URL: "postgres://queue/db",
    })).toBe("postgres://queue/db");
  });

  it("rejects one URL for both least-privilege roles", () => {
    expect(() => assertDistinctDatabaseUrls("postgres://app/db", "postgres://app/db"))
      .toThrow("connexions distinctes");
  });
});