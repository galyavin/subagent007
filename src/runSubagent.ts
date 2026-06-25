import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { assertConfiguredChildEntrypointAvailable } from "./childEntrypoint.js";
import { loadConfig } from "./config.js";
import {
  defaultInputRequestsDir,
  listInputRequests,
  newRunId,
  type InputRequestView,
} from "./inputMailbox.js";
import {
  createFinalMessageTarget,
  defaultSubagentStatePath,
  runOutputReference,
  readFinalMessage,
  writeRunOutput,
  writeRunOutputFromProcessOutputFile,
} from "./output.js";
import { createPromptProvenance } from "./prompt.js";
import { runChildProcess } from "./processRunner.js";
import type { HeartbeatNotify } from "./progress.js";
import { computeTimeoutBudget } from "./timeoutBudget.js";
import { safeIntegerFromEnv } from "./env.js";
import { resolvePiAgentDir } from "./piAgentDir.js";
import { resolveRequestedSkill } from "./skillResources.js";
import type { FailureReasonCode, RunStopReason } from "./types.js";
import type {
  OutputMode,
  PromptProvenance,
  ResolvedRunSubagentRequest,
  RunContinuity,
  RunSubagentRequest,
  RunSubagentResult,
  ToolProfile,
} from "./types.js";
import { ValidationError } from "./types.js";
import { validateAndResolveRequest } from "./validate.js";

const DEFAULT_RUN_SUBAGENT_TIMEOUT_MS = 110_000;
const FAILURE_OUTPUT_TAIL_BYTES = 64 * 1024;
export const RUN_SUBAGENT_TIMEOUT_RECOVERY_HINT =
  "Use schedule_run or start_run with explicit timeout_ms for broad, exploratory, interactive, cancellable, polling, or long-running work.";

type RunSubagentSessionMode =
  | { kind: "ephemeral" }
  | { kind: "fresh" }
  | { kind: "resume"; sessionId: string };

interface PiChildRequestFile {
  prompt: string;
  cwd: string;
  model: string;
  thinkingLevel: string;
  skill?: string;
  skillFilePath?: string;
  outputMode: OutputMode;
  toolProfile: ToolProfile;
  outputLastMessagePath?: string;
  promptProvenance?: PromptProvenance;
  mailboxRoot: string;
  runId: string;
  inputTimeoutMs: number;
  sessionMode: "ephemeral" | "fresh" | "resume";
  sessionFile?: string;
  sessionDir?: string;
}

function defaultInputRequestTimeoutMs(): number {
  return safeIntegerFromEnv("SUBAGENT007_INPUT_REQUEST_TIMEOUT_MS", 24 * 60 * 60 * 1000, 1);
}

function defaultRunSubagentTimeoutMs(): number {
  return safeIntegerFromEnv(
    "SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS",
    DEFAULT_RUN_SUBAGENT_TIMEOUT_MS,
    1,
  );
}

function defaultRawPiSessionsDir(): string {
  return defaultSubagentStatePath("SUBAGENT007_PI_RAW_SESSIONS_DIR", "pi-raw-sessions");
}

function sessionModeFor(continuity: RunContinuity): RunSubagentSessionMode {
  if (continuity.mode === "resume") {
    return { kind: "resume", sessionId: continuity.session_id };
  }
  return { kind: continuity.mode };
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  const normalized = singleLine(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function pendingInputHeartbeatMessage(requests: InputRequestView[]): string | undefined {
  if (requests.length === 0) {
    return undefined;
  }
  const visible = requests.slice(0, 3).map((request) =>
    `${request.request_id}: ${truncate(request.question, 120)}`,
  );
  const remaining = requests.length - visible.length;
  const suffix = remaining > 0 ? `; +${remaining} more` : "";
  const label = requests.length === 1
    ? "pending input request"
    : `pending input requests (${requests.length})`;
  return `${label}: ${visible.join("; ")}${suffix} (answer with answer_run_input)`;
}

async function heartbeatMessageForPendingInput(
  mailboxRoot: string,
  runId: string,
): Promise<string | undefined> {
  return pendingInputHeartbeatMessage(
    await listInputRequests({ mailboxRoot, runId, status: "pending" }),
  );
}

export async function assertPiChildEntrypointAvailable(): Promise<string> {
  return assertConfiguredChildEntrypointAvailable();
}

async function writeChildRequestFile(request: PiChildRequestFile): Promise<{
  requestPath: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-child-"));
  const requestPath = path.join(dir, `${randomBytes(6).toString("hex")}.json`);
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return {
    requestPath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export function extractSubagentSessionId(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as { type?: string; session_id?: string | null };
      if (event.type === "subagent007.session" && typeof event.session_id === "string") {
        return event.session_id;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function partialOutputAvailableForRun(input: {
  timedOut: boolean;
  finalMessage?: string;
  hasPublicAssistantText: boolean;
  hasPublicSubagentWarning: boolean;
  hasPublicSubagentError: boolean;
}): boolean {
  return Boolean(
    input.timedOut &&
      (input.finalMessage ||
        input.hasPublicAssistantText ||
        input.hasPublicSubagentWarning ||
        input.hasPublicSubagentError),
  );
}

async function readOutputTail(filePath: string): Promise<string> {
  const stats = await fs.stat(filePath);
  const start = Math.max(0, stats.size - FAILURE_OUTPUT_TAIL_BYTES);
  const length = stats.size - start;
  if (length === 0) {
    return "";
  }
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function childFailureReasonCodeFromOutput(outputText: string): FailureReasonCode | undefined {
  return outputText.split(/\r?\n/).some((line) =>
    line.includes("[subagent007 error]") && line.includes("\"type\":\"usage_limit_reached\"")
  )
    ? "usage_limit_reached"
    : undefined;
}

async function childFailureReasonCodeFromOutputFile(filePath: string): Promise<FailureReasonCode | undefined> {
  try {
    return childFailureReasonCodeFromOutput(await readOutputTail(filePath));
  } catch {
    return undefined;
  }
}

function runErrorTaxonomy(input: {
  success: boolean;
  cancelled: boolean;
  timedOut: boolean;
  stopReason: RunStopReason;
  exitCode: number | null;
  stopSignal: string | null;
  sessionMode: RunSubagentSessionMode;
  sessionEstablished: boolean;
  childFailureReasonCode?: FailureReasonCode;
}): { error_class?: string; reason_code?: FailureReasonCode } {
  if (input.success || input.cancelled) {
    return {};
  }
  if (input.timedOut || input.stopReason === "timeout") {
    return { error_class: "timeout", reason_code: "timeout" };
  }
  if (input.stopReason === "spawn_error") {
    return { error_class: "unknown_error", reason_code: "spawn_error" };
  }
  if (
    input.sessionMode.kind === "fresh" &&
    !input.sessionEstablished &&
    input.exitCode === 0
  ) {
    return { error_class: "missing_session_id", reason_code: "missing_session_id" };
  }
  if (input.exitCode !== null && input.exitCode !== 0) {
    return { error_class: "nonzero_exit", reason_code: input.childFailureReasonCode ?? "nonzero_exit" };
  }
  if (input.stopSignal) {
    return { error_class: "signal_terminated", reason_code: "process_signal_terminated" };
  }
  return { error_class: "unknown_error", reason_code: "unknown_error" };
}

export function resolveSkillFilePathForRequest(
  resolved: Pick<ResolvedRunSubagentRequest, "cwd" | "skill">,
): string | undefined {
  if (!resolved.skill) {
    return undefined;
  }
  return resolveRequestedSkill(resolved.skill, {
    cwd: resolved.cwd,
    agentDir: resolvePiAgentDir(),
  }).filePath;
}

async function resolvedSkillAuditMetadata(
  resolved: Pick<ResolvedRunSubagentRequest, "skill">,
  skillFilePath: string | undefined,
): Promise<{
  resolvedSkillPath: string | null;
  resolvedSkillSha256: string | null;
}> {
  if (!resolved.skill || !skillFilePath) {
    return {
      resolvedSkillPath: null,
      resolvedSkillSha256: null,
    };
  }
  const resolvedSkillPath = path.resolve(skillFilePath);
  const content = await fs.readFile(resolvedSkillPath);
  return {
    resolvedSkillPath,
    resolvedSkillSha256: createHash("sha256").update(content).digest("hex"),
  };
}

export async function runSubagentCore(
  request: RunSubagentRequest,
  options: {
    runId?: string;
    mailboxRoot?: string;
    runsDir?: string;
    allowTimeout?: boolean;
    piSessionDir?: string;
    heartbeat?: HeartbeatNotify;
    heartbeatIntervalMs?: number;
    abortSignal?: AbortSignal;
    onOutputLine?: (line: string) => void | Promise<void>;
    promptProvenance?: PromptProvenance;
    skillFilePath?: string;
  } = {},
): Promise<RunSubagentResult> {
  if (!options.allowTimeout && request.timeout_ms !== undefined) {
    throw new ValidationError(
      "timeout_ms is not supported by run_subagent; use schedule_run or start_run for timed work",
      "run_subagent_timeout_unsupported",
    );
  }
  const config = await loadConfig();
  const resolved = await validateAndResolveRequest(request, config);
  const skillFilePath = options.skillFilePath ?? resolveSkillFilePathForRequest(resolved);
  const skillAudit = await resolvedSkillAuditMetadata(resolved, skillFilePath);
  const runId = options.runId ?? newRunId();
  const mailboxRoot = options.mailboxRoot ?? defaultInputRequestsDir();
  const inputRequestsDir = path.join(mailboxRoot, runId);
  await fs.mkdir(inputRequestsDir, { recursive: true });
  const finalMessageTarget = await createFinalMessageTarget(resolved.outputMode, "subagent007-pi-final-");

  let childRequest: { requestPath: string; cleanup: () => Promise<void> } | undefined;
  let processOutputPath: string | undefined;
  try {
    const childEntrypoint = await assertPiChildEntrypointAvailable();
    const timeoutBudget = computeTimeoutBudget(
      resolved.timeoutMs ?? (options.allowTimeout ? undefined : defaultRunSubagentTimeoutMs()),
    );
    const sessionMode = sessionModeFor(resolved.continuity);
    const promptProvenance = options.promptProvenance ?? createPromptProvenance({
      publicPrompt: resolved.prompt,
      skill: resolved.skill,
    });
    const childSkillFilePath = resolved.skill ? skillAudit.resolvedSkillPath ?? skillFilePath : undefined;
    const childPayload: PiChildRequestFile = {
      prompt: promptProvenance.composed_child_prompt,
      cwd: resolved.cwd,
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel,
      skill: resolved.skill,
      skillFilePath: childSkillFilePath,
      outputMode: resolved.outputMode,
      toolProfile: resolved.toolProfile,
      outputLastMessagePath: finalMessageTarget.outputLastMessagePath,
      promptProvenance,
      mailboxRoot,
      runId,
      inputTimeoutMs: timeoutBudget.effectiveTimeoutMs ?? defaultInputRequestTimeoutMs(),
      sessionMode: sessionMode.kind,
      sessionFile: sessionMode.kind === "resume" ? sessionMode.sessionId : undefined,
      sessionDir: sessionMode.kind === "fresh"
        ? options.piSessionDir ?? path.join(defaultRawPiSessionsDir(), runId)
        : sessionMode.kind === "resume"
          ? path.dirname(sessionMode.sessionId)
          : undefined,
    };
    childRequest = await writeChildRequestFile(childPayload);
    let parsedSessionId: string | null = null;
    const processResult = await runChildProcess({
      command: process.execPath,
      args: [childEntrypoint, childRequest.requestPath],
      cwd: resolved.cwd,
      timeoutBudget,
      heartbeat: options.heartbeat
        ? {
            notify: options.heartbeat,
            intervalMs: options.heartbeatIntervalMs,
            message: () => heartbeatMessageForPendingInput(mailboxRoot, runId),
          }
        : undefined,
      abortSignal: options.abortSignal,
      onOutputLine: async (line) => {
        parsedSessionId ??= extractSubagentSessionId(line);
        await options.onOutputLine?.(line);
      },
    });
    processOutputPath = processResult.outputPath;
    const childFailureReasonCode = processResult.exitCode !== null && processResult.exitCode !== 0
      ? await childFailureReasonCodeFromOutputFile(processResult.outputPath)
      : undefined;
    const finalMessage = await readFinalMessage(finalMessageTarget.outputLastMessagePath);
    const writtenOutputMode: OutputMode = finalMessage ? "final" : "transcript";
    const output = finalMessage
      ? await writeRunOutput(finalMessage, options.runsDir)
      : await writeRunOutputFromProcessOutputFile(processResult.outputPath, options.runsDir, {
          promptProvenance,
        });
    const processSuccess =
      processResult.exitCode === 0 && !processResult.timedOut && !processResult.cancelled;
    const sessionId = sessionMode.kind === "fresh"
      ? parsedSessionId
      : sessionMode.kind === "resume"
        ? sessionMode.sessionId
        : null;
    const sessionEstablished = sessionMode.kind === "fresh"
      ? parsedSessionId !== null
      : sessionMode.kind === "resume"
        ? processSuccess
        : false;
    const success = processSuccess && (sessionMode.kind !== "fresh" || sessionEstablished);
    const partialOutputAvailable = partialOutputAvailableForRun({
      timedOut: processResult.timedOut,
      finalMessage,
      hasPublicAssistantText: output.hasPublicAssistantText,
      hasPublicSubagentWarning: output.hasPublicSubagentWarning,
      hasPublicSubagentError: output.hasPublicSubagentError,
    });
    const timeoutRecoveryHint =
      processResult.timedOut && !options.allowTimeout
        ? RUN_SUBAGENT_TIMEOUT_RECOVERY_HINT
        : undefined;
    const resumePossible = Boolean(
      processResult.timedOut &&
        (sessionMode.kind === "resume" || (sessionMode.kind === "fresh" && parsedSessionId)),
    );

    const result: RunSubagentResult = {
      run_id: runId,
      task_id: runId,
      status: processResult.cancelled
        ? "cancelled"
        : processResult.timedOut
          ? "timed_out"
          : success
            ? "completed"
            : "failed",
      output_path: output.outputPath,
      output_references: [runOutputReference(output.outputPath, output.sizeBytes, writtenOutputMode)],
      success,
      exit_code: processResult.exitCode,
      timed_out: processResult.timedOut,
      partial_output_available: partialOutputAvailable,
      resume_possible: resumePossible,
      duration_ms: processResult.durationMs,
      requested_timeout_ms: timeoutBudget.requestedTimeoutMs,
      resolved_timeout_ms: timeoutBudget.resolvedTimeoutMs,
      timeout_floor_ms: timeoutBudget.minRequestedTimeoutMs,
      effective_timeout_ms: timeoutBudget.effectiveTimeoutMs,
      timeout_headroom_ms: timeoutBudget.responseHeadroomMs,
      kill_grace_ms: timeoutBudget.killGraceMs,
      force_grace_ms: timeoutBudget.forceGraceMs,
      size_bytes: output.sizeBytes,
      resolved_model_class: resolved.modelClass,
      resolved_model: resolved.model,
      resolved_thinking_level: resolved.thinkingLevel,
      requested_skill: resolved.skill ?? null,
      resolved_skill_path: skillAudit.resolvedSkillPath,
      resolved_skill_sha256: skillAudit.resolvedSkillSha256,
      requested_output_mode: resolved.outputMode,
      written_output_mode: writtenOutputMode,
      resolved_tool_profile: resolved.toolProfile,
      stop_reason: processResult.stopReason,
      stop_signal: processResult.stopSignal,
      ...runErrorTaxonomy({
        success,
        cancelled: processResult.cancelled,
        timedOut: processResult.timedOut,
        stopReason: processResult.stopReason,
        exitCode: processResult.exitCode,
        stopSignal: processResult.stopSignal,
        sessionMode,
        sessionEstablished,
        childFailureReasonCode,
      }),
      ...(timeoutRecoveryHint ? { timeout_recovery_hint: timeoutRecoveryHint } : {}),
      session_id: sessionId,
      session_established: sessionEstablished,
      input_requests_dir: inputRequestsDir,
    };
    return result;
  } finally {
    await finalMessageTarget.cleanup();
    await childRequest?.cleanup();
    if (processOutputPath) {
      await fs.rm(path.dirname(processOutputPath), { recursive: true, force: true });
    }
  }
}
