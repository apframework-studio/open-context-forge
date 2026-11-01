import { createHash } from "node:crypto";
import type { CaptureCandidate } from "@ocf/contracts";

export function sourceKey(candidate: CaptureCandidate): string {
  const kind = candidate.originalUrl ? "clipper" : "local";
  const origin = candidate.originalUrl ? (() => {
    const url = new URL(candidate.originalUrl);
    url.hash = "";
    return url.href;
  })() : candidate.sourceFilename?.replaceAll("\\", "/").normalize("NFC");
  if (!origin || !/^[a-f\d]{64}$/i.test(candidate.contentHash)) throw new Error("INVALID_SOURCE_IDENTITY");
  return createHash("sha256").update(`${kind}\0${origin}\0${candidate.contentHash.toLowerCase()}`).digest("hex");
}
