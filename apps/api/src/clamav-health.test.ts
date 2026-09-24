import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkClamd } from "./clamav-health.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function serve(reply: string) {
  const server = createServer((socket) => socket.on("data", () => socket.end(reply)));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  return address.port;
}

describe("ClamAV readiness", () => {
  it("requires a real PONG", async () => {
    const port = await serve("PONG\0");
    await expect(checkClamd("127.0.0.1", port)).resolves.toBeUndefined();
  });

  it("rejects a listening service that is not ready", async () => {
    const port = await serve("ERROR\0");
    await expect(checkClamd("127.0.0.1", port)).rejects.toThrow("did not answer PONG");
  });

  it("rejects an unavailable scanner", async () => {
    const port = await serve("PONG\0");
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    await expect(checkClamd("127.0.0.1", port)).rejects.toThrow();
  });
});