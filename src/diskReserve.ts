import fs from "node:fs/promises";
import { safeIntegerFromEnv } from "./env.js";
import { resolveRunsDir } from "./output.js";
import { availableDiskBytes, type DiskReserveGuard } from "./processRunner.js";
import { ValidationError } from "./types.js";

export const MIN_FREE_DISK_BYTES_ENV = "SUBAGENT007_MIN_FREE_DISK_BYTES";
export const DEFAULT_MIN_FREE_DISK_BYTES = 5 * 1024 * 1024 * 1024;
const DISK_CHECK_INTERVAL_MS = 1_000;

export async function assertDiskReserveAvailable(runsDir?: string): Promise<DiskReserveGuard> {
  const outputPath = resolveRunsDir(runsDir);
  await fs.mkdir(outputPath, { recursive: true });
  const minimumFreeBytes = safeIntegerFromEnv(MIN_FREE_DISK_BYTES_ENV, DEFAULT_MIN_FREE_DISK_BYTES, 0);
  const freeBytes = await availableDiskBytes(outputPath);
  if (freeBytes < minimumFreeBytes) {
    throw new ValidationError(
      `local disk reserve exhausted: available_bytes=${freeBytes} minimum_free_bytes=${minimumFreeBytes}`,
      "disk_reserve_exhausted",
    );
  }
  return {
    path: outputPath,
    minimumFreeBytes,
    checkIntervalMs: DISK_CHECK_INTERVAL_MS,
  };
}
