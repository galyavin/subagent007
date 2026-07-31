import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOwnedTemporaryDir } from "./ownedTemporaryArtifact.js";
import type { OutputMode, PromptProvenance, RunOutputReference } from "./types.js";
import {
  preparePublicTranscriptFromProcessOutput,
  projectProcessOutputLine,
  provenancePublicLines,
  publicTranscriptContentFlags,
  type PublicOutputLine,
} from "./transcript.js";

type PublicTranscriptContentFlags = ReturnType<typeof publicTranscriptContentFlags>;

export const MAX_TERMINAL_OUTPUT_BYTES = 1024 * 1024;
const FINALIZER_READ_CHUNK_BYTES = 64 * 1024;
const TIMESTAMPED_RANDOM_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{9}Z-[0-9a-f]{12}$/;

export interface StoredRunOutput {
  reference: RunOutputReference;
  hasPublicAssistantText: boolean;
  hasPublicSubagentWarning: boolean;
  hasPublicSubagentError: boolean;
}

export interface PendingTerminalOutputFile {
  name: "primary" | "packet";
  staging_path: string;
  output_path: string;
  size_bytes: number;
  content_sha256: string;
}

export interface PendingTerminalOutputs {
  schema_version: 1;
  run_id: string;
  outputs: [PendingTerminalOutputFile, PendingTerminalOutputFile];
}

export interface PreparedRunOutput {
  ownership: PendingTerminalOutputFile;
  publish: () => Promise<StoredRunOutput>;
  discard: () => Promise<void>;
}

interface FinalizeHooks {
  /** Deterministic race witnesses used by source tests. */
  beforeRename?: () => void | Promise<void>;
  afterDescriptorRead?: () => void | Promise<void>;
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

function terminalOutputLimitError(): Error {
  return new Error("run output exceeds the 1 MiB terminal-output limit");
}

function canonicalOutputBasename(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value !== value.normalize("NFC") ||
    value !== path.basename(value) || value.includes("/") || value.includes("\\") ||
    value === "." || value === ".." || !value.endsWith(".md")) {
    return false;
  }
  return TIMESTAMPED_RANDOM_ID_PATTERN.test(value.slice(0, -".md".length));
}

function canonicalStagingPath(stagingPath: unknown, outputPath: unknown): stagingPath is string {
  if (
    typeof stagingPath !== "string" ||
    typeof outputPath !== "string" ||
    !path.isAbsolute(stagingPath) ||
    !path.isAbsolute(outputPath) ||
    path.dirname(stagingPath) !== path.dirname(outputPath)
  ) return false;
  const outputBasename = path.basename(outputPath);
  return canonicalOutputBasename(outputBasename) &&
    path.basename(stagingPath) === `.${outputBasename.slice(0, -".md".length)}.partial`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

export function decodeRunOutputReference(value: unknown): RunOutputReference | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const reference = value as Record<string, unknown>;
  if (!exactKeys(reference, [
    "kind", "name", "relative_path", "size_bytes", "content_sha256",
    "content_type", "encoding", "output_mode",
  ])) return undefined;
  if (
    reference.kind !== "file" || (reference.name !== "primary" && reference.name !== "packet") ||
    !canonicalOutputBasename(reference.relative_path) ||
    !Number.isSafeInteger(reference.size_bytes) || (reference.size_bytes as number) < 0 ||
    (reference.size_bytes as number) > MAX_TERMINAL_OUTPUT_BYTES ||
    typeof reference.content_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(reference.content_sha256) ||
    reference.content_type !== "text/markdown" || reference.encoding !== "utf-8" ||
    (reference.output_mode !== "final" && reference.output_mode !== "transcript")
  ) return undefined;
  return { ...reference } as unknown as RunOutputReference;
}

export function runOutputReference(
  relativePath: string,
  sizeBytes: number,
  contentSha256: string,
  outputMode: OutputMode,
): RunOutputReference {
  const reference = decodeRunOutputReference({
    kind: "file",
    name: "primary",
    relative_path: relativePath,
    size_bytes: sizeBytes,
    content_sha256: contentSha256,
    content_type: "text/markdown",
    encoding: "utf-8",
    output_mode: outputMode,
  });
  if (!reference) throw new Error("cannot emit a noncanonical run output reference");
  return reference;
}

export function runOutputPath(reference: RunOutputReference, runsDir = resolveRunsDir()): string {
  const validated = decodeRunOutputReference(reference);
  if (!validated) throw new Error("run output reference is malformed");
  return path.join(resolveRunsDir(runsDir), validated.relative_path);
}

/**
 * Reads a published public output only when its canonical reference still
 * names the same bounded no-follow regular file and exact bytes. This is for
 * private in-process consumers; public views retain references only.
 */
export async function readValidatedRunOutput(
  reference: RunOutputReference,
  runsDir = resolveRunsDir(),
): Promise<string> {
  const validated = decodeRunOutputReference(reference);
  if (!validated) throw new Error("run output cannot be validated");
  try {
    const outputPath = runOutputPath(validated, runsDir);
    const handle = await openNoFollowRegular(outputPath, fsConstants.O_RDONLY);
    try {
      const inspected = await inspectBoundedDescriptor(handle);
      if (
        inspected.sizeBytes !== validated.size_bytes ||
        inspected.contentSha256 !== validated.content_sha256
      ) {
        throw new Error("run output cannot be validated");
      }
      await assertPathStillNamesDescriptor(outputPath, inspected.stat);
      const bytes = Buffer.allocUnsafe(inspected.sizeBytes);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead <= 0) throw new Error("run output cannot be validated");
        offset += bytesRead;
      }
      const afterRead = await handle.stat({ bigint: true });
      if (!unchangedDescriptorStat(inspected.stat, afterRead)) {
        throw new Error("run output cannot be validated");
      }
      await assertPathStillNamesDescriptor(outputPath, afterRead);
      const output = bytes.toString("utf8");
      if (!Buffer.from(output, "utf8").equals(bytes)) {
        throw new Error("run output cannot be validated");
      }
      return output;
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error("run output cannot be validated");
  }
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

type DescriptorStat = BigIntStats;

function isRegularSingleLink(stat: DescriptorStat): boolean {
  return stat.isFile() && stat.nlink === 1n;
}

function unchangedDescriptorStat(left: DescriptorStat, right: DescriptorStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function descriptorSha256(handle: FileHandle, sizeBytes: number): Promise<string> {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_TERMINAL_OUTPUT_BYTES) {
    throw terminalOutputLimitError();
  }
  const hash = createHash("sha256");
  let offset = 0;
  while (offset < sizeBytes) {
    const length = Math.min(FINALIZER_READ_CHUNK_BYTES, sizeBytes - offset);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) throw new Error("run output changed during descriptor finalization");
    hash.update(buffer);
    offset += bytesRead;
  }
  return hash.digest("hex");
}

async function assertPathStillNamesDescriptor(
  filePath: string,
  descriptorStat: DescriptorStat,
): Promise<void> {
  const named = await fs.lstat(filePath, { bigint: true }).catch(() => undefined);
  if (!named || !named.isFile() || named.nlink !== 1n ||
    !unchangedDescriptorStat(descriptorStat, named)) {
    throw new Error("run output changed during descriptor finalization");
  }
}

async function inspectBoundedDescriptor(
  handle: FileHandle,
  afterDescriptorRead?: () => void | Promise<void>,
): Promise<{
  stat: DescriptorStat;
  sizeBytes: number;
  contentSha256: string;
}> {
  const before = await handle.stat({ bigint: true });
  if (!isRegularSingleLink(before)) {
    throw new Error("run output must be a no-follow single-link regular file");
  }
  if (before.size < 0n || before.size > BigInt(MAX_TERMINAL_OUTPUT_BYTES)) {
    throw terminalOutputLimitError();
  }
  const sizeBytes = Number(before.size);
  const contentSha256 = await descriptorSha256(handle, sizeBytes);
  await afterDescriptorRead?.();
  const afterHash = await handle.stat({ bigint: true });
  if (!unchangedDescriptorStat(before, afterHash) || !isRegularSingleLink(afterHash)) {
    throw new Error("run output changed during descriptor finalization");
  }
  return { stat: afterHash, sizeBytes, contentSha256 };
}

async function openNoFollowRegular(filePath: string, flags: number): Promise<FileHandle> {
  try {
    return await fs.open(filePath, flags | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    throw new Error(
      `run output must be a no-follow single-link regular file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function finalizeDescriptorToOutput(input: {
  handle: FileHandle;
  stagingPath: string;
  outputPath: string;
  outputMode: OutputMode;
  alreadyPublished?: boolean;
  hooks?: FinalizeHooks;
}): Promise<RunOutputReference> {
  if (!input.alreadyPublished) {
    const beforeRename = await input.handle.stat({ bigint: true });
    if (!isRegularSingleLink(beforeRename)) {
      throw new Error("run output must be a no-follow single-link regular file");
    }
    await input.hooks?.beforeRename?.();
    const afterBeforeRename = await input.handle.stat({ bigint: true });
    if (!unchangedDescriptorStat(beforeRename, afterBeforeRename) || !isRegularSingleLink(afterBeforeRename)) {
      throw new Error("run output changed during descriptor finalization");
    }
    await assertPathStillNamesDescriptor(input.stagingPath, afterBeforeRename);
    await fs.rename(input.stagingPath, input.outputPath);
  }
  const inspected = await inspectBoundedDescriptor(input.handle, input.hooks?.afterDescriptorRead);
  await assertPathStillNamesDescriptor(input.outputPath, inspected.stat);
  return runOutputReference(
    path.basename(input.outputPath),
    inspected.sizeBytes,
    inspected.contentSha256,
    input.outputMode,
  );
}

async function readBoundedDescriptorFile(filePath: string): Promise<string | undefined> {
  let handle: FileHandle;
  try {
    handle = await openNoFollowRegular(filePath, fsConstants.O_RDONLY);
  } catch {
    return undefined;
  }
  try {
    const inspected = await inspectBoundedDescriptor(handle);
    const bytes = Buffer.allocUnsafe(inspected.sizeBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead <= 0) throw new Error("final message changed during bounded descriptor read");
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!unchangedDescriptorStat(inspected.stat, after)) {
      throw new Error("final message changed during bounded descriptor read");
    }
    const message = bytes.toString("utf8");
    return message.trim() === "" ? undefined : message;
  } finally {
    await handle.close();
  }
}

export async function readFinalMessage(outputLastMessagePath?: string): Promise<string | undefined> {
  if (!outputLastMessagePath) return undefined;
  return readBoundedDescriptorFile(outputLastMessagePath);
}

async function writeAllBounded(handle: FileHandle, bytes: Buffer): Promise<void> {
  if (bytes.length > MAX_TERMINAL_OUTPUT_BYTES) throw terminalOutputLimitError();
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten <= 0) throw new Error("bounded run output write made no progress");
    offset += bytesWritten;
  }
}

async function writePreparedRunOutput(
  runsDir: string,
  cleaned: string,
  transcriptFlags: PublicTranscriptContentFlags,
  outputMode: OutputMode,
): Promise<StoredRunOutput> {
  const bytes = Buffer.from(cleaned, "utf8");
  if (bytes.length > MAX_TERMINAL_OUTPUT_BYTES) throw terminalOutputLimitError();
  const resolvedRunsDir = resolveRunsDir(runsDir);
  await fs.mkdir(resolvedRunsDir, { recursive: true });
  const id = timestampedRandomId();
  const stagingPath = path.join(resolvedRunsDir, `.${id}.partial`);
  const outputPath = path.join(resolvedRunsDir, `${id}.md`);
  const handle = await fs.open(stagingPath, "wx+");
  try {
    await writeAllBounded(handle, bytes);
    const reference = await finalizeDescriptorToOutput({ handle, stagingPath, outputPath, outputMode });
    return {
      reference,
      hasPublicAssistantText: transcriptFlags.hasAssistantText,
      hasPublicSubagentWarning: transcriptFlags.hasSubagentWarning,
      hasPublicSubagentError: transcriptFlags.hasSubagentError,
    };
  } finally {
    await handle.close();
  }
}

export async function prepareRunOutput(
  rawOutput: string,
  name: "primary" | "packet",
  runsDir = resolveRunsDir(),
): Promise<PreparedRunOutput> {
  const cleaned = stripAnsiAndControls(rawOutput);
  const bytes = Buffer.from(cleaned, "utf8");
  if (bytes.length > MAX_TERMINAL_OUTPUT_BYTES) throw terminalOutputLimitError();
  const resolvedRunsDir = resolveRunsDir(runsDir);
  await fs.mkdir(resolvedRunsDir, { recursive: true });
  const id = timestampedRandomId();
  const stagingPath = path.join(resolvedRunsDir, `.${id}.partial`);
  const outputPath = path.join(resolvedRunsDir, `${id}.md`);
  const handle = await fs.open(stagingPath, "wx+");
  let closed = false;
  const closeHandle = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  try {
    await writeAllBounded(handle, bytes);
    await handle.sync();
    const inspected = await inspectBoundedDescriptor(handle);
    await assertPathStillNamesDescriptor(stagingPath, inspected.stat);
    const ownership: PendingTerminalOutputFile = {
      name,
      staging_path: stagingPath,
      output_path: outputPath,
      size_bytes: inspected.sizeBytes,
      content_sha256: inspected.contentSha256,
    };
    return {
      ownership,
      publish: async () => {
        if (closed) throw new Error("prepared run output is already closed");
        try {
          const reference = await finalizeDescriptorToOutput({
            handle,
            stagingPath,
            outputPath,
            outputMode: "final",
          });
          return {
            reference: { ...reference, name },
            hasPublicAssistantText: false,
            hasPublicSubagentWarning: false,
            hasPublicSubagentError: false,
          };
        } finally {
          await closeHandle();
        }
      },
      discard: async () => {
        await closeHandle().catch(() => {});
        await fs.rm(stagingPath, { force: true });
        await fs.rm(outputPath, { force: true });
      },
    };
  } catch (error) {
    await closeHandle().catch(() => {});
    await fs.rm(stagingPath, { force: true }).catch(() => {});
    await fs.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function pendingTerminalOutputs(
  runId: string,
  primary: PendingTerminalOutputFile,
  packet: PendingTerminalOutputFile,
): PendingTerminalOutputs {
  const value: PendingTerminalOutputs = {
    schema_version: 1,
    run_id: runId,
    outputs: [primary, packet],
  };
  assertPendingTerminalOutputs(value, runId);
  return value;
}

export function assertPendingTerminalOutputs(
  value: unknown,
  expectedRunId?: string,
): asserts value is PendingTerminalOutputs {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("pending terminal output ownership must be an object");
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["schema_version", "run_id", "outputs"]) ||
    record.schema_version !== 1 ||
    typeof record.run_id !== "string" ||
    record.run_id === "" ||
    (expectedRunId !== undefined && record.run_id !== expectedRunId) ||
    !Array.isArray(record.outputs) ||
    record.outputs.length !== 2) {
    throw new Error("pending terminal output ownership is malformed");
  }
  const roles = new Set<string>();
  const paths = new Set<string>();
  for (const candidate of record.outputs) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("pending terminal output entry is malformed");
    }
    const output = candidate as Record<string, unknown>;
    if (!exactKeys(output, [
      "name", "staging_path", "output_path", "size_bytes", "content_sha256",
    ]) ||
      (output.name !== "primary" && output.name !== "packet") ||
      !canonicalStagingPath(output.staging_path, output.output_path) ||
      !Number.isSafeInteger(output.size_bytes) ||
      (output.size_bytes as number) < 0 ||
      (output.size_bytes as number) > MAX_TERMINAL_OUTPUT_BYTES ||
      typeof output.content_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(output.content_sha256)) {
      throw new Error("pending terminal output entry is invalid");
    }
    roles.add(output.name);
    paths.add(output.staging_path as string);
    paths.add(output.output_path as string);
  }
  if (roles.size !== 2 || !roles.has("primary") || !roles.has("packet") || paths.size !== 4) {
    throw new Error("pending terminal output roles or paths are not exact");
  }
  const directories = new Set(
    (record.outputs as Array<Record<string, unknown>>).map((output) =>
      path.dirname(output.output_path as string)),
  );
  if (directories.size !== 1) {
    throw new Error("pending terminal outputs must share one runs directory");
  }
}

async function removeOwnedTerminalOutputPath(
  filePath: string,
  expected: PendingTerminalOutputFile,
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await openNoFollowRegular(filePath, fsConstants.O_RDONLY);
  } catch (error) {
    const missing = await fs.lstat(filePath).then(
      () => false,
      (failure: NodeJS.ErrnoException) => failure.code === "ENOENT",
    );
    if (missing) return;
    throw error;
  }
  try {
    const inspected = await inspectBoundedDescriptor(handle);
    if (
      inspected.sizeBytes !== expected.size_bytes ||
      inspected.contentSha256 !== expected.content_sha256
    ) {
      throw new Error("owned terminal output bytes changed before cleanup");
    }
    await assertPathStillNamesDescriptor(filePath, inspected.stat);
    await fs.rm(filePath);
  } finally {
    await handle.close();
  }
}

export async function cleanupPendingTerminalOutputs(value: PendingTerminalOutputs): Promise<void> {
  assertPendingTerminalOutputs(value, value.run_id);
  for (const output of value.outputs) {
    await removeOwnedTerminalOutputPath(output.staging_path, output);
    await removeOwnedTerminalOutputPath(output.output_path, output);
  }
  const directory = path.dirname(value.outputs[0].output_path);
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function terminalReferencesOwnPendingOutputs(
  references: readonly RunOutputReference[] | undefined,
  pending: PendingTerminalOutputs,
): boolean {
  if (!references || references.length !== 2) return false;
  return pending.outputs.every((output) => {
    const reference = references.find((candidate) => candidate.name === output.name);
    return reference !== undefined &&
      reference.relative_path === path.basename(output.output_path) &&
      reference.size_bytes === output.size_bytes &&
      reference.content_sha256 === output.content_sha256 &&
      reference.output_mode === "final";
  });
}

export async function writeRunOutput(
  rawOutput: string,
  runsDir = resolveRunsDir(),
  options: { processTranscript?: boolean; promptProvenance?: PromptProvenance; outputMode?: OutputMode } = {},
): Promise<StoredRunOutput> {
  const transcript = options.processTranscript
    ? preparePublicTranscriptFromProcessOutput(rawOutput, { promptProvenance: options.promptProvenance })
    : null;
  const prepared = transcript ? transcript.text : rawOutput;
  const cleaned = stripAnsiAndControls(prepared);
  const transcriptFlags = transcript
    ? publicTranscriptContentFlags(cleaned)
    : { hasAssistantText: false, hasSubagentWarning: false, hasSubagentError: false };
  return writePreparedRunOutput(runsDir, cleaned, transcriptFlags, options.outputMode ?? "final");
}

export interface StreamingRunTranscript {
  stagingPath: string;
  appendProcessLine: (line: string) => Promise<void>;
  finalize: (hooks?: FinalizeHooks) => Promise<StoredRunOutput>;
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
  let byteCount = 0;
  let closed = false;
  let hasAssistantText = false;
  let hasSubagentWarning = false;
  let hasSubagentError = false;

  const appendBlock = async (text: string, classification?: PublicOutputLine): Promise<void> => {
    const cleaned = stripAnsiAndControls(text);
    if (cleaned.trim() === "") return;
    const bytes = Buffer.from(`${blockCount > 0 ? "\n\n" : ""}${cleaned}`, "utf8");
    if (byteCount + bytes.length > MAX_TERMINAL_OUTPUT_BYTES) throw terminalOutputLimitError();
    let written = 0;
    while (written < bytes.length) {
      const result = await handle.write(bytes, written, bytes.length - written, byteCount + written);
      if (result.bytesWritten <= 0) throw new Error("bounded transcript write made no progress");
      written += result.bytesWritten;
    }
    byteCount += bytes.length;
    blockCount += 1;
    hasAssistantText ||= classification?.kind === "assistant";
    hasSubagentWarning ||= classification?.kind === "warning";
    hasSubagentError ||= classification?.kind === "error";
  };

  const resetToInitialLines = async (): Promise<void> => {
    await handle.truncate(0);
    blockCount = 0;
    byteCount = 0;
    hasAssistantText = false;
    hasSubagentWarning = false;
    hasSubagentError = false;
    for (const line of initialLines) await appendBlock(line.text, line);
  };

  await resetToInitialLines();

  const closeHandle = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.sync();
    await handle.close();
  };

  return {
    stagingPath: path.resolve(stagingPath),
    appendProcessLine: async (line) => {
      if (closed) throw new Error("cannot append to a closed run transcript");
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
    finalize: async (hooks) => {
      if (closed) throw new Error("cannot finalize a closed run transcript");
      if (blockCount === 0) await appendBlock("[subagent007 transcript unavailable: no public events captured]");
      try {
        const reference = await finalizeDescriptorToOutput({
          handle,
          stagingPath,
          outputPath,
          outputMode: "transcript",
          hooks,
        });
        return {
          reference,
          hasPublicAssistantText: hasAssistantText,
          hasPublicSubagentWarning: hasSubagentWarning,
          hasPublicSubagentError: hasSubagentError,
        };
      } finally {
        await closeHandle();
      }
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
  hooks?: FinalizeHooks,
): Promise<RunOutputReference | undefined> {
  const basename = path.basename(stagingPath);
  const prefix = `.${runId}.`;
  if (!basename.startsWith(prefix) || !basename.endsWith(".partial") ||
    stagingPath !== path.join(path.dirname(stagingPath), basename)) return undefined;
  const outputId = basename.slice(prefix.length, -".partial".length);
  if (!TIMESTAMPED_RANDOM_ID_PATTERN.test(outputId)) return undefined;
  const outputPath = path.join(path.dirname(stagingPath), `${outputId}.md`);

  let handle: FileHandle;
  let alreadyPublished = false;
  try {
    handle = await openNoFollowRegular(stagingPath, fsConstants.O_RDWR);
  } catch (error) {
    const stagingMissing = await fs.lstat(stagingPath).then(() => false, (failure: NodeJS.ErrnoException) => failure.code === "ENOENT");
    if (!stagingMissing) throw error;
    const outputMissing = await fs.lstat(outputPath).then(() => false, (failure: NodeJS.ErrnoException) => failure.code === "ENOENT");
    if (outputMissing) return undefined;
    handle = await openNoFollowRegular(outputPath, fsConstants.O_RDWR);
    alreadyPublished = true;
  }
  try {
    return await finalizeDescriptorToOutput({
      handle,
      stagingPath,
      outputPath,
      outputMode: "transcript",
      alreadyPublished,
      hooks,
    });
  } finally {
    await handle.close();
  }
}
