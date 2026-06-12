import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { OutputMode, PromptProvenance } from "./types.js";
import {
  preparePublicTranscriptFromProcessOutput,
  publicTranscriptContentFlags,
} from "./transcript.js";

export function defaultSubagentStatePath(envKey: string, leaf: string): string {
  return process.env[envKey]
    ? path.resolve(process.env[envKey])
    : path.join(os.homedir(), ".codex", "subagent007-pi", leaf);
}

export function defaultRunsDir(): string {
  return defaultSubagentStatePath("SUBAGENT007_RUNS_DIR", "runs");
}

export function defaultSessionsDir(): string {
  return defaultSubagentStatePath("SUBAGENT007_SESSIONS_DIR", "sessions");
}

function uniqueRunPath(runsDir: string): string {
  return path.join(runsDir, `${timestampedRandomId()}.md`);
}

export function timestampedRandomId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "");
  const suffix = randomBytes(6).toString("hex");
  return `${timestamp}-${suffix}`;
}

export function stripAnsiAndControls(input: string): string {
  return input
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export async function createFinalMessageTarget(
  outputMode: OutputMode,
  tmpPrefix: string,
): Promise<{
  outputLastMessagePath?: string;
  cleanup: () => Promise<void>;
}> {
  if (outputMode !== "final") {
    return { cleanup: async () => {} };
  }
  const outputLastMessageDir = await fs.mkdtemp(path.join(os.tmpdir(), tmpPrefix));
  return {
    outputLastMessagePath: path.join(outputLastMessageDir, "last-message.md"),
    cleanup: async () => {
      await fs.rm(outputLastMessageDir, { recursive: true, force: true });
    },
  };
}

export async function readFinalMessage(outputLastMessagePath?: string): Promise<string | undefined> {
  if (!outputLastMessagePath) {
    return undefined;
  }
  try {
    const message = await fs.readFile(outputLastMessagePath, "utf8");
    return message.trim() === "" ? undefined : message;
  } catch {
    return undefined;
  }
}

export async function writeRunOutput(
  rawOutput: string,
  runsDir = defaultRunsDir(),
  options: { processTranscript?: boolean; promptProvenance?: PromptProvenance } = {},
): Promise<{
  outputPath: string;
  sizeBytes: number;
  hasPublicAssistantText: boolean;
  hasPublicSubagentWarning: boolean;
  hasPublicSubagentError: boolean;
}> {
  await fs.mkdir(runsDir, { recursive: true });
  const outputPath = uniqueRunPath(runsDir);
  const transcript = options.processTranscript
    ? preparePublicTranscriptFromProcessOutput(rawOutput, { promptProvenance: options.promptProvenance })
    : null;
  const prepared = transcript ? transcript.text : rawOutput;
  const cleaned = stripAnsiAndControls(prepared);
  const transcriptFlags = transcript ? publicTranscriptContentFlags(cleaned) : null;
  await fs.writeFile(outputPath, cleaned, { encoding: "utf8", flag: "wx" });
  return {
    outputPath: path.resolve(outputPath),
    sizeBytes: Buffer.byteLength(cleaned, "utf8"),
    hasPublicAssistantText: transcriptFlags?.hasAssistantText ?? false,
    hasPublicSubagentWarning: transcriptFlags?.hasSubagentWarning ?? false,
    hasPublicSubagentError: transcriptFlags?.hasSubagentError ?? false,
  };
}
