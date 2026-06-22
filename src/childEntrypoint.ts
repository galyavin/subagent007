import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ValidationError } from "./types.js";

export type ChildEntrypointPathSource = "env" | "default";

export function configuredChildEntrypointPathSource(): ChildEntrypointPathSource {
  return process.env.SUBAGENT007_PI_CHILD_PATH ? "env" : "default";
}

export function configuredChildEntrypointPath(options: { defaultDir?: string } = {}): string {
  if (process.env.SUBAGENT007_PI_CHILD_PATH) {
    return path.resolve(process.env.SUBAGENT007_PI_CHILD_PATH);
  }
  return path.join(options.defaultDir ?? path.dirname(fileURLToPath(import.meta.url)), "piChild.js");
}

export async function assertConfiguredChildEntrypointAvailable(
  options: { defaultDir?: string } = {},
): Promise<string> {
  const childEntrypoint = configuredChildEntrypointPath(options);
  try {
    const stat = await fs.stat(childEntrypoint);
    if (!stat.isFile()) {
      throw new ValidationError(`Subagent007 child entrypoint is not a file: ${childEntrypoint}`);
    }
    return childEntrypoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ValidationError(
        `Subagent007 child entrypoint is missing: ${childEntrypoint}. Run npm run build and restart the MCP server.`,
      );
    }
    throw error;
  }
}
