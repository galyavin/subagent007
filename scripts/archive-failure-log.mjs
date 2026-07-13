#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { archiveFailureLog } from "../dist/failureStorage.js";

function defaultFailureLogPath() {
  return process.env.SUBAGENT007_FAILURE_LOG_PATH
    ? path.resolve(process.env.SUBAGENT007_FAILURE_LOG_PATH)
    : path.join(os.homedir(), ".codex", "subagent007-pi", "failures.jsonl");
}

const usage = () => [
  "usage: node scripts/archive-failure-log.mjs", "", "Archives the configured Subagent007 failure log.", "",
  "Options:", "  -h, --help  Show this help without mutating archive state.",
].join("\n");

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  console.log(usage());
  process.exit(0);
}
if (args.length > 0) {
  console.error(`unknown argument: ${args.join(" ")}\n\n${usage()}`);
  process.exit(2);
}

console.log(JSON.stringify(await archiveFailureLog(defaultFailureLogPath()), null, 2));
