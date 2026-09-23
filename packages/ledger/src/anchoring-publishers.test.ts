import { createHash, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { anchorImprint, anchorReceipt, buildAnchor } from "./anchoring.js";
import {
  AnchorPublicationError,
  Rfc3161AnchorPublisher,
  SignedEndpointAnchorPublisher,
  anchorPublisherFromEnv,
  readSigningKey,
} from "./anchoring-publishers.js";
import { buildTimeStampRequest, generalizedTimeToIso, parseDer, parseTimeStampResponse } from "./anchoring-rfc3161.js";

const anchor = buildAnchor("11111111-1111-4111-8111-111111111111", "2025-03-01", ["a".repeat(64), "b".repeat(64)], null);

// --- petit écrivain DER, pour fabriquer une réponse de TSA crédible ---------
function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const b: number[] = [];
  let v = n;
  while (v > 0) {
    b.unshift(v & 0xff);
    v >>>= 8;
  }
  return Buffer.from([0x80 | b.length, ...b]);
}
const der = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag]), len(content.length), content]);
const seq = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts));
const int = (n: number) => der(0x02, Buffer.from([n]));
const oidSha256 = Buffer.from("0609608648016503040201", "hex");

/** TimeStampResp accordé, portant un TSTInfo avec empreinte, numéro de série et genTime. */
function grantedResponse(imprintHex: string, genTime = "20250302101530Z", serial = 0x2a): Buffer {
  const tstInfo = seq(
    int(1),
    Buffer.from("06042a030405", "hex"), // OID de politique quelconque
    seq(seq(oidSha256, der(0x05, Buffer.alloc(0))), der(0x04, Buffer.from(imprintHex, "hex"))),
    int(serial),
    der(0x18, Buffer.from(genTime, "latin1")),
  );
  const token = seq(Buffer.from("06092a864886f70d010702", "hex"), der(0xa0, der(0x04, tstInfo)));
  return seq(seq(int(0)), token);
}

describe("requête d'horodatage RFC 3161", () => {
  it("encode une TimeStampReq relisible pour l'empreinte du reçu", () => {
    const imprint = anchorImprint(anchor);
    const req = parseDer(buildTimeStampRequest(Buffer.from(imprint, "hex"), { certReq: true }));
    expect(req.tag).toBe(0x30);
    expect(req.children[0]!.content.toString("hex")).toBe("01"); // version v1
    const messageImprint = req.children[1]!;
    expect(messageImprint.children[0]!.children[0]!.content.toString("hex")).toBe("608648016503040201"); // sha256
    expect(messageImprint.children[1]!.content.toString("hex")).toBe(imprint);
    // certReq est posé : sans le certificat de la TSA, un auditeur ne peut pas vérifier hors ligne.
    expect(req.children.at(-1)!.tag).toBe(0x01);
  });

  it("refuse une empreinte qui n'est pas du sha256", () => {
    expect(() => buildTimeStampRequest(Buffer.alloc(20))).toThrow(/32 octets/);
  });

  it("lit l'heure attestée, le numéro de série et l'empreinte scellée", () => {
    const imprint = anchorImprint(anchor);
    const parsed = parseTimeStampResponse(grantedResponse(imprint));
    expect(parsed.status).toBe(0);
    expect(parsed.imprint).toBe(imprint);
    expect(parsed.serialNumber).toBe("2a");
    expect(parsed.genTime).toBe("2025-03-02T10:15:30.000Z");
    expect(parsed.token).toBeTruthy();
  });

  it("convertit un GeneralizedTime et rejette ce qui n'en est pas un", () => {
    expect(generalizedTimeToIso("20250302101530Z")).toBe("2025-03-02T10:15:30.000Z");
    expect(generalizedTimeToIso("02/03/2025")).toBeNull();
  });
});

describe("publieur RFC 3161", () => {
  const publisherWith = (fetchImpl: typeof fetch) => new Rfc3161AnchorPublisher({ url: "https://tsa.example.org/tsr", fetchImpl });
  const reply = (body: Buffer, status = 200) => new Response(body, { status, headers: { "content-type": "application/timestamp-reply" } });

  it("soumet l'empreinte du reçu, conserve le jeton et retient l'heure de la TSA", async () => {
    const imprint = anchorImprint(anchor);
    let submitted: Buffer | null = null;
    const publisher = publisherWith((async (_url: string, init: RequestInit) => {
      submitted = Buffer.from(init.body as Uint8Array);
      return reply(grantedResponse(imprint));
    }) as unknown as typeof fetch);

    const publication = await publisher.publish(anchor);
    // Ce qui part vers la TSA est l'empreinte du reçu, et rien d'autre : aucun
    // montant, aucun hash d'écriture, aucun identifiant de dossier en clair.
    expect(submitted).not.toBeNull();
    expect(submitted!.toString("hex")).toContain(imprint);
    expect(submitted!.toString("utf8")).not.toContain(anchor.tenantId);
    expect(publication.publisher).toBe("rfc3161");
    expect(publication.reference).toBe("rfc3161:tsa.example.org:2a");
    expect(publication.publishedAt).toBe("2025-03-02T10:15:30.000Z");
    expect(publication.proof).toBe(grantedResponse(imprint).toString("base64"));
  });

  it("refuse un jeton qui scelle une autre empreinte", async () => {
    const publisher = publisherWith((async () => reply(grantedResponse("f".repeat(64)))) as unknown as typeof fetch);
    await expect(publisher.publish(anchor)).rejects.toThrow(AnchorPublicationError);
  });

  it("refuse un horodatage rejeté par la TSA", async () => {
    const rejected = seq(seq(der(0x02, Buffer.from([2]))));
    const publisher = publisherWith((async () => reply(rejected)) as unknown as typeof fetch);
    await expect(publisher.publish(anchor)).rejects.toThrow(/refusé par la TSA/);
  });

  it("remonte une TSA injoignable sans jamais marquer l'ancre publiée", async () => {
    const publisher = publisherWith((async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    await expect(publisher.publish(anchor)).rejects.toThrow(/injoignable/);
  });
});

describe("publieur « dépôt signé »", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");

  it("signe le reçu d'une signature vérifiable avec la seule clé publique", async () => {
    let body = "";
    const publisher = new SignedEndpointAnchorPublisher({
      url: "https://depot.example.org/ancres",
      privateKey,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = String(init.body);
        return new Response(JSON.stringify({ reference: "DEP-2025-0001" }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });

    const publication = await publisher.publish(anchor);
    expect(publication.reference).toBe("DEP-2025-0001");

    const envelope = JSON.parse(body) as { receipt: string; signature: string; receiptSha256: string };
    expect(envelope.receipt).toBe(anchorReceipt(anchor));
    expect(envelope.receiptSha256).toBe(createHash("sha256").update(anchorReceipt(anchor)).digest("hex"));
    // Le contrôle qu'un auditeur refera : la signature couvre exactement le reçu.
    expect(cryptoVerify(null, Buffer.from(envelope.receipt, "utf8"), publicKey, Buffer.from(envelope.signature, "base64"))).toBe(true);
    expect(cryptoVerify(null, Buffer.from(envelope.receipt + " ", "utf8"), publicKey, Buffer.from(envelope.signature, "base64"))).toBe(false);
  });

  it("cite une référence reproductible quand le destinataire n'en rend aucune", async () => {
    const publisher = new SignedEndpointAnchorPublisher({
      url: "https://depot.example.org/ancres",
      privateKey,
      fetchImpl: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
    });
    expect((await publisher.publish(anchor)).reference).toMatch(/^endpoint:depot\.example\.org:[0-9a-f]{16}$/);
  });

  it("échoue franchement sur un refus du point de dépôt", async () => {
    const publisher = new SignedEndpointAnchorPublisher({
      url: "https://depot.example.org/ancres",
      privateKey,
      fetchImpl: (async () => new Response("non", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(publisher.publish(anchor)).rejects.toThrow(/HTTP 503/);
  });
});

describe("configuration du publieur", () => {
  const pkcs8 = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

  it("sans ANCHOR_PUBLISHER : fonction coupée et annoncée, jamais simulée", () => {
    const config = anchorPublisherFromEnv({});
    expect(config.publisher).toBeNull();
    expect(config.problems).toEqual([]);
    expect(config.degraded.join(" ")).toMatch(/Ancrage externe désactivé/);
  });

  it("refuse le publieur de test en production, et l'accepte ailleurs en le disant", () => {
    const prod = anchorPublisherFromEnv({ NODE_ENV: "production", ANCHOR_PUBLISHER: "memory" });
    expect(prod.publisher).toBeNull();
    expect(prod.problems.join(" ")).toMatch(/memory/);

    const dev = anchorPublisherFromEnv({ ANCHOR_PUBLISHER: "memory" });
    expect(dev.publisher).not.toBeNull();
    expect(dev.degraded.join(" ")).toMatch(/SIMULATION/);
  });

  it("refuse une configuration posée à moitié", () => {
    expect(anchorPublisherFromEnv({ ANCHOR_PUBLISHER: "rfc3161" }).problems.join(" ")).toMatch(/ANCHOR_TSA_URL/);
    const half = anchorPublisherFromEnv({ ANCHOR_PUBLISHER: "endpoint", ANCHOR_ENDPOINT_URL: "https://d.example.org" });
    expect(half.publisher).toBeNull();
    expect(half.problems.join(" ")).toMatch(/ANCHOR_SIGNING_KEY/);
    expect(anchorPublisherFromEnv({ ANCHOR_PUBLISHER: "registre-public" }).problems.join(" ")).toMatch(/inconnue/);
  });

  it("exige https en production", () => {
    const config = anchorPublisherFromEnv({ NODE_ENV: "production", ANCHOR_PUBLISHER: "rfc3161", ANCHOR_TSA_URL: "http://tsa.example.org" });
    expect(config.problems.join(" ")).toMatch(/https/);
  });

  it("construit les publieurs réels quand tout est là", () => {
    const tsa = anchorPublisherFromEnv({ ANCHOR_PUBLISHER: "rfc3161", ANCHOR_TSA_URL: "https://tsa.example.org" });
    expect(tsa.publisher?.name).toBe("rfc3161");
    const endpoint = anchorPublisherFromEnv({ ANCHOR_PUBLISHER: "endpoint", ANCHOR_ENDPOINT_URL: "https://d.example.org", ANCHOR_SIGNING_KEY: pkcs8 });
    expect(endpoint.publisher?.name).toBe("endpoint");
    expect(endpoint.problems).toEqual([]);
  });

  it("refuse une clé de signature qui n'est pas Ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    expect(() => readSigningKey(rsa)).toThrow(/Ed25519/);
    expect(anchorPublisherFromEnv({ ANCHOR_PUBLISHER: "endpoint", ANCHOR_ENDPOINT_URL: "https://d.example.org", ANCHOR_SIGNING_KEY: rsa }).problems.join(" ")).toMatch(/ANCHOR_SIGNING_KEY/);
  });
});
