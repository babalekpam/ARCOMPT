import { describe, expect, it } from "vitest";
import { renderAclManifest, type AclRow } from "./export-app-acl.mts";

describe("export du manifeste ACL applicatif", () => {
  it("rend les droits directs déterministes et ignore une colonne disparue", () => {
    const developmentCatalog: AclRow[] = [
      { kind: "TABLE", schemaName: "public", objectName: "journal_entry", privilege: "SELECT", grantable: false },
      { kind: "TABLE", schemaName: "public", objectName: "journal_entry", privilege: "UPDATE", grantable: false, columnName: "description" },
      // A dropped column may be present in ACL metadata without a valid target.
      { kind: "TABLE", schemaName: "public", objectName: "journal_entry", privilege: "UPDATE", grantable: false, columnName: "" },
      { kind: "SEQUENCE", schemaName: "public", objectName: "journal_entry_id_seq", privilege: "USAGE", grantable: false },
      { kind: "TABLE", schemaName: "public", objectName: 'quote"safe', privilege: "INSERT", grantable: true },
    ];

    expect(renderAclManifest(developmentCatalog)).toBe(`-- Generated from the development pg_catalog; explicit grants only.
-- Default ACLs are intentionally excluded and must be asserted absent separately.
-- Role: arcompt_app

GRANT INSERT ON TABLE "public"."quote""safe" TO "arcompt_app" WITH GRANT OPTION;
GRANT SELECT ON TABLE "public"."journal_entry" TO "arcompt_app";
GRANT UPDATE ("description") ON TABLE "public"."journal_entry" TO "arcompt_app";
GRANT USAGE ON SEQUENCE "public"."journal_entry_id_seq" TO "arcompt_app";
`);
  });
});