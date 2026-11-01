import { expect, vi } from "vitest";
import type { createApp } from "../app.js";
import type { FilingResult } from "./filing-jobs.js";

export async function waitForFiling(app: ReturnType<typeof createApp>, jobId: string): Promise<FilingResult> {
  let result: FilingResult | null = null;
  await vi.waitFor(async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/imports/filing-jobs" });
    const job = response.json().jobs.find((entry: { id: string }) => entry.id === jobId);
    expect(job?.status).toBe("completed");
    result = job.result as FilingResult;
  }, { timeout: 5000, interval: 20 });
  return result!;
}
