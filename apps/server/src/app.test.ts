import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createApp } from "./app.js";

test("health is available without external services", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-"));
  const app = createApp({ dataDir });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("mutating API requests require a local origin and client marker", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-"));
  const app = createApp({ dataDir });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/unknown",
      headers: { origin: "https://other.example", "x-ocf-client": "1" },
    });
    expect(response.statusCode).toBe(403);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
