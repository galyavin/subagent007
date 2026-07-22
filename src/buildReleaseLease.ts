import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildReleaseIdentity {
  release_id: string;
  release_path: string;
}

export function buildReleaseIdentityFromModuleUrl(moduleUrl: string): BuildReleaseIdentity | undefined {
  const releasePath = path.dirname(fs.realpathSync(fileURLToPath(moduleUrl)));
  if (path.basename(path.dirname(releasePath)) !== "releases") {
    return undefined;
  }
  return {
    release_id: path.basename(releasePath),
    release_path: releasePath,
  };
}

export function currentBuildReleaseIdentity(
  loadedRelease: BuildReleaseIdentity,
): BuildReleaseIdentity | undefined {
  const distDir = path.dirname(path.dirname(loadedRelease.release_path));
  try {
    const releasePath = fs.realpathSync(path.join(distDir, "current"));
    if (path.basename(path.dirname(releasePath)) !== "releases") {
      return undefined;
    }
    return {
      release_id: path.basename(releasePath),
      release_path: releasePath,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function acquireBuildReleaseLease(moduleUrl: string): BuildReleaseIdentity | undefined {
  const loadedRelease = buildReleaseIdentityFromModuleUrl(moduleUrl);
  if (!loadedRelease) {
    return undefined;
  }
  const leasePath = path.join(loadedRelease.release_path, `.subagent007-server-${process.pid}.lease.json`);
  try {
    fs.writeFileSync(
      leasePath,
      "",
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  process.once("exit", () => {
    try {
      fs.rmSync(leasePath, { force: true });
    } catch {
      // Build-release cleanup also prunes stale leases.
    }
  });
  return loadedRelease;
}
