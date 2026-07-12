import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createOwnedTemporaryDir } from "./ownedTemporaryArtifact.js";
import type { OutputMode, PromptProvenance } from "./types.js";
import {
  preparePublicTranscriptFromProcessOutput,
  projectProcessOutputLine,
  provenancePublicLines,
  publicTranscriptContentFlags,
  type PublicOutputLine,
} from "./transcript.js";

type PublicTranscriptContentFlags = ReturnType<typeof publicTranscriptContentFlags>;

interface StoredRunOutput {
  outputPath: string;
  sizeBytes: number;
  hasPublicAssistantText: boolean;
  hasPublicSubagentWarning: boolean;
  hasPublicSubagentError: boolean;
}

export function defaultSubagentStatePath(envKey: string, leaf: string): string {
  return process.env[envKey]
    ? path.resolve(process.env[envKey])
    : path.join(os.homedir(), ".codex", "subagent007-pi", leaf);
}

export function resolveRunsDir(runsDir?: string): string {
  if (runsDir) {
    return path.resolve(runsDir);
  }
  return defaultSubagentStatePath("SUBAGENT007_RUNS_DIR", "runs");
}

export function defaultSessionsDir(): string {
  return defaultSubagentStatePath("SUBAGENT007_SESSIONS_DIR", "sessions");
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
  const outputLastMessageDir = await createOwnedTemporaryDir(tmpPrefix);
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

async function writePreparedRunOutput(
  runsDir: string,
  cleaned: string,
  transcriptFlags: PublicTranscriptContentFlags,
): Promise<StoredRunOutput> {
  await fs.mkdir(runsDir, { recursive: true });
  const id = timestampedRandomId();
  const stagingPath = path.join(runsDir, `.${id}.partial`);
  const outputPath = path.join(runsDir, `${id}.md`);
  await fs.writeFile(stagingPath, cleaned, { encoding: "utf8", flag: "wx" });
  await fs.rename(stagingPath, outputPath);
  return {
    outputPath: path.resolve(outputPath),
    sizeBytes: Buffer.byteLength(cleaned, "utf8"),
    hasPublicAssistantText: transcriptFlags.hasAssistantText,
    hasPublicSubagentWarning: transcriptFlags.hasSubagentWarning,
    hasPublicSubagentError: transcriptFlags.hasSubagentError,
  };
}

export async function writeRunOutput(
  rawOutput: string,
  runsDir = resolveRunsDir(),
  options: { processTranscript?: boolean; promptProvenance?: PromptProvenance } = {},
): Promise<StoredRunOutput> {
  const transcript = options.processTranscript
    ? preparePublicTranscriptFromProcessOutput(rawOutput, { promptProvenance: options.promptProvenance })
    : null;
  const prepared = transcript ? transcript.text : rawOutput;
  const cleaned = stripAnsiAndControls(prepared);
  const transcriptFlags = transcript
    ? publicTranscriptContentFlags(cleaned)
    : { hasAssistantText: false, hasSubagentWarning: false, hasSubagentError: false };
  return writePreparedRunOutput(runsDir, cleaned, transcriptFlags);
}

export interface StreamingRunTranscript {
  stagingPath: string;
  appendProcessLine: (line: string) => Promise<void>;
  finalize: () => Promise<StoredRunOutput>;
  preservePartial: () => Promise<void>;
  discard: () => Promise<void>;
}

export async function createStreamingRunTranscript(
  runsDir = resolveRunsDir(),
  options: { promptProvenance?: PromptProvenance; ownerId?: string } = {},
): Promise<StreamingRunTranscript> {
  const resolvedRunsDir = resolveRunsDir(runsDir);
  await fs.mkdir(resolvedRunsDir, { recursive: true });
  const id = timestampedRandomId();
  const ownerPrefix = options.ownerId ? `${options.ownerId}.` : "";
  const stagingPath = path.join(resolvedRunsDir, `.${ownerPrefix}${id}.partial`);
  const outputPath = path.join(resolvedRunsDir, `${id}.md`);
  const handle = await fs.open(stagingPath, "wx+");
  const initialLines = provenancePublicLines(options.promptProvenance);
  let mode: "undetermined" | "raw" | "structured" = "undetermined";
  let blockCount = 0;
  let closed = false;
  let hasAssistantText = false;
  let hasSubagentWarning = false;
  let hasSubagentError = false;

  const appendBlock = async (text: string, classification?: PublicOutputLine): Promise<void> => {
    const cleaned = stripAnsiAndControls(text);
    if (cleaned.trim() === "") {
      return;
    }
    await handle.appendFile(`${blockCount > 0 ? "\n\n" : ""}${cleaned}`, "utf8");
    blockCount += 1;
    hasAssistantText ||= classification?.kind === "assistant";
    hasSubagentWarning ||= classification?.kind === "warning";
    hasSubagentError ||= classification?.kind === "error";
  };

  const resetToInitialLines = async (): Promise<void> => {
    await handle.truncate(0);
    blockCount = 0;
    hasAssistantText = false;
    hasSubagentWarning = false;
    hasSubagentError = false;
    for (const line of initialLines) {
      await appendBlock(line.text, line);
    }
  };

  await resetToInitialLines();

  const closeHandle = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await handle.sync();
    await handle.close();
  };

  return {
    stagingPath: path.resolve(stagingPath),
    appendProcessLine: async (line) => {
      if (closed) {
        throw new Error("cannot append to a closed run transcript");
      }
      const projection = projectProcessOutputLine(line);
      if (projection.controlsTranscriptMode && mode !== "structured") {
        mode = "structured";
        await resetToInitialLines();
      }
      if (mode === "structured") {
        if (projection.publicLine && !(options.promptProvenance && projection.publicLine.kind === "user")) {
          await appendBlock(projection.publicLine.text, projection.publicLine);
        }
        return;
      }
      if (projection.publicLine) {
        await appendBlock(projection.publicLine.text, projection.publicLine);
        return;
      }
      if (projection.rawFallbackLine !== null) {
        mode = "raw";
        await appendBlock(projection.rawFallbackLine);
      }
    },
    finalize: async () => {
      if (blockCount === 0) {
        await appendBlock("[subagent007 transcript unavailable: no public events captured]");
      }
      await closeHandle();
      await fs.rename(stagingPath, outputPath);
      const stats = await fs.stat(outputPath);
      return {
        outputPath: path.resolve(outputPath),
        sizeBytes: stats.size,
        hasPublicAssistantText: hasAssistantText,
        hasPublicSubagentWarning: hasSubagentWarning,
        hasPublicSubagentError: hasSubagentError,
      };
    },
    preservePartial: closeHandle,
    discard: async () => {
      try {
        await closeHandle();
      } finally {
        await fs.rm(stagingPath, { force: true });
      }
    },
  };
}

export async function recoverStreamingRunTranscript(
  stagingPath: string,
  runId: string,
): Promise<{ outputPath: string; sizeBytes: number } | undefined> {
  const basename = path.basename(stagingPath);
  const prefix = `.${runId}.`;
  if (!basename.startsWith(prefix) || !basename.endsWith(".partial")) {
    return undefined;
  }
  const outputId = basename.slice(prefix.length, -".partial".length);
  if (outputId === "") {
    return undefined;
  }
  const outputPath = path.join(path.dirname(stagingPath), `${outputId}.md`);
  try {
    await fs.rename(stagingPath, outputPath);
    const stats = await fs.stat(outputPath);
    return { outputPath: path.resolve(outputPath), sizeBytes: stats.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    try {
      const stats = await fs.stat(outputPath);
      return { outputPath: path.resolve(outputPath), sizeBytes: stats.size };
    } catch (successorError) {
      if ((successorError as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw successorError;
    }
  }
}

export function runOutputReference(
  outputPath: string,
  sizeBytes: number,
  outputMode: OutputMode,
): {
  kind: "file";
  name: "primary";
  path: string;
  size_bytes: number;
  content_type: "text/markdown";
  encoding: "utf-8";
  output_mode: OutputMode;
} {
  return {
    kind: "file",
    name: "primary",
    path: path.resolve(outputPath),
    size_bytes: sizeBytes,
    content_type: "text/markdown",
    encoding: "utf-8",
    output_mode: outputMode,
  };
}
