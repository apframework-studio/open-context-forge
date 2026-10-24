import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { getBatch, openDatabase } from "./db.js";

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
