/**
 * Compte de test pour un expert-comptable, créé sur une base vivante.
 *
 *   DATABASE_URL=postgres://… \
 *   pnpm exec tsx scripts/create-test-account.mts --email prenom.nom@cabinet.tg
 *
 * Crée une organisation, un dossier sur le pack pays Togo, l'utilisateur avec
 * une appartenance OWNER, et de quoi remplir les écrans : deux tiers, quatre
 * écritures validées (à-nouveaux, vente, achat, règlement) et un brouillon à
 * valider. Puis imprime ce qui a été créé et ce qu'il faut pour se connecter.
 *
 * Réexécution : si l'adresse existe déjà avec le même dossier, le script ne
 * crée rien et réimprime les informations de connexion. Si elle existe dans une
 * autre configuration, il refuse en expliquant ce qu'il a trouvé — il ne
 * réécrit jamais un compte existant.
 *
 * Tout passe par les fonctions de seed existantes (`seedCompany`, le moteur
 * `Ledger`), pour qu'il n'existe qu'une seule façon de fabriquer un dossier.
 *
 * Options :
 *   --email    <adresse>   obligatoire (ou ACCOUNTANT_EMAIL)
 *   --name     <nom>       nom affiché ; par défaut déduit de l'adresse
 *   --org      <nom>       nom de l'organisation ; par défaut « Cabinet test ARCOMPT »
 *   --company  <nom>       nom du dossier ; par défaut « SARL Démo Lomé »
 *   --year     <AAAA>      exercice ; par défaut l'année en cours
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { loadPack } from "../packages/country-packs/src/loader.js";
import { createDb, withTenant, type Db } from "../packages/db/src/client.js";
import { seedCompany } from "../packages/db/src/seed.js";
import { Ledger, PostgresStore } from "../packages/ledger/src/index.js";

const PACK_CODE = "tg";
const ROLE = "OWNER";

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) fail(`Option ${arg} sans valeur`);
      out[arg.slice(2)] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const email = (args.email ?? process.env.ACCOUNTANT_EMAIL ?? "").trim().toLowerCase();
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  fail("Adresse de courriel manquante ou invalide : --email prenom.nom@cabinet.tg");
}
const displayName = args.name ?? process.env.ACCOUNTANT_NAME ?? email.split("@")[0]!.replace(/[._-]+/g, " ");
const orgName = args.org ?? "Cabinet test ARCOMPT";
const companyName = args.company ?? "SARL Démo Lomé";
const year = Number(args.year ?? new Date().getFullYear());
if (!Number.isInteger(year) || year < 2000 || year > 2100) fail(`Exercice invalide : ${args.year}`);

if (!process.env.DATABASE_URL) fail("DATABASE_URL manquant.");
const db: Db = createDb({ url: process.env.DATABASE_URL, max: 4 });

// Le pack pays donne la devise et la version : pas de valeur recopiée à la main.
const pack = loadPack(PACK_CODE);
const packVersion = `${pack.code}@${pack.version}`;
const currency = pack.identity.currency;

interface Created {
  organizationId: string;
  companyId: string;
  userId: string;
  fresh: boolean;
}

/** Déjà présent ? On ne recrée rien et on ne touche à rien. */
async function findExisting(): Promise<Created | null> {
  const rows = await db`
    SELECT u.id AS user_id, u.organization_id, o.name AS org_name, c.id AS company_id, c.name AS company_name, m.role
      FROM app_user u
      JOIN organization o ON o.id = u.organization_id
      LEFT JOIN company c ON c.organization_id = u.organization_id AND c.name = ${companyName}
      LEFT JOIN company_member m ON m.company_id = c.id AND m.user_id = u.id
     WHERE lower(u.email) = ${email}`;
  if (rows.length === 0) return null;
  const match = rows.find((r) => r.company_id && r.role === ROLE);
  if (!match) {
    const found = rows.map((r) => `organisation « ${r.org_name} », dossier ${r.company_name ?? "(aucun du nom demandé)"}, rôle ${r.role ?? "(aucun)"}`);
    fail(
      `L'adresse ${email} existe déjà dans cette base, mais pas avec le dossier attendu :\n  - ${found.join("\n  - ")}\n` +
        `  Choisissez une autre adresse (--email) ou un autre dossier (--company), ou nettoyez le compte existant à la main.`,
    );
  }
  return {
    organizationId: match.organization_id as string,
    companyId: match.company_id as string,
    userId: match.user_id as string,
    fresh: false,
  };
}

async function create(): Promise<Created> {
  // Identifiants engendrés côté client : ils permettent de poser le contexte
  // RLS (app.organization_id) AVANT l'insertion, donc de fonctionner même
  // lorsque le compte de migration n'est pas superutilisateur.
  const organizationId = randomUUID();
  const userId = randomUUID();

  await withTenant(db, { tenantId: "", organizationId }, async (tx) => {
    await tx`INSERT INTO organization (id, name, kind, plan) VALUES (${organizationId}, ${orgName}, 'FIRM', 'TRIAL')`;
    await tx`INSERT INTO app_user (id, organization_id, email, display_name, locale) VALUES (${userId}, ${organizationId}, ${email}, ${displayName}, 'fr')`;
  });

  const { companyId } = await seedCompany(db, {
    organizationId,
    name: companyName,
    countryCode: pack.code.toUpperCase(),
    currency,
    packVersion,
    fiscalYear: { code: String(year), startDate: `${year}-01-01`, endDate: `${year}-12-31` },
  });

  await withTenant(db, { tenantId: companyId, organizationId }, (tx) =>
    tx`INSERT INTO company_member (company_id, user_id, role) VALUES (${companyId}, ${userId}, ${ROLE})`,
  );

  const [client] = await withTenant(db, { tenantId: companyId, organizationId }, (tx) =>
    tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${companyId}, 'CUSTOMER', 'Client Tokoin', '411') RETURNING id`,
  );
  const [supplier] = await withTenant(db, { tenantId: companyId, organizationId }, (tx) =>
    tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${companyId}, 'SUPPLIER', 'Fournisseur Bè', '401') RETURNING id`,
  );

  const ledger = new Ledger(new PostgresStore(db as unknown as Sql, { userId, organizationId }), { baseCurrency: currency });
  const actor = { userId, tenantId: companyId };
  const clientId = client!.id as string;
  const supplierId = supplier!.id as string;

  await ledger.post(actor, {
    journalCode: "AN",
    date: `${year}-01-01`,
    label: "Reprise des à-nouveaux",
    source: "IMPORT",
    lines: [
      { accountNumber: "521", debit: "5000000", label: "Banque" },
      { accountNumber: "571", debit: "500000", label: "Caisse" },
      { accountNumber: "244", debit: "3000000", label: "Matériel et mobilier" },
      { accountNumber: "2844", credit: "1000000", label: "Amortissements du matériel et mobilier" },
      { accountNumber: "101", credit: "5000000", label: "Capital social" },
      { accountNumber: "121", credit: "2500000", label: "Report à nouveau" },
    ],
  });
  await ledger.post(actor, {
    journalCode: "VT",
    date: `${year}-03-15`,
    reference: `FAC-${year}-001`,
    label: "Facture Client Tokoin",
    source: "INVOICE",
    lines: [
      { accountNumber: "411", debit: "1180000", partnerId: clientId, label: "Client Tokoin" },
      { accountNumber: "706", credit: "1000000", label: "Prestation de services" },
      { accountNumber: "443", credit: "180000", label: "TVA facturée 18 %", vatCode: "TVA18" },
    ],
  });
  await ledger.post(actor, {
    journalCode: "AC",
    date: `${year}-03-20`,
    reference: "FF-0042",
    label: "Facture Fournisseur Bè – loyer",
    source: "PURCHASE",
    lines: [
      { accountNumber: "622", debit: "400000", label: "Loyer mars" },
      { accountNumber: "445", debit: "72000", label: "TVA récupérable", vatCode: "TVA18" },
      { accountNumber: "401", credit: "472000", partnerId: supplierId, label: "Fournisseur Bè" },
    ],
  });
  await ledger.post(actor, {
    journalCode: "BQ",
    date: `${year}-04-02`,
    label: "Règlement Client Tokoin",
    source: "BANK",
    lines: [
      { accountNumber: "521", debit: "1180000", label: "Virement reçu" },
      { accountNumber: "411", credit: "1180000", partnerId: clientId, label: "Client Tokoin" },
    ],
  });
  // Un brouillon : l'écran de validation n'est pas vide au premier coup d'œil.
  await ledger.createDraft(actor, {
    journalCode: "AC",
    date: `${year}-05-05`,
    reference: "FF-0043",
    label: "Facture Fournisseur Bè – fournitures",
    source: "PURCHASE",
    lines: [
      { accountNumber: "604", debit: "200000", label: "Fournitures de bureau" },
      { accountNumber: "445", debit: "36000", label: "TVA récupérable", vatCode: "TVA18" },
      { accountNumber: "401", credit: "236000", partnerId: supplierId, label: "Fournisseur Bè" },
    ],
  });

  return { organizationId, companyId, userId, fresh: true };
}

try {
  const existing = await findExisting();
  const account = existing ?? (await create());

  const [counts] = await withTenant(db, { tenantId: account.companyId, organizationId: account.organizationId }, (tx) =>
    tx`SELECT (SELECT count(*)::int FROM journal_entry WHERE tenant_id = ${account.companyId} AND status = 'VALIDATED') AS validees,
              (SELECT count(*)::int FROM journal_entry WHERE tenant_id = ${account.companyId} AND status = 'DRAFT') AS brouillons,
              (SELECT count(*)::int FROM account WHERE tenant_id = ${account.companyId}) AS comptes,
              (SELECT count(*)::int FROM partner WHERE tenant_id = ${account.companyId}) AS tiers`,
  );

  console.log(account.fresh ? "✓ compte de test créé" : "✓ compte de test déjà présent : rien n'a été modifié");
  console.log("");
  console.log("Créé");
  console.log(`  organisation   : ${orgName} (${account.organizationId})`);
  console.log(`  dossier        : ${companyName} (${account.companyId})`);
  console.log(`  pack pays      : ${packVersion} — ${pack.name}, devise ${currency}, statut ${pack.status}`);
  console.log(`  exercice       : ${year} (12 périodes mensuelles)`);
  console.log(`  utilisateur    : ${displayName} <${email}> (${account.userId}), rôle ${ROLE}`);
  console.log(`  données        : ${counts!.comptes} comptes, ${counts!.tiers} tiers, ${counts!.validees} écritures validées, ${counts!.brouillons} brouillon(s)`);
  console.log("");
  console.log("Pour se connecter");
  console.log(`  identifiant du dossier (X-Tenant-Id)  : ${account.companyId}`);
  console.log(`  identifiant utilisateur (X-User-Id)   : ${account.userId}`);
  console.log("");
  console.log("  • AUTH_MODE=oidc (recommandé hors poste de développement) :");
  console.log(`      créez dans Keycloak un utilisateur avec EXACTEMENT l'adresse ${email}, courriel vérifié,`);
  console.log("      puis transmettez-lui ses identifiants Keycloak. Au premier appel authentifié, ARCOMPT");
  console.log("      rattache le compte tout seul (auth_link_subject) : aucun SQL à la main.");
  console.log("      Si l'organisation exige le second facteur, il devra l'activer à la première connexion.");
  console.log("  • AUTH_MODE=dev (poste local uniquement) : les deux identifiants ci-dessus suffisent.");
  console.log(`      curl -H 'X-User-Id: ${account.userId}' -H 'X-Tenant-Id: ${account.companyId}' \\`);
  console.log(`           "$API_URL/v1/entries/trial-balance?fiscalYear=${year}"`);
  console.log("");
  console.log(`  Le pack ${PACK_CODE} est en statut ${pack.status} : taux et barèmes restent indicatifs, à valider par l'expert-comptable référent.`);
} finally {
  await db.end();
}
