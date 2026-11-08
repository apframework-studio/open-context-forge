import { strToU8, zipSync } from "fflate";
import { PublishCenterError, type PublishCenterStore } from "./center.js";

const maximumArchiveBytes = 100 * 1024 * 1024;

/** A portable, read-only snapshot for the user to take to a channel publisher. */
export async function buildChannelHandoff(center: PublishCenterStore, articleId: string, channel: string): Promise<Buffer> {
  const draft = await center.getDraft(articleId, channel);
  if (draft.status !== "ready" || draft.stale) throw new PublishCenterError("DRAFT_NOT_READY", 409);

  const available = (await center.listAssets(articleId)).items;
  const extra = draft.channelId === "weibo" ? draft.content.topics : draft.content.question;
  const postText = [draft.content.text, extra].filter(Boolean).join("\n\n");
  const files: Record<string, Uint8Array> = { "post.txt": strToU8(postText) };
  const images: { id: string; name: string; file: string }[] = [];
  let totalBytes = files["post.txt"].byteLength;

  for (const [index, id] of draft.assetIds.entries()) {
    const asset = available.find((item) => item.id === id);
    if (!asset) throw new PublishCenterError("CHANNEL_REVISION_CONFLICT", 409);
    const { bytes, mime } = await center.readAsset(articleId, id);
    const extension = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
    const file = `images/${String(index + 1).padStart(2, "0")}.${extension}`;
    totalBytes += bytes.byteLength;
    if (totalBytes > maximumArchiveBytes) throw new PublishCenterError("HANDOFF_TOO_LARGE", 413);
    files[file] = bytes;
    images.push({ id, name: asset.name, file });
  }

  // File reads may yield while another window changes the draft or its media.
  const current = await center.getDraft(articleId, channel);
  if (current.revision !== draft.revision || current.stale || current.status !== "ready") {
    throw new PublishCenterError("CHANNEL_REVISION_CONFLICT", 409);
  }

  const manifest = { schemaVersion: 1, articleId, channelId: draft.channelId, draftRevision: draft.revision,
    sourceRevision: draft.sourceRevision, text: draft.content.text, extra, images };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  files["README.txt"] = strToU8(draft.channelId === "weibo"
    ? "微博发布包\n\n请先核对 post.txt 和 images/ 中的图片顺序。可在微博网页版手动粘贴、上传图片并发布。微博官方 CLI 需要另行完成开发者认证、授权和服务开通；此包不会自动发帖。\n"
    : "即刻发布包\n\n请先核对 post.txt 和 images/ 中的图片顺序。在即刻网页版粘贴文字、上传图片并发布；此包不会自动发帖。\n");
  return Buffer.from(zipSync(files, { level: 0 }));
}
