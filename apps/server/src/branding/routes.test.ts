import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createApp } from "../app.js";

const defaultIcon = readFileSync(new URL("../../../web/public/favicon-32x32.png", import.meta.url));

function upload(bytes: Buffer, type = "image/png") {
  const boundary = "ocf-branding-test";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "x-ocf-client": "1" },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="icon.png"\r\nContent-Type: ${type}\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

test("custom icon survives restart and can be restored to the default", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-branding-"));
  const first = createApp({ dataDir });
  try {
    const initial = await first.inject({ method: "GET", url: "/api/v1/branding" });
    expect(initial.json()).toEqual({ customized: false, revision: null });

    const saved = await first.inject({ method: "PUT", url: "/api/v1/branding/icon", ...upload(defaultIcon) });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ customized: true });
    const icon = await first.inject({ method: "GET", url: "/api/v1/branding/icon" });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["content-type"]).toContain("image/png");
    expect(icon.rawPayload).toEqual(defaultIcon);
    await first.close();

    const restarted = createApp({ dataDir });
    try {
      expect((await restarted.inject({ method: "GET", url: "/api/v1/branding" })).json().customized).toBe(true);
      const restored = await restarted.inject({ method: "DELETE", url: "/api/v1/branding/icon", headers: { "x-ocf-client": "1" } });
      expect(restored.json()).toEqual({ customized: false, revision: null });
      expect((await restarted.inject({ method: "GET", url: "/api/v1/branding/icon" })).statusCode).toBe(404);
    } finally { await restarted.close(); }
  } finally {
    await first.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("rejects non-PNG and oversized icons", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-branding-"));
  const app = createApp({ dataDir });
  try {
    const bad = await app.inject({ method: "PUT", url: "/api/v1/branding/icon", ...upload(Buffer.from("not a png")) });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toEqual({ error: "ICON_INVALID" });
    const wrongType = await app.inject({ method: "PUT", url: "/api/v1/branding/icon", ...upload(defaultIcon, "image/svg+xml") });
    expect(wrongType.statusCode).toBe(422);
    const large = await app.inject({ method: "PUT", url: "/api/v1/branding/icon", ...upload(Buffer.alloc(1024 * 1024 + 1)) });
    expect(large.statusCode).toBe(413);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
