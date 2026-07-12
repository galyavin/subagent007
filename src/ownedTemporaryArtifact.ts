import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processIsDefinitelyGone } from "./processLiveness.js";

const OWNER_FILE = ".subagent007-owner.json";
const OWNED_PREFIXES = ["subagent007-pi-child-", "subagent007-pi-final-"] as const;
export const TEMP_DIR_ENV = "SUBAGENT007_TEMP_DIR";

interface TemporaryArtifactOwner {
  schema_version: 1;
  pid: number;
}

export async function createOwnedTemporaryDir(prefix: string): Promise<string> {
  const tempRoot = runtimeTemporaryRoot();
  await fs.mkdir(tempRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tempRoot, prefix));
  try {
    const owner: TemporaryArtifactOwner = {
      schema_version: 1,
      pid: process.pid,
    };
    await fs.writeFile(path.join(dir, OWNER_FILE), `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return dir;
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export function runtimeTemporaryRoot(): string {
  return process.env[TEMP_DIR_ENV]
    ? path.resolve(process.env[TEMP_DIR_ENV])
    : path.join(os.homedir(), ".codex", "subagent007-pi", "tmp");
}

async function readOwner(dir: string): Promise<TemporaryArtifactOwner | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, OWNER_FILE), "utf8")) as Partial<TemporaryArtifactOwner>;
    const pid = parsed.pid;
    if (parsed.schema_version !== 1 || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
      return undefined;
    }
    return { schema_version: 1, pid };
  } catch {
    return undefined;
  }
}

export async function reconcileOwnedTemporaryArtifacts(tempRoot = runtimeTemporaryRoot()): Promise<number> {
  const entries = await fs.readdir(tempRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !OWNED_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) {
      continue;
    }
    const dir = path.join(tempRoot, entry.name);
    const owner = await readOwner(dir);
    if (!owner || !processIsDefinitelyGone(owner.pid)) {
      continue;
    }
    await fs.rm(dir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
