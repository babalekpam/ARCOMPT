/**
 * Horodatage RFC 3161 : le publieur d'ancres qu'un auditeur peut contrôler seul.
 *
 * Le principe. On soumet à une autorité d'horodatage (TSA) l'empreinte sha256
 * du reçu d'ancre — jamais le reçu lui-même, encore moins des données
 * comptables : la TSA n'apprend rien du dossier. Elle renvoie un jeton signé
 * qui atteste « cette empreinte m'a été présentée à telle heure ». Ce jeton est
 * conservé tel quel dans `ledger_anchor.publication_proof` (base64). Des années
 * plus tard, sans ARCOMPT et sans nous, l'auditeur reconstitue le reçu depuis
 * la base ou l'export, calcule son empreinte, et vérifie le jeton avec la
 * chaîne de certification publique de la TSA :
 *
 *   openssl ts -reply -in ancre.tsr -text        # empreinte et heure attestées
 *   openssl ts -verify -data recu.txt -in ancre.tsr -CAfile tsa-ca.pem
 *
 * Pourquoi de l'ASN.1 écrit à la main. Le paquet `@arcompt/ledger` ne dépend
 * que de `postgres` ; ajouter une bibliothèque ASN.1 pour deux structures
 * (TimeStampReq à écrire, TimeStampResp à lire) coûterait plus qu'il ne
 * rapporte. On n'implémente donc que le sous-ensemble DER réellement employé,
 * et on ne prétend pas vérifier la signature du jeton : c'est le travail
 * d'OpenSSL, avec la chaîne de certification que nous n'avons pas à embarquer.
 */

import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Écriture DER (le strict nécessaire)
// ---------------------------------------------------------------------------

const TAG = { INTEGER: 0x02, BIT_STRING: 0x03, OCTET_STRING: 0x04, NULL: 0x05, OID: 0x06, UTF8: 0x0c, SEQUENCE: 0x30, GENERALIZED_TIME: 0x18, BOOLEAN: 0x01 } as const;

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

/** Entier DER positif, en complément à deux (octet de tête nul si le bit de signe est posé). */
function derInteger(value: Buffer | number): Buffer {
  let bytes = typeof value === "number" ? Buffer.from([value]) : Buffer.from(value);
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0 && (bytes[i + 1]! & 0x80) === 0) i++;
  bytes = bytes.subarray(i);
  if ((bytes[0]! & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return der(TAG.INTEGER, bytes);
}

/** Identifiant d'objet depuis sa notation pointée (1.2.840…). */
export function derOid(dotted: string): Buffer {
  const parts = dotted.split(".").map((p) => Number(p));
  if (parts.length < 2 || parts.some((p) => !Number.isInteger(p) || p < 0)) throw new Error(`OID invalide : ${dotted}`);
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    let v = part >>> 7;
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(...chunk);
  }
  return der(TAG.OID, Buffer.from(out));
}

const OID_SHA256 = "2.16.840.1.101.3.4.2.1";

export interface TimeStampRequestOptions {
  /** OID de politique d'horodatage exigé de la TSA, si le contrat en impose un. */
  policyOid?: string;
  /** Demander le certificat de la TSA dans le jeton : indispensable pour vérifier hors ligne. */
  certReq?: boolean;
  /** Nonce ; par défaut 64 bits aléatoires — il lie la réponse à cette requête. */
  nonce?: Buffer;
}

/**
 * TimeStampReq (RFC 3161 §2.4.1) pour une empreinte sha256.
 *
 *   TimeStampReq ::= SEQUENCE {
 *     version INTEGER { v1(1) }, messageImprint MessageImprint,
 *     reqPolicy TSAPolicyId OPTIONAL, nonce INTEGER OPTIONAL,
 *     certReq BOOLEAN DEFAULT FALSE, extensions [0] IMPLICIT Extensions OPTIONAL }
 */
export function buildTimeStampRequest(sha256Digest: Buffer, opts: TimeStampRequestOptions = {}): Buffer {
  if (sha256Digest.length !== 32) throw new Error("Empreinte sha256 attendue (32 octets)");
  const algorithm = der(TAG.SEQUENCE, Buffer.concat([derOid(OID_SHA256), der(TAG.NULL, Buffer.alloc(0))]));
  const messageImprint = der(TAG.SEQUENCE, Buffer.concat([algorithm, der(TAG.OCTET_STRING, sha256Digest)]));
  const certReq = opts.certReq ?? true;
  return der(
    TAG.SEQUENCE,
    Buffer.concat([
      derInteger(1),
      messageImprint,
      opts.policyOid ? derOid(opts.policyOid) : Buffer.alloc(0),
      derInteger(opts.nonce ?? randomBytes(8)),
      // DEFAULT FALSE : en DER, la valeur par défaut ne s'encode pas.
      certReq ? der(TAG.BOOLEAN, Buffer.from([0xff])) : Buffer.alloc(0),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Lecture DER
// ---------------------------------------------------------------------------

export interface DerNode {
  tag: number;
  constructed: boolean;
  content: Buffer;
  children: DerNode[];
}

function parseNode(buf: Buffer, offset: number): { node: DerNode; next: number } {
  if (offset + 2 > buf.length) throw new Error("DER tronqué");
  const tag = buf[offset]!;
  let pos = offset + 1;
  const first = buf[pos]!;
  pos += 1;
  let length: number;
  if (first < 0x80) {
    length = first;
  } else {
    const count = first & 0x7f;
    if (count === 0 || count > 4) throw new Error("Longueur DER non prise en charge (indéfinie ou > 4 octets)");
    if (pos + count > buf.length) throw new Error("DER tronqué");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buf[pos + i]!;
    pos += count;
  }
  if (pos + length > buf.length) throw new Error("DER tronqué");
  const content = buf.subarray(pos, pos + length);
  const constructed = (tag & 0x20) !== 0;
  const node: DerNode = { tag, constructed, content, children: [] };
  if (constructed) node.children = parseSequence(content);
  return { node, next: pos + length };
}

function parseSequence(buf: Buffer): DerNode[] {
  const out: DerNode[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const { node, next } = parseNode(buf, pos);
    out.push(node);
    pos = next;
  }
  return out;
}

export function parseDer(buf: Buffer): DerNode {
  return parseNode(buf, 0).node;
}

/**
 * Parcours en profondeur. Une OCTET STRING dont le contenu est lui-même du DER
 * bien formé est ouverte : c'est ainsi qu'est rangé le TSTInfo dans le jeton
 * signé (eContent). Une OCTET STRING qui n'est pas du DER reste une feuille.
 */
function walk(node: DerNode, visit: (n: DerNode) => void): void {
  visit(node);
  let children = node.children;
  if (!node.constructed && node.tag === TAG.OCTET_STRING && node.content.length > 1) {
    try {
      const inner = parseSequence(node.content);
      if (inner.length > 0 && inner.some((n) => n.constructed)) children = inner;
    } catch {
      /* contenu binaire quelconque : c'est une feuille */
    }
  }
  for (const child of children) walk(child, visit);
}

/** GeneralizedTime (AAAAMMJJHHMMSS[.fff]Z) → ISO 8601. */
export function generalizedTimeToIso(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(value.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ""}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface TimeStampResponse {
  /** État PKIStatusInfo : 0 accordé, 1 accordé avec modifications, ≥ 2 rejeté. */
  status: number;
  statusText?: string;
  /** Réponse complète en base64 — c'est ce que l'on conserve, `openssl ts -reply` le lit. */
  token?: string;
  /** Heure attestée par la TSA (genTime du TSTInfo), quand elle a pu être lue. */
  genTime?: string;
  /** Numéro de série du jeton, en hexadécimal. */
  serialNumber?: string;
  /** Empreinte réellement scellée, telle qu'elle figure dans le jeton. */
  imprint?: string;
}

const STATUS_TEXT: Record<number, string> = {
  0: "accordé",
  1: "accordé avec modifications",
  2: "rejeté",
  3: "en attente",
  4: "révocation avertie",
  5: "révocation notifiée",
};

/**
 * Lit un TimeStampResp : état, puis — si un jeton est présent — heure attestée,
 * numéro de série et empreinte scellée. Ces trois valeurs sont extraites pour
 * être conservées et comparées ; la vérification cryptographique du jeton reste
 * l'affaire d'OpenSSL et de la chaîne de certification de la TSA.
 */
export function parseTimeStampResponse(raw: Buffer): TimeStampResponse {
  const root = parseDer(raw);
  const statusInfo = root.children[0];
  if (!statusInfo || statusInfo.children.length === 0) throw new Error("TimeStampResp illisible : PKIStatusInfo absent");
  const statusNode = statusInfo.children[0]!;
  let status = 0;
  for (const b of statusNode.content) status = status * 256 + b;

  const texts: string[] = [];
  for (const child of statusInfo.children.slice(1)) {
    walk(child, (n) => {
      if (n.tag === TAG.UTF8 && n.content.length > 0) texts.push(n.content.toString("utf8"));
    });
  }
  const out: TimeStampResponse = { status, ...(texts.length > 0 ? { statusText: texts.join(" ; ") } : { statusText: STATUS_TEXT[status] ?? `état ${status}` }) };
  if (status > 1 || root.children.length < 2) return out;

  out.token = raw.toString("base64");

  // TSTInfo est la SEQUENCE qui contient directement un GeneralizedTime.
  let tstInfo: DerNode | undefined;
  walk(root.children[1]!, (n) => {
    if (!tstInfo && n.constructed && n.children.some((c) => c.tag === TAG.GENERALIZED_TIME)) tstInfo = n;
  });
  if (!tstInfo) return out;

  const timeIndex = tstInfo.children.findIndex((c) => c.tag === TAG.GENERALIZED_TIME);
  const genTime = generalizedTimeToIso(tstInfo.children[timeIndex]!.content.toString("latin1"));
  if (genTime) out.genTime = genTime;
  // TSTInfo ::= SEQUENCE { version, policy, messageImprint, serialNumber, genTime, … }
  const serial = tstInfo.children[timeIndex - 1];
  if (serial?.tag === TAG.INTEGER) out.serialNumber = serial.content.toString("hex").replace(/^(00)+/, "") || "0";
  const imprint = tstInfo.children[timeIndex - 2];
  if (imprint?.constructed) {
    const octets = imprint.children.find((c) => c.tag === TAG.OCTET_STRING);
    if (octets) out.imprint = octets.content.toString("hex");
  }
  return out;
}
