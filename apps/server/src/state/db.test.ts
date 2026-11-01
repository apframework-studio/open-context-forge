import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { getBatch, insertBatch, openDatabase } from "./db.js";

test("backfills existing single-vault imports into source memberships", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-membership-migration-"));
  try {
    const first = openDatabase(dataDir);
    first.prepare("INSERT INTO import_batches (id, created_at) VALUES ('old', '2026-10-24T00:00:00Z')").run();
    first.prepare(`INSERT INTO import_items
      (batch_id, capture_id, payload_json, status, vault_id, snapshot, fingerprint, processed_at)
      VALUES ('old', 'legacy', ?, 'imported', 'default', 'raw/sources/legacy.md', 'abc', '2026-10-24T00:00:00Z')`)
      .run(JSON.stringify({ id: "legacy", title: "旧资料" }));
    first.close();
    const migrated = openDatabase(dataDir);
    try {
      expect(getBatch(migrated, "old")?.candidates[0].vaults).toEqual([{
        vaultId: "default", snapshot: "raw/sources/legacy.md", fingerprint: "abc", analysisSyncError: false,
      }]);
      expect((migrated.prepare("SELECT COUNT(*) AS count FROM import_item_vaults").get() as { count: number }).count).toBe(1);
    } finally { migrated.close(); }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("stores stable source and provenance columns across database reopen", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-provenance-schema-"));
  try {
    const first = openDatabase(dataDir);
    const columns = (first.pragma("table_info(import_items)") as { name: string }[]).map((item) => item.name);
    expect(columns).toEqual(expect.arrayContaining(["source_key", "author_evidence_json", "authorship", "authorship_overridden"]));
    const policy = first.prepare("SELECT default_authorship FROM import_policy WHERE id = 1").get();
    expect(policy).toEqual({ default_authorship: "unknown" });
    first.close();
    const second = openDatabase(dataDir);
    expect(second.prepare("SELECT default_authorship FROM import_policy WHERE id = 1").get()).toEqual({ default_authorship: "unknown" });
    second.close();
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("persists source key and author evidence at receipt", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-source-receipt-"));
  const db = openDatabase(dataDir);
  try {
    insertBatch(db, { batchId: "b", createdAt: "2026-10-29T00:00:00Z", candidates: [{
      id: "a", title: "Article", originalUrl: null, sourceFilename: "article.md",
      author: "Ada", authorEvidence: { value: "Ada", kind: "frontmatter", location: "frontmatter:author" },
      capturedAt: "2026-10-29T00:00:00Z", markdown: "# Article", contentHash: "a".repeat(64), warnings: [], status: "ready",
    }] });
    const row = db.prepare("SELECT source_key, author_evidence_json, authorship FROM import_items WHERE batch_id = 'b'").get() as {
      source_key: string; author_evidence_json: string; authorship: string };
    expect(row.source_key).toMatch(/^[a-f\d]{64}$/);
    expect(JSON.parse(row.author_evidence_json)).toEqual({ value: "Ada", kind: "frontmatter", location: "frontmatter:author" });
    expect(row.authorship).toBe("unknown");
  } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
