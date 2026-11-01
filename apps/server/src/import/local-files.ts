import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { unzipSync } from "fflate";
import type { CaptureCandidate } from "@ocf/contracts";
import { ImportError, parseClipperZip } from "./clipper-zip.js";
import { extractLocalAuthor } from "./metadata.js";

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_ZIP_ENTRIES = 1000;
const supported = new Set([".md", ".markdown", ".mdown", ".txt", ".text", ".html", ".htm"]);

export interface ParsedImport { candidates: CaptureCandidate[]; skippedFiles: number }

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    mdash: "—", ndash: "–", hellip: "…", copy: "©" };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (full, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x";
      const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point) : full;
    }
    return named[entity.toLowerCase()] ?? full;
  });
}

export function htmlToMarkdown(html: string): { title: string | null; markdown: string } {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
    ?.replace(/<[^>]+>/g, "").trim() ?? null;
  let body = html.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  body = /<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)\s*>/i.exec(body)?.[1] ?? body;
  body = body.replace(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_match, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined, label: string) => {
      const text = decodeEntities(label.replace(/<[^>]+>/g, "").trim());
      const href = decodeEntities(doubleQuoted ?? singleQuoted ?? bare ?? "");
      try {
        const url = new URL(href);
        if (["http:", "https:"].includes(url.protocol) && text) return `[${text.replace(/[\[\]]/g, "")}](${url.toString()})`;
      } catch { /* Keep link text when a local URL has no base. */ }
      return text;
    });
  body = body.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
    (_match, level: string, value: string) => `\n\n${"#".repeat(Number(level))} ${value.replace(/<[^>]+>/g, "").trim()}\n\n`);
  body = body.replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/li\s*>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|section|blockquote|ul|ol|table|tr)\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  const markdown = decodeEntities(body).replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title: title ? decodeEntities(title) : null, markdown };
}

function sourceName(name: string): string {
  const parts = name.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.includes("..")) throw new ImportError("INVALID_TEXT_FILE");
  return parts.join("/");
}

function textCandidate(bytes: Uint8Array, name: string): CaptureCandidate {
  if (bytes.byteLength > MAX_TEXT_BYTES) throw new ImportError("TEXT_TOO_LARGE");
  const filename = sourceName(name);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""); }
  catch { throw new ImportError("INVALID_TEXT_FILE"); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new ImportError("INVALID_TEXT_FILE");
  const extension = extname(filename).toLowerCase();
  const authorEvidence = extractLocalAuthor(text, extension === ".html" || extension === ".htm" ? "html" : "markdown");
  const html = extension === ".html" || extension === ".htm" ? htmlToMarkdown(text) : null;
  const markdown = (html?.markdown ?? text).replace(/\r\n?/g, "\n").trim();
  if (!markdown) throw new ImportError("INVALID_TEXT_FILE");
  const stem = basename(filename, extname(filename));
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  return {
    id: createHash("sha256").update(`${filename}\0${markdown}`).digest("hex").slice(0, 32),
    title: (html?.title || heading || stem).slice(0, 300),
    originalUrl: null,
    sourceFilename: filename,
    ...(authorEvidence ? { author: authorEvidence.value, authorEvidence } : {}),
    capturedAt: new Date().toISOString(),
    markdown,
    contentHash: createHash("sha256").update(markdown).digest("hex"),
    warnings: [],
    status: "ready",
  };
}

function unzip(bytes: Uint8Array, filter: Parameters<typeof unzipSync>[1]): Record<string, Uint8Array> {
  try { return unzipSync(bytes, filter); }
  catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("INVALID_ZIP");
  }
}

function parseTextZip(bytes: Uint8Array): ParsedImport {
  let entries = 0;
  let hasManifest = false;
  unzip(bytes, { filter(file) {
    if (++entries > MAX_ZIP_ENTRIES) throw new ImportError("TOO_MANY_FILES");
    if (file.name === "captures.json") hasManifest = true;
    return false;
  } });
  if (hasManifest) return { candidates: parseClipperZip(bytes), skippedFiles: 0 };

  let selected = 0;
  let totalBytes = 0;
  let skippedFiles = 0;
  const files = unzip(bytes, { filter(file) {
    if (file.name.endsWith("/")) return false;
    if (!supported.has(extname(file.name).toLowerCase())) { skippedFiles++; return false; }
    if (++selected > MAX_FILES) throw new ImportError("TOO_MANY_FILES");
    totalBytes += file.originalSize;
    if (file.originalSize > MAX_TEXT_BYTES || totalBytes > MAX_TEXT_BYTES) throw new ImportError("TEXT_TOO_LARGE");
    return true;
  } });
  const candidates: CaptureCandidate[] = [];
  for (const [name, contents] of Object.entries(files)) {
    try { candidates.push(textCandidate(contents, name)); }
    catch (error) {
      if (error instanceof ImportError && error.code === "INVALID_TEXT_FILE") { skippedFiles++; continue; }
      throw error;
    }
  }
  if (!candidates.length) throw new ImportError("NO_SUPPORTED_FILES");
  return { candidates, skippedFiles };
}

export function parseImportUpload(bytes: Uint8Array, filename: string): ParsedImport {
  const extension = extname(filename).toLowerCase();
  if (extension === ".zip") {
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new ImportError("ARCHIVE_TOO_LARGE");
    return parseTextZip(bytes);
  }
  if (!supported.has(extension)) throw new ImportError("UNSUPPORTED_FILE");
  return { candidates: [textCandidate(bytes, filename)], skippedFiles: 0 };
}
