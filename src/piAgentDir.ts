import os from "node:os";
import path from "node:path";

function expandHome(entry: string): string {
  if (entry === "~") {
    return os.homedir();
  }
  if (entry.startsWith("~/")) {
    return path.join(os.homedir(), entry.slice(2));
  }
  return entry;
}

export function resolvePiAgentDir(): string {
  const configured = process.env.SUBAGENT007_PI_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  return configured ? path.resolve(expandHome(configured)) : path.join(os.homedir(), ".pi", "agent");
}
