import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRecentClamAvDatabase, ClamAvScanner, createScannerFromEnv } from "./security.js";

const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function scanner(reply: string) {
  const server = createServer((socket) => socket.on("data", () => socket.end(reply)));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  return new ClamAvScanner("127.0.0.1", address.port, 500);
}

describe("ClamAvScanner", () => {
  it("accepts only a clean stream response", async () => {
    const scan = await scanner("stream: OK\0");
    await expect(scan.scan(Buffer.from("safe document"))).resolves.toEqual({ clean: true });
  });

  it("rejects infected content", async () => {
    const scan = await scanner("stream: Eicar-Test-Signature FOUND\0");
    await expect(scan.scan(Buffer.from("test file"))).resolves.toEqual({
      clean: false, signature: "Eicar-Test-Signature",
    });
  });

  it("does not treat a protocol error ending in OK as clean", async () => {
    const scan = await scanner("stream: ERROR: engine not ready OK\0");
    await expect(scan.scan(Buffer.from("test file"))).rejects.toThrow("réponse inattendue");
  });

  it("fails closed when the scanner is unavailable", async () => {
    const scan = await scanner("stream: OK\0");
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    await expect(scan.scan(Buffer.from("test file"))).rejects.toThrow();
  });

  it("scans through a Unix socket and rejects infected files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clamav-socket-"));
    directories.push(directory);
    const path = join(directory, "clamd.sock");
    const server = createServer((socket) => socket.on("data", () => socket.end("stream: Eicar-Test-Signature FOUND\0")));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const scan = createScannerFromEnv({ NODE_ENV: "production", CLAMAV_SOCKET: path });
    await expect(scan.scan(Buffer.from("test file"))).resolves.toEqual({
      clean: false, signature: "Eicar-Test-Signature",
    });
    expect(() => createScannerFromEnv({ CLAMAV_SOCKET: path, CLAMAV_HOST: "localhost" })).toThrow("ensemble");
  });
});

describe("local signature freshness", () => {
  async function database(buildTime: string) {
    const directory = await mkdtemp(join(tmpdir(), "clamav-test-"));
    directories.push(directory);
    await writeFile(join(directory, "daily.cvd"), `ClamAV-VDB:${buildTime}:1:1:90:hash:signature`);
    return directory;
  }

  it("accepts a recent daily database", async () => {
    const directory = await database("23 Sep 2026 06-24 +0000");
    await expect(assertRecentClamAvDatabase(directory, Date.parse("2026-09-24T00:00:00Z"))).resolves.toBeUndefined();
  });

  it("rejects obsolete and malformed signatures", async () => {
    const directory = await database("01 Jan 2026 00-00 +0000");
    await expect(assertRecentClamAvDatabase(directory, Date.parse("2026-09-24T00:00:00Z"))).rejects.toThrow("périmées");
    await writeFile(join(directory, "daily.cvd"), "broken");
    await expect(assertRecentClamAvDatabase(directory)).rejects.toThrow("périmées");
  });

  it("rejects an upload before connecting when definitions are stale", async () => {
    const directory = await database("01 Jan 2026 00-00 +0000");
    const scan = new ClamAvScanner("127.0.0.1", 3310, 500, directory);
    await expect(scan.scan(Buffer.from("test file"))).rejects.toThrow("périmées");
  });
});