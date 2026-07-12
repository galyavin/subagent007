import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function acquireBuildReleaseLease(moduleUrl: string): void {
  const releaseDir = path.dirname(fs.realpathSync(fileURLToPath(moduleUrl)));
  if (path.basename(path.dirname(releaseDir)) !== "releases") {
    return;
  }
  const leasePath = path.join(releaseDir, `.subagent007-server-${process.pid}.lease.json`);
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
}
