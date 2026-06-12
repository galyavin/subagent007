import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { failureClassForProcessResult, logFailure, type FailureLogTool } from "./failureLog.js";
import {
  defaultInputRequestsDir,
  listInputRequests,
  newRunId,
  type InputRequestView,
} from "./inputMailbox.js";
import {
  createFinalMessageTarget,
  defaultSubagentStatePath,
  readFinalMessage,
  writeRunOutput,
} from "./output.js";
import { createPromptProvenance } from "./prompt.js";
import { runChildProcess } from "./processRunner.js";
import type { HeartbeatNotify } from "./progress.js";
import { computeTimeoutBudget } from "./timeoutBudget.js";
import { resolvePiAgentDir } from "./piAgentDir.js";
import { resolveRequestedSkill } from "./skillResources.js";
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
  const configured = process.env.SUBAGENT007_INPUT_REQUEST_TIMEOUT_MS;
  if (configured) {
    const parsed = Number.parseInt(configured, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 24 * 60 * 60 * 1000;
}

function defaultRunSubagentTimeoutMs(): number {
  const configured = process.env.SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS;
  if (configured) {
    const parsed = Number.parseInt(configured, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_RUN_SUBAGENT_TIMEOUT_MS;
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

function piChildPath(): string {
  if (process.env.SUBAGENT007_PI_CHILD_PATH) {
    return path.resolve(process.env.SUBAGENT007_PI_CHILD_PATH);
  }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "piChild.js");
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

export async function runSubagentCore(
  request: RunSubagentRequest,
  options: {
    runId?: string;
    mailboxRoot?: string;
    runsDir?: string;
    suppressFailureLog?: boolean;
    failureLogTool?: FailureLogTool;
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
    throw new ValidationError("timeout_ms is not supported by run_subagent; use schedule_run or start_run for timed work");
  }
  const config = await loadConfig();
  const resolved = await validateAndResolveRequest(request, config);
  const skillFilePath = options.skillFilePath ?? resolveSkillFilePathForRequest(resolved);
  const runId = options.runId ?? newRunId();
  const mailboxRoot = options.mailboxRoot ?? defaultInputRequestsDir();
  const inputRequestsDir = path.join(mailboxRoot, runId);
  await fs.mkdir(inputRequestsDir, { recursive: true });
  const finalMessageTarget = await createFinalMessageTarget(resolved.outputMode, "subagent007-pi-final-");

  let childRequest: { requestPath: string; cleanup: () => Promise<void> } | undefined;
  try {
    const timeoutBudget = computeTimeoutBudget(
      resolved.timeoutMs ?? (options.allowTimeout ? undefined : defaultRunSubagentTimeoutMs()),
    );
    const sessionMode = sessionModeFor(resolved.continuity);
    const promptProvenance = options.promptProvenance ?? createPromptProvenance({
      publicPrompt: resolved.prompt,
      skill: resolved.skill,
    });
    const childPayload: PiChildRequestFile = {
      prompt: promptProvenance.composed_child_prompt,
      cwd: resolved.cwd,
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel,
      skill: resolved.skill,
      skillFilePath,
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
    const processResult = await runChildProcess({
      command: process.execPath,
      args: [piChildPath(), childRequest.requestPath],
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
      onOutputLine: options.onOutputLine,
    });
    const finalMessage = await readFinalMessage(finalMessageTarget.outputLastMessagePath);
    const writtenOutputMode: OutputMode = finalMessage ? "final" : "transcript";
    const output = await writeRunOutput(finalMessage ?? processResult.combinedOutput, options.runsDir, {
      processTranscript: !finalMessage,
      promptProvenance,
    });
    const processSuccess =
      processResult.exitCode === 0 && !processResult.timedOut && !processResult.cancelled;
    const parsedSessionId = extractSubagentSessionId(processResult.combinedOutput);
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
      status: processResult.cancelled ? "cancelled" : success ? "completed" : "failed",
      output_path: output.outputPath,
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
      requested_output_mode: resolved.outputMode,
      written_output_mode: writtenOutputMode,
      resolved_tool_profile: resolved.toolProfile,
      stop_reason: processResult.stopReason,
      ...(timeoutRecoveryHint ? { timeout_recovery_hint: timeoutRecoveryHint } : {}),
      session_id: sessionId,
      session_established: sessionEstablished,
      input_requests_dir: inputRequestsDir,
    };
    if (!result.success && !processResult.cancelled && !options.suppressFailureLog) {
      const missingSessionId =
        sessionMode.kind === "fresh" && !sessionEstablished && result.exit_code === 0;
      const failureClass = result.timed_out
        ? "timeout"
        : missingSessionId
          ? "missing_session_id"
          : failureClassForProcessResult(result);
      const reasonCode = failureClass === "timeout"
        ? "timeout"
        : failureClass === "missing_session_id"
          ? "missing_session_id"
          : failureClass === "nonzero_exit"
            ? "nonzero_exit"
            : "unknown_error";
      await logFailure({
        tool: options.failureLogTool ?? "run_subagent",
        failure_class: failureClass,
        reason_code: reasonCode,
        cwd: resolved.cwd,
        output_path: result.output_path,
        success: result.success,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        partial_output_available: result.partial_output_available,
        resume_possible: result.resume_possible,
        duration_ms: result.duration_ms,
        requested_timeout_ms: result.requested_timeout_ms,
        resolved_timeout_ms: result.resolved_timeout_ms,
        timeout_floor_ms: result.timeout_floor_ms,
        effective_timeout_ms: result.effective_timeout_ms,
        timeout_headroom_ms: result.timeout_headroom_ms,
        kill_grace_ms: result.kill_grace_ms,
        force_grace_ms: result.force_grace_ms,
        model_class: result.resolved_model_class,
        model: result.resolved_model,
        thinking_level: result.resolved_thinking_level,
        skill: result.requested_skill,
        output_mode: result.requested_output_mode,
        tool_profile: result.resolved_tool_profile,
      });
    }
    return result;
  } finally {
    await finalMessageTarget.cleanup();
    await childRequest?.cleanup();
  }
}

export const runSubagent = runSubagentCore;
