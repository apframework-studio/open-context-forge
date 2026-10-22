import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { defineConfig } from "@playwright/test";

const repoRoot = resolve(import.meta.dirname, "../..");
const dataDir = mkdtempSync(join(tmpdir(), "ocf-e2e-"));

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://127.0.0.1:5173", browserName: "chromium", channel: "chrome" },
  webServer: [
    {
      command: "npm run dev --workspace apps/server",
      cwd: repoRoot,
      url: "http://127.0.0.1:3081/api/v1/health",
      reuseExistingServer: false,
      timeout: 120_000,
      env: { OCF_DATA_DIR: dataDir },
    },
    {
      command: "npm run dev --workspace apps/web",
      cwd: repoRoot,
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
