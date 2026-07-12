import { createRequire } from "node:module";
import path from "node:path";
import { projectRootFromModuleUrl } from "./projectRoot.js";

const require = createRequire(import.meta.url);
const packageJson = require(path.join(projectRootFromModuleUrl(import.meta.url), "package.json")) as {
  version?: unknown;
};

export const SERVER_VERSION =
  typeof packageJson.version === "string" && packageJson.version.trim() !== ""
    ? packageJson.version
    : "0.0.0";

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function serverBuildSha(): string | undefined {
  return optionalEnv("SUBAGENT007_BUILD_SHA") ?? optionalEnv("GIT_COMMIT");
}
