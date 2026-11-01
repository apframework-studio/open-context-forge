import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { defineConfig } from "@playwright/test";

const repoRoot = resolve(import.meta.dirname, "../..");
const dataDir = mkdtempSync(join(tmpdir(), "ocf-e2e-"));
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("No free TCP port")); return; }
      server.close(() => resolvePort(address.port));
    });
  });
}
const serverPort = Number(process.env.OCF_E2E_SERVER_PORT ?? await freePort());
process.env.OCF_E2E_SERVER_PORT = String(serverPort);
let webPort = Number(process.env.OCF_E2E_WEB_PORT ?? await freePort());
while (webPort === serverPort) webPort = await freePort();
process.env.OCF_E2E_WEB_PORT = String(webPort);

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${webPort}`, browserName: "chromium", channel: "chrome" },
  webServer: [
    {
      command: "npm run dev --workspace apps/server",
      cwd: repoRoot,
      url: `http://127.0.0.1:${serverPort}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { OCF_DATA_DIR: dataDir, OCF_PORT: String(serverPort), OCF_WEB_ORIGIN: `http://127.0.0.1:${webPort}` },
    },
    {
      command: `npm run dev --workspace apps/web -- --port ${webPort} --strictPort`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { OCF_API_PORT: String(serverPort) },
    },
  ],
});
