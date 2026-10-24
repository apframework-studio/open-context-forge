import { constants, accessSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { runTool } from "../process/run.js";

export interface Vault {
  id: string;
  path: string;
  kind: "built-in" | "external";
  isDefault: boolean;
}

export class VaultError extends Error {
  constructor(readonly code: "INVALID_VAULT" | "ADOPTION_REQUIRED" | "VAULT_EXISTS" | "VAULT_NOT_FOUND" | "BUILT_IN_VAULT", readonly status: number, readonly plannedChanges?: string[]) {
    super(code);
  }
}

const defaultMaintainerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../open-context-forge-vault-maintainer");
const plannedChanges = ["raw/sources/", ".ocf/vault.json", ".ocf/ingest-manifest.json"];

function vaultProfile(path: string): void {
  try {
    const value: unknown = JSON.parse(readFileSync(join(path, ".ocf", "vault.json"), "utf8"));
    if (typeof value !== "object" || value === null || !("format_version" in value) || value.format_version !== 1 ||
      !("vault_id" in value) || typeof value.vault_id !== "string" ||
      !("paths" in value) || typeof value.paths !== "object" || value.paths === null) throw new Error("invalid");
  } catch {
    throw new VaultError("INVALID_VAULT", 422);
  }
}

function externalDirectory(path: unknown): string {
  if (typeof path !== "string" || !isAbsolute(path)) throw new VaultError("INVALID_VAULT", 422);
  try {
    const realPath = realpathSync(path);
    if (!statSync(realPath).isDirectory()) throw new Error("not directory");
    accessSync(realPath, constants.R_OK | constants.W_OK);
    return realPath;
  } catch {
    throw new VaultError("INVALID_VAULT", 422);
  }
}

export class VaultRegistry {
  readonly maintainerRoot: string;

  constructor(private readonly db: Database.Database, private readonly dataDir: string, maintainerRoot?: string) {
    this.maintainerRoot = realpathSync(maintainerRoot ?? defaultMaintainerRoot);
    db.exec(`
      CREATE TABLE IF NOT EXISTS vaults (
        id TEXT PRIMARY KEY,
        real_path TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  private async call(script: string, args: string[]) {
    return runTool(process.execPath, [join(this.maintainerRoot, "scripts", script), ...args, "--json"], {
      cwd: this.maintainerRoot, timeoutMs: 60_000,
    });
  }

  async ensureDefault(): Promise<void> {
    const path = join(this.dataDir, "vaults", "default");
    if (!existsSync(join(path, ".ocf", "vault.json"))) {
      await this.call("init-vault.js", ["--vault", path]);
    }
    const realPath = realpathSync(path);
    vaultProfile(realPath);
    const { count } = this.db.prepare("SELECT COUNT(*) AS count FROM vaults").get() as { count: number };
    this.db.prepare("INSERT OR IGNORE INTO vaults (id, real_path, kind, is_default) VALUES (?, ?, ?, ?)")
      .run("default", realPath, "built-in", count === 0 ? 1 : 0);
  }

  list(): { defaultVaultId: string; vaults: Vault[] } {
    const rows = this.db.prepare("SELECT id, real_path, kind, is_default FROM vaults ORDER BY CASE WHEN kind = 'built-in' THEN 0 ELSE 1 END, id")
      .all() as { id: string; real_path: string; kind: "built-in" | "external"; is_default: number }[];
    const vaults = rows.map((row) => ({ id: row.id, path: row.real_path, kind: row.kind, isDefault: !!row.is_default }));
    return { defaultVaultId: vaults.find((vault) => vault.isDefault)?.id ?? "default", vaults };
  }

  get(id: string): Vault | undefined {
    return this.list().vaults.find((vault) => vault.id === id);
  }

  async addExternal(id: unknown, path: unknown, adopt: unknown): Promise<Vault> {
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || id === "default") {
      throw new VaultError("INVALID_VAULT", 422);
    }
    const realPath = externalDirectory(path);
    if (this.db.prepare("SELECT 1 FROM vaults WHERE id = ? OR real_path = ?").get(id, realPath)) {
      throw new VaultError("VAULT_EXISTS", 409);
    }
    if (!existsSync(join(realPath, ".ocf", "vault.json"))) {
      if (adopt !== true) throw new VaultError("ADOPTION_REQUIRED", 409, plannedChanges);
      if (existsSync(join(realPath, ".ocf"))) throw new VaultError("INVALID_VAULT", 422);
      await this.call("adopt-vault.js", ["--vault", realPath, "--sources-dir", "raw/sources", "--wiki-dir", "."]);
    }
    vaultProfile(realPath);
    this.db.prepare("INSERT INTO vaults (id, real_path, kind, is_default) VALUES (?, ?, 'external', 0)").run(id, realPath);
    return this.get(id)!;
  }

  setDefault(id: unknown): { defaultVaultId: string } {
    if (typeof id !== "string" || !this.get(id)) throw new VaultError("VAULT_NOT_FOUND", 404);
    this.db.transaction(() => {
      this.db.prepare("UPDATE vaults SET is_default = 0").run();
      this.db.prepare("UPDATE vaults SET is_default = 1 WHERE id = ?").run(id);
    })();
    return { defaultVaultId: id };
  }

  disconnect(id: string): { defaultVaultId: string } {
    const vault = this.get(id);
    if (!vault) throw new VaultError("VAULT_NOT_FOUND", 404);
    if (vault.kind === "built-in") throw new VaultError("BUILT_IN_VAULT", 409);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM vaults WHERE id = ?").run(id);
      this.db.prepare("UPDATE import_policy SET mode = 'manual', vault_id = NULL WHERE vault_id = ?").run(id);
      this.db.prepare("UPDATE import_batches SET auto_vault_id = NULL WHERE auto_vault_id = ?").run(id);
      if (vault.isDefault) this.db.prepare("UPDATE vaults SET is_default = 1 WHERE id = 'default'").run();
    })();
    return { defaultVaultId: this.list().defaultVaultId };
  }
}
