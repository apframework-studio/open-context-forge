import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { expect, test } from "vitest";
import { createApp } from "../app.js";

const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "ocf-vault-test-"));
  return { root, dataDir: join(root, "app"), external: join(root, "external") };
}

function captureZip(warnings: string[] = []) {
  const markdown = "这是一篇真实来源的正文。";
  const record = {
    schemaVersion: 1, id: "capture-1",
    source: { originalUrl: "https://example.org/article", canonicalUrl: "https://example.org/article", title: "来源文章", author: "原作者" },
    content: { markdown, wordCount: markdown.length, imageUrls: [] },
    capture: { capturedAt: "2026-10-22T00:00:00Z", extractor: "readability", contentHash: createHash("sha256").update(markdown).digest("hex"), warnings },
    user: { note: "采集备注" }, delivery: { status: "queued", attempts: 0 },
  };
  return zipSync({ "captures.json": strToU8(JSON.stringify([record])) });
}

async function preflight(app: ReturnType<typeof createApp>, warnings: string[] = []) {
  const bytes = captureZip(warnings);
  const boundary = "ocf-vault-boundary";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="captures.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await app.inject({
    method: "POST", url: "/api/v1/imports/preflight", payload,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "x-ocf-client": "1" },
  });
  expect(response.statusCode).toBe(201);
  return response.json().batchId as string;
}

test("first launch creates a built-in default vault and restart keeps it", async () => {
  const { root, dataDir } = workspace();
  try {
    const first = createApp({ dataDir, maintainerRoot });
    const response = await first.inject({ method: "GET", url: "/api/v1/vaults" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ defaultVaultId: "default", vaults: [{ id: "default", kind: "built-in", isDefault: true }] });
    const profile = join(dataDir, "vaults", "default", ".ocf", "vault.json");
    const vaultId = JSON.parse(readFileSync(profile, "utf8")).vault_id;
    await first.close();

    const second = createApp({ dataDir, maintainerRoot });
    const restarted = await second.inject({ method: "GET", url: "/api/v1/vaults" });
    expect(restarted.json().vaults).toHaveLength(1);
    expect(JSON.parse(readFileSync(profile, "utf8")).vault_id).toBe(vaultId);
    await second.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("registers an existing OCF external vault once by real path", async () => {
  const { root, dataDir, external } = workspace();
  mkdirSync(external);
  execFileSync(process.execPath, [join(maintainerRoot, "scripts/init-vault.js"), "--vault", external, "--json"]);
  const app = createApp({ dataDir, maintainerRoot });
  try {
    const first = await app.inject({ method: "POST", url: "/api/v1/vaults", headers: { "x-ocf-client": "1" }, payload: { id: "research", path: external } });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ id: "research", kind: "external" });
    const second = await app.inject({ method: "POST", url: "/api/v1/vaults", headers: { "x-ocf-client": "1" }, payload: { id: "again", path: external } });
    expect(second.statusCode).toBe(409);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("adopts a normal Obsidian directory only after explicit choice", async () => {
  const { root, dataDir, external } = workspace();
  mkdirSync(external);
  writeFileSync(join(external, "My note.md"), "# Existing note\n");
  const app = createApp({ dataDir, maintainerRoot });
  try {
    const request = { id: "notes", path: external };
    const preview = await app.inject({ method: "POST", url: "/api/v1/vaults", headers: { "x-ocf-client": "1" }, payload: request });
    expect(preview.statusCode).toBe(409);
    expect(preview.json()).toMatchObject({ error: "ADOPTION_REQUIRED", plannedChanges: ["raw/sources/", ".ocf/vault.json", ".ocf/ingest-manifest.json"] });
    expect(existsSync(join(external, ".ocf"))).toBe(false);
    const adopted = await app.inject({ method: "POST", url: "/api/v1/vaults", headers: { "x-ocf-client": "1" }, payload: { ...request, adopt: true } });
    expect(adopted.statusCode).toBe(201);
    expect(existsSync(join(external, ".ocf", "vault.json"))).toBe(true);
    expect(readFileSync(join(external, "My note.md"), "utf8")).toBe("# Existing note\n");
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("default target can switch to a registered external vault", async () => {
  const { root, dataDir, external } = workspace();
  mkdirSync(external);
  execFileSync(process.execPath, [join(maintainerRoot, "scripts/init-vault.js"), "--vault", external, "--json"]);
  const app = createApp({ dataDir, maintainerRoot });
  try {
    await app.inject({ method: "POST", url: "/api/v1/vaults", headers: { "x-ocf-client": "1" }, payload: { id: "research", path: external } });
    const switched = await app.inject({ method: "PUT", url: "/api/v1/vaults/default", headers: { "x-ocf-client": "1" }, payload: { vaultId: "research" } });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({ defaultVaultId: "research" });
    const listed = await app.inject({ method: "GET", url: "/api/v1/vaults" });
    expect(listed.json().vaults.find((vault: { id: string }) => vault.id === "research").isDefault).toBe(true);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("incomplete source cannot be committed into a vault", async () => {
  const { root, dataDir } = workspace();
  const app = createApp({ dataDir, maintainerRoot });
  try {
    const batchId = await preflight(app, ["content_too_short"]);
    const response = await app.inject({ method: "POST", url: `/api/v1/imports/${batchId}/items/capture-1/commit`, headers: { "x-ocf-client": "1" }, payload: { vaultId: "default" } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "INCOMPLETE_SOURCE" });
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("commits an immutable source snapshot and repeated commit reports duplicate", async () => {
  const { root, dataDir } = workspace();
  const app = createApp({ dataDir, maintainerRoot });
  try {
    const batchId = await preflight(app);
    const url = `/api/v1/imports/${batchId}/items/capture-1/commit`;
    const request = { method: "POST" as const, url, headers: { "x-ocf-client": "1" }, payload: { vaultId: "default" } };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(200);
    const result = first.json();
    expect(result).toMatchObject({ vaultId: "default", duplicate: false });
    const snapshot = join(dataDir, "vaults", "default", result.snapshot);
    expect(readFileSync(snapshot, "utf8")).toContain("这是一篇真实来源的正文。");
    expect(readFileSync(snapshot, "utf8")).toContain("采集备注");
    const second = await app.inject(request);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ snapshot: result.snapshot, duplicate: true });
    const batch = await app.inject({ method: "GET", url: `/api/v1/imports/${batchId}` });
    expect(batch.json().candidates[0].status).toBe("imported");
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("vault source index lists filed content and exposes its checked snapshot", async () => {
  const { root, dataDir } = workspace();
  const app = createApp({ dataDir, maintainerRoot });
  try {
    const batchId = await preflight(app);
    const filed = await app.inject({ method: "POST", url: `/api/v1/imports/${batchId}/items/capture-1/commit`,
      headers: { "x-ocf-client": "1" }, payload: { vaultId: "default" } });
    const fingerprint = filed.json().fingerprint;
    const listed = await app.inject({ method: "GET", url: "/api/v1/vaults/default/sources?page=1&pageSize=20" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().total).toBe(1);
    expect(listed.json().items[0]).toMatchObject({ fingerprint, title: "来源文章" });
    const detail = await app.inject({ method: "GET", url: `/api/v1/vaults/default/sources/${fingerprint}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().markdown).toContain("这是一篇真实来源的正文。");
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
