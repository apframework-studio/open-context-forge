import { createHash } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import type { CaptureCandidate } from "@ocf/contracts";

type ImportErrorCode =
  | "ARCHIVE_TOO_LARGE"
  | "INVALID_ZIP"
  | "INVALID_JSON"
  | "INVALID_RECORD"
  | "HASH_MISMATCH"
  | "MANIFEST_TOO_LARGE"
  | "UNSUPPORTED_FILE"
  | "NO_SUPPORTED_FILES"
  | "INVALID_TEXT_FILE"
  | "TEXT_TOO_LARGE"
  | "TOO_MANY_FILES";

export class ImportError extends Error {
  constructor(readonly code: ImportErrorCode) {
    super(code);
    this.name = "ImportError";
  }
}

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 200;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function httpUrl(value: unknown): value is string {
  if (!nonempty(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function candidateFrom(value: unknown): CaptureCandidate {
  if (!object(value) || value.schemaVersion !== 1 || !nonempty(value.id) ||
    !object(value.source) || !object(value.content) || !object(value.capture) ||
    !object(value.user) || !object(value.delivery)) throw new ImportError("INVALID_RECORD");

  const { source, content, capture } = value;
  if (!httpUrl(source.originalUrl) || !httpUrl(source.canonicalUrl) ||
    !nonempty(source.title) || (source.author !== undefined && typeof source.author !== "string") ||
    typeof content.markdown !== "string" || typeof content.wordCount !== "number" ||
    !Number.isFinite(content.wordCount) || content.wordCount < 0 ||
    !Array.isArray(content.imageUrls) || !content.imageUrls.every((item) => typeof item === "string") ||
    !nonempty(capture.capturedAt) || Number.isNaN(Date.parse(capture.capturedAt)) ||
    !["readability", "site-adapter", "fallback"].includes(String(capture.extractor)) ||
    typeof capture.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(capture.contentHash) ||
    !Array.isArray(capture.warnings) || !capture.warnings.every((item) => typeof item === "string") ||
    (value.user.note !== undefined && typeof value.user.note !== "string") ||
    typeof value.delivery.status !== "string" || typeof value.delivery.attempts !== "number") {
    throw new ImportError("INVALID_RECORD");
  }

  const actualHash = createHash("sha256")
    .update(content.markdown.replace(/\r\n/g, "\n").trim())
    .digest("hex");
  if (actualHash !== capture.contentHash) throw new ImportError("HASH_MISMATCH");

  const warnings = [...capture.warnings];
  return {
    id: value.id,
    title: source.title,
    originalUrl: source.originalUrl,
    ...(source.author ? { author: source.author as string,
      authorEvidence: { value: source.author as string, kind: "clipper" as const, location: "source.author" } } : {}),
    ...(value.user.note ? { note: value.user.note as string } : {}),
    capturedAt: capture.capturedAt,
    markdown: content.markdown,
    contentHash: capture.contentHash,
    warnings,
    status: !content.markdown.trim() || warnings.some((item) =>
      item === "content_too_short" || item === "paywall_preview") ? "incomplete" : "ready",
  };
}

export function parseClipperZip(bytes: Uint8Array): CaptureCandidate[] {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new ImportError("ARCHIVE_TOO_LARGE");
  let manifest: Uint8Array | undefined;
  try {
    const files = unzipSync(bytes, {
      filter(file) {
        if (file.name !== "captures.json") return false;
        if (file.originalSize > MAX_MANIFEST_BYTES) throw new ImportError("MANIFEST_TOO_LARGE");
        return true;
      },
    });
    manifest = files["captures.json"];
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("INVALID_ZIP");
  }
  if (!manifest) throw new ImportError("INVALID_RECORD");
  if (manifest.byteLength > MAX_MANIFEST_BYTES) throw new ImportError("MANIFEST_TOO_LARGE");

  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(manifest));
  } catch {
    throw new ImportError("INVALID_JSON");
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_RECORDS) throw new ImportError("INVALID_RECORD");
  const ids = new Set<string>();
  return parsed.map((item) => {
    const candidate = candidateFrom(item);
    if (ids.has(candidate.id)) throw new ImportError("INVALID_RECORD");
    ids.add(candidate.id);
    return candidate;
  });
}
