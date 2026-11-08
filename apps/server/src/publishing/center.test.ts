import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { createApp } from "../app.js";

const headers = { "x-ocf-client": "1" };
const png = readFileSync(new URL("../../../web/public/favicon-32x32.png", import.meta.url));

function multipart(bytes: Buffer, mime = "image/png") {
  const boundary = "ocf-center-upload";
  return { headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cover.png"\r\nContent-Type: ${mime}\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-center-"));
  const app = createApp({ dataDir });
  await app.inject({ url: "/api/v1/vaults" });
  writeFileSync(join(dataDir, "vaults", "default", "raw", "sources", "source.md"), "# 来源\n\n可回查的依据。\n");
  const create = async (title: string) => {
    const result = await app.inject({ method: "POST", url: "/api/v1/articles", headers,
      payload: { title, summary: "给读者看的摘要", date: "2026-11-07", sourceRef: { vaultId: "default", snapshot: "raw/sources/source.md" } } });
    expect(result.statusCode).toBe(201);
    return result.json().id as string;
  };
  const finalize = async (id: string, expectedRevision = 0) => {
    const saved = await app.inject({ method: "PUT", url: `/api/v1/articles/${id}/draft`, headers,
      payload: { markdown: `# 文章\n\n这篇文章有完整的内容和来源。修订 ${expectedRevision}。`, expectedRevision } });
    expect(saved.statusCode).toBe(200);
    const result = await app.inject({ method: "POST", url: `/api/v1/articles/${id}/finalize`, headers,
      payload: { expectedRevision: expectedRevision + 1 } });
    expect(result.statusCode).toBe(200);
    return result.json().revision as number;
  };
  return { app, dataDir, create, finalize, close: async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test("publish center lists final articles and channel status independently", async () => {
  const f = await fixture();
  try {
    const finalId = await f.create("定稿文章");
    await f.finalize(finalId);
    await f.create("仍在起草");
    const listed = await f.app.inject({ url: "/api/v1/publish-center" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().channels.map((item: { id: string }) => item.id)).toEqual(["weibo", "jike"]);
    expect(listed.json().items).toMatchObject([{ id: finalId, title: "定稿文章",
      channels: { weibo: { status: "unplanned" }, jike: { status: "unplanned" } } }]);
    expect(listed.json().items).toHaveLength(1);
  } finally { await f.close(); }
});

test("channel drafts persist, and source revision sync retains channel copy", async () => {
  const f = await fixture();
  try {
    const id = await f.create("可发布文章");
    await f.finalize(id);
    const path = `/api/v1/articles/${id}/channel-drafts/weibo`;
    const saved = await f.app.inject({ method: "PUT", url: path, headers,
      payload: { expectedRevision: 0, content: { text: "微博版独立文案", topics: "#写作" }, status: "ready", assetIds: [] } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ channelId: "weibo", sourceRevision: 2, status: "ready",
      content: { text: "微博版独立文案", topics: "#写作" }, assetIds: [], stale: false });
    await f.finalize(id, 2);
    const stale = await f.app.inject({ url: path });
    expect(stale.json()).toMatchObject({ sourceRevision: 2, stale: true, content: { text: "微博版独立文案" } });
    const synced = await f.app.inject({ method: "POST", url: `${path}/sync`, headers, payload: { expectedRevision: 1 } });
    expect(synced.json()).toMatchObject({ sourceRevision: 4, stale: false, content: { text: "微博版独立文案" } });
    const listed = await f.app.inject({ url: "/api/v1/publish-center" });
    expect(listed.json().items[0].channels.weibo.status).toBe("ready");
    expect(listed.json().items[0].channels.jike.status).toBe("unplanned");
  } finally { await f.close(); }
});

test("manual publication records the prepared channel and later edits reopen its progress", async () => {
  const f = await fixture();
  try {
    const id = await f.create("人工发布交接");
    await f.finalize(id);
    const path = `/api/v1/articles/${id}/channel-drafts/weibo`;
    const premature = await f.app.inject({ method: "POST", url: `${path}/published`, headers, payload: { url: "https://weibo.com/example" } });
    expect(premature.statusCode).toBe(404);
    await f.app.inject({ method: "PUT", url: path, headers,
      payload: { expectedRevision: 0, content: { text: "已准备的微博文案", topics: "#知识整理" }, status: "ready", assetIds: [] } });
    const published = await f.app.inject({ method: "POST", url: `${path}/published`, headers,
      payload: { expectedRevision: 1, url: "https://weibo.com/example", publishedAt: "2026-11-06T12:30:00.000Z" } });
    expect(published.statusCode).toBe(201);
    expect(published.json()).toMatchObject({ channelId: "weibo", url: "https://weibo.com/example", sourceRevision: 2,
      publishedAt: "2026-11-06T12:30:00.000Z" });
    const repeated = await f.app.inject({ method: "POST", url: `${path}/published`, headers,
      payload: { expectedRevision: 1, url: "https://weibo.com/example", publishedAt: "2026-11-06T12:30:00.000Z" } });
    expect(repeated.json().id).toBe(published.json().id);
    expect((await f.app.inject({ url: "/api/v1/publish-center" })).json().items[0].channels.weibo.status).toBe("published");
    expect((await f.app.inject({ url: path })).json().lastPublication.url).toBe("https://weibo.com/example");
    await f.app.inject({ method: "PUT", url: path, headers,
      payload: { expectedRevision: 1, content: { text: "再次修改的微博文案", topics: "#知识整理" }, status: "ready", assetIds: [] } });
    expect((await f.app.inject({ url: "/api/v1/publish-center" })).json().items[0].channels.weibo.status).toBe("ready");
    await f.finalize(id, 2);
    expect((await f.app.inject({ method: "POST", url: `${path}/published`, headers, payload: { expectedRevision: 2 } })).statusCode).toBe(409);
  } finally { await f.close(); }
});

test("a stale channel editor cannot overwrite another window's saved content", async () => {
  const f = await fixture();
  try {
    const id = await f.create("并发渠道稿"); await f.finalize(id);
    const path = `/api/v1/articles/${id}/channel-drafts/weibo`;
    const first = await f.app.inject({ method: "PUT", url: path, headers,
      payload: { expectedRevision: 0, content: { text: "窗口 A 的初稿", topics: "" }, status: "draft", assetIds: [] } });
    expect(first.json().revision).toBe(1);
    const newer = await f.app.inject({ method: "PUT", url: path, headers,
      payload: { expectedRevision: 1, content: { text: "窗口 A 的新稿", topics: "" }, status: "ready", assetIds: [] } });
    expect(newer.statusCode).toBe(200);
    const stale = await f.app.inject({ method: "PUT", url: path, headers,
      payload: { expectedRevision: 1, content: { text: "窗口 B 的旧稿", topics: "" }, status: "draft", assetIds: [] } });
    expect(stale.statusCode).toBe(409);
    expect((await f.app.inject({ url: path })).json()).toMatchObject({ revision: 2, status: "ready", content: { text: "窗口 A 的新稿" } });
  } finally { await f.close(); }
});

test("an uploaded image can be shared by two channel drafts and deleted with usage impact", async () => {
  const f = await fixture();
  try {
    const id = await f.create("共享图片的文章");
    await f.finalize(id);
    const assetsPath = `/api/v1/articles/${id}/publish-assets`;
    const uploaded = await f.app.inject({ method: "POST", url: `${assetsPath}?group=vertical`, ...multipart(png) });
    expect(uploaded.statusCode).toBe(201);
    const asset = uploaded.json();
    expect(asset).toMatchObject({ articleId: id, name: "cover.png", mime: "image/png", group: "vertical" });
    const preview = await f.app.inject({ url: `${assetsPath}/${asset.id}/file` });
    expect(preview.statusCode).toBe(200);
    expect(preview.rawPayload).toEqual(png);
    for (const channel of ["weibo", "jike"]) {
      const content = channel === "weibo" ? { text: "微博正文", topics: "" } : { text: "即刻正文", question: "" };
      const saved = await f.app.inject({ method: "PUT", url: `/api/v1/articles/${id}/channel-drafts/${channel}`, headers,
        payload: { expectedRevision: 0, content, status: "ready", assetIds: [asset.id] } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().assetIds).toEqual([asset.id]);
    }
    const removed = await f.app.inject({ method: "DELETE", url: `${assetsPath}/${asset.id}`, headers });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().affectedChannels).toEqual(["weibo", "jike"]);
    expect((await f.app.inject({ url: assetsPath })).json().items).toEqual([]);
    expect((await f.app.inject({ url: `${assetsPath}/${asset.id}/file` })).statusCode).toBe(404);
    expect((await f.app.inject({ url: `/api/v1/articles/${id}/channel-drafts/weibo` })).json().assetIds).toEqual([]);
    expect((await f.app.inject({ url: `/api/v1/articles/${id}/channel-drafts/jike` })).json().assetIds).toEqual([]);
    expect((await f.app.inject({ url: `/api/v1/articles/${id}/channel-drafts/weibo` })).json().status).toBe("draft");
    expect((await f.app.inject({ url: `/api/v1/articles/${id}/channel-drafts/jike` })).json().status).toBe("draft");
    expect((await f.app.inject({ method: "POST", url: `/api/v1/articles/${id}/channel-drafts/weibo/published`, headers,
      payload: { expectedRevision: 2, url: "" } })).statusCode).toBe(409);
  } finally { await f.close(); }
});

test("image upload rejects invalid bytes and a draft cannot borrow another article's asset", async () => {
  const f = await fixture();
  try {
    const first = await f.create("第一篇"); await f.finalize(first);
    const second = await f.create("第二篇"); await f.finalize(second);
    const invalid = await f.app.inject({ method: "POST", url: `/api/v1/articles/${first}/publish-assets?group=vertical`, ...multipart(Buffer.from("fake")) });
    expect(invalid.statusCode).toBe(422);
    const uploaded = await f.app.inject({ method: "POST", url: `/api/v1/articles/${first}/publish-assets?group=vertical`, ...multipart(png) });
    const foreignId = uploaded.json().id as string;
    const saved = await f.app.inject({ method: "PUT", url: `/api/v1/articles/${second}/channel-drafts/weibo`, headers,
      payload: { expectedRevision: 0, content: { text: "第二篇微博", topics: "" }, status: "ready", assetIds: [foreignId] } });
    expect(saved.statusCode).toBe(422);
    expect(saved.json()).toEqual({ error: "INVALID_ASSET" });
  } finally { await f.close(); }
});

test("a ready channel exports its saved copy and images in channel order", async () => {
  const f = await fixture();
  try {
    const id = await f.create("渠道发布包"); await f.finalize(id);
    const archivePath = `/api/v1/articles/${id}/channel-drafts/weibo/handoff`;
    expect((await f.app.inject({ url: archivePath })).statusCode).toBe(404);
    const first = await f.app.inject({ method: "POST", url: `/api/v1/articles/${id}/publish-assets?group=vertical`, ...multipart(png) });
    const second = await f.app.inject({ method: "POST", url: `/api/v1/articles/${id}/publish-assets?group=vertical`, ...multipart(png) });
    const firstId = first.json().id as string, secondId = second.json().id as string;
    const path = `/api/v1/articles/${id}/channel-drafts/weibo`;
    await f.app.inject({ method: "PUT", url: path, headers,
      payload: { expectedRevision: 0, content: { text: "渠道正文", topics: "#知识整理" }, status: "ready", assetIds: [secondId, firstId] } });
    const response = await f.app.inject({ url: archivePath });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
    const files = unzipSync(response.rawPayload);
    expect(strFromU8(files["post.txt"])).toBe("渠道正文\n\n#知识整理");
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    expect(manifest).toMatchObject({ schemaVersion: 1, articleId: id, channelId: "weibo", draftRevision: 1,
      images: [{ id: secondId, file: "images/01.png" }, { id: firstId, file: "images/02.png" }] });
    expect(Buffer.from(files["images/01.png"])).toEqual(png);
    expect(Buffer.from(files["images/02.png"])).toEqual(png);
    await f.app.inject({ method: "PUT", url: `/api/v1/articles/${id}/channel-drafts/jike`, headers,
      payload: { expectedRevision: 0, content: { text: "即刻正文", question: "大家会怎样整理？" }, status: "ready", assetIds: [firstId] } });
    const jikeBundle = await f.app.inject({ url: `/api/v1/articles/${id}/channel-drafts/jike/handoff` });
    expect(strFromU8(unzipSync(jikeBundle.rawPayload)["post.txt"])).toBe("即刻正文\n\n大家会怎样整理？");
    await f.finalize(id, 2);
    expect((await f.app.inject({ url: archivePath })).statusCode).toBe(409);
  } finally { await f.close(); }
});
