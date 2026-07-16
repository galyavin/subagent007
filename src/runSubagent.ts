import fs from "node:fs/promises";
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
  createStreamingRunTranscript,
  createFinalMessageTarget,
  defaultSubagentStatePath,
  runOutputReference,
  readFinalMessage,
  type StreamingRunTranscript,
  writeRunOutput,
} from "./output.js";
import { assertDiskReserveAvailable } from "./diskReserve.js";
import { createOwnedTemporaryDir } from "./ownedTemporaryArtifact.js";
import { createPromptProvenance } from "./prompt.js";
import { runChildProcess } from "./processRunner.js";
import type { HeartbeatNotify } from "./progress.js";
import { computeTimeoutBudget } from "./timeoutBudget.js";
import { safeIntegerFromEnv } from "./env.js";
import { resolvePiAgentDir } from "./piAgentDir.js";
import { resolveRequestedSkill } from "./skillResources.js";
import type { FailureReasonCode, RunStopReason } from "./types.js";
import type {
  ActivationReceipt,
  ActivationSkillBinding,
  OutputMode,
  PromptProvenance,
  ResolvedRunSubagentRequest,
  RunContinuity,
  RunSubagentRequest,
  RunSubagentResult,
} from "./types.js";
import { ValidationError } from "./types.js";
import { validateAndResolveRequest } from "./validate.js";
import {
  recursiveControlConfigForChild,
  type RecursiveControlChildConfig,
} from "./recursiveControl.js";
import { validatedActivationReceipt } from "./toolProfile.js";

const DEFAULT_RUN_SUBAGENT_TIMEOUT_MS = 110_000;
export const RUN_SUBAGENT_TIMEOUT_RECOVERY_HINT =
  "Use schedule_run or start_run with explicit timeout_ms for broad, exploratory, interactive, cancellable, polling, or long-running work.";

type RunSubagentSessionMode =
  | { kind: "ephemeral" }
  | { kind: "fresh" }
  | { kind: "resume"; sessionId: string };

type UsageLimitMetadata = Pick<
  RunSubagentResult,
  | "provider_error_type"
  | "provider_status_code"
  | "provider_error_message"
  | "usage_limit_plan_type"
  | "usage_limit_resets_at"
  | "usage_limit_resets_in_seconds"
  | "usage_limit_retry_after_seconds"
  | "usage_limit_primary_used_percent"
  | "usage_limit_secondary_used_percent"
  | "usage_limit_primary_reset_after_seconds"
  | "usage_limit_secondary_reset_after_seconds"
>;

interface ChildFailureMetadata {
  reasonCode?: FailureReasonCode;
  usageLimitMetadata?: UsageLimitMetadata;
}

interface PiChildRequestFile {
  prompt: string;
  cwd: string;
  model: string;
  thinkingLevel: string;
  skill?: string;
  skillFilePath?: string;
  outputMode: OutputMode;
  outputLastMessagePath?: string;
  promptProvenance?: PromptProvenance;
  mailboxRoot: string;
  runId: string;
  inputTimeoutMs: number;
  sessionMode: "ephemeral" | "fresh" | "resume";
  sessionFile?: string;
  sessionDir?: string;
  recursiveControl?: RecursiveControlChildConfig;
  effectProfile?: ResolvedRunSubagentRequest["effectProfile"];
  expectedSkillSha256?: string;
  skillBinding?: ActivationSkillBinding;
}

export interface ChildInputResponseAccepted {
  runId: string;
  requestId: string;
  responseId: string;
}

function inputResponseAcceptedFromLine(line: string): ChildInputResponseAccepted | undefined {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (
      event.type !== "subagent007.input_response_accepted" ||
      typeof event.run_id !== "string" ||
      typeof event.request_id !== "string" ||
      typeof event.response_id !== "string"
    ) {
      return undefined;
    }
    return {
      runId: event.run_id,
      requestId: event.request_id,
      responseId: event.response_id,
    };
  } catch {
    return undefined;
  }
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
  const dir = await createOwnedTemporaryDir("subagent007-pi-child-");
  const requestPath = path.join(dir, `${randomBytes(6).toString("hex")}.json`);
  let persistedRequest = request;
  if (request.skillBinding && request.skillFilePath) {
    const skillSnapshotDir = path.join(dir, "skill-snapshot");
    const skillSnapshotPath = path.join(skillSnapshotDir, "SKILL.md");
    await fs.mkdir(skillSnapshotDir, { recursive: true });
    try {
      await fs.copyFile(request.skillFilePath, skillSnapshotPath);
    } catch (error) {
      throw new ValidationError(
        `resolved skill content could not be snapshotted before child launch: ${(error as Error).message}`,
        "skill_content_mismatch",
      );
    }
    await fs.chmod(skillSnapshotPath, 0o400);
    persistedRequest = { ...request, skillFilePath: skillSnapshotPath };
  }
  await fs.writeFile(requestPath, `${JSON.stringify(persistedRequest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
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
  resourceExhausted?: boolean;
  finalMessage?: string;
  hasPublicAssistantText: boolean;
  hasPublicSubagentWarning: boolean;
  hasPublicSubagentError: boolean;
}): boolean {
  return Boolean(
    (input.timedOut || input.resourceExhausted) &&
      (input.finalMessage ||
        input.hasPublicAssistantText ||
        input.hasPublicSubagentWarning ||
        input.hasPublicSubagentError),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function headerValue(headers: Record<string, unknown> | undefined, headerName: string): unknown {
  if (!headers) {
    return undefined;
  }
  const lowerHeaderName = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerHeaderName) {
      return value;
    }
  }
  return undefined;
}

function usageLimitMetadataFromErrorEvent(event: Record<string, unknown>): UsageLimitMetadata {
  const providerError = asRecord(event.error);
  const headers = asRecord(event.headers) ?? asRecord(providerError?.headers);
  const providerErrorType = stringFromUnknown(providerError?.type) ?? "usage_limit_reached";
  const providerStatusCode = numberFromUnknown(event.status_code);
  const providerErrorMessage = stringFromUnknown(providerError?.message);
  const planType = stringFromUnknown(providerError?.plan_type) ?? stringFromUnknown(headerValue(headers, "X-Codex-Plan-Type"));
  const resetsAt = numberFromUnknown(providerError?.resets_at);
  const resetsInSeconds = numberFromUnknown(providerError?.resets_in_seconds);
  const retryAfterSeconds = numberFromUnknown(headerValue(headers, "Retry-After"));
  const primaryUsedPercent = numberFromUnknown(headerValue(headers, "X-Codex-Primary-Used-Percent"));
  const secondaryUsedPercent = numberFromUnknown(headerValue(headers, "X-Codex-Secondary-Used-Percent"));
  const primaryResetAfterSeconds = numberFromUnknown(headerValue(headers, "X-Codex-Primary-Reset-After-Seconds"));
  const secondaryResetAfterSeconds = numberFromUnknown(headerValue(headers, "X-Codex-Secondary-Reset-After-Seconds"));

  return {
    provider_error_type: providerErrorType,
    ...(providerStatusCode !== undefined ? { provider_status_code: providerStatusCode } : {}),
    ...(providerErrorMessage !== undefined ? { provider_error_message: providerErrorMessage } : {}),
    ...(planType !== undefined ? { usage_limit_plan_type: planType } : {}),
    ...(resetsAt !== undefined ? { usage_limit_resets_at: resetsAt } : {}),
    ...(resetsInSeconds !== undefined ? { usage_limit_resets_in_seconds: resetsInSeconds } : {}),
    ...(retryAfterSeconds !== undefined ? { usage_limit_retry_after_seconds: retryAfterSeconds } : {}),
    ...(primaryUsedPercent !== undefined ? { usage_limit_primary_used_percent: primaryUsedPercent } : {}),
    ...(secondaryUsedPercent !== undefined ? { usage_limit_secondary_used_percent: secondaryUsedPercent } : {}),
    ...(primaryResetAfterSeconds !== undefined
      ? { usage_limit_primary_reset_after_seconds: primaryResetAfterSeconds }
      : {}),
    ...(secondaryResetAfterSeconds !== undefined
      ? { usage_limit_secondary_reset_after_seconds: secondaryResetAfterSeconds }
      : {}),
  };
}

function parseSubagentErrorEvent(line: string): Record<string, unknown> | undefined {
  if (!line.includes("[subagent007 error]") && !line.includes("\"type\":\"subagent007.error\"")) {
    return undefined;
  }
  try {
    const jsonStart = line.indexOf("{");
    if (jsonStart < 0) {
      return undefined;
    }
    const event = asRecord(JSON.parse(line.slice(jsonStart)));
    return event?.type === "subagent007.error" || line.includes("[subagent007 error]")
      ? event
      : undefined;
  } catch {
    return undefined;
  }
}

function childFailureMetadataFromLine(line: string): ChildFailureMetadata {
  const errorEvent = parseSubagentErrorEvent(line);
  if (
    errorEvent?.reason_code === "effect_profile_activation_failed" ||
    errorEvent?.reason_code === "skill_content_mismatch"
  ) {
    return { reasonCode: errorEvent.reason_code };
  }
  const providerError = asRecord(errorEvent?.error);
  if (providerError?.type === "usage_limit_reached") {
    return {
      reasonCode: "usage_limit_reached",
      usageLimitMetadata: usageLimitMetadataFromErrorEvent(errorEvent ?? {}),
    };
  }
  if (line.includes("\"type\":\"usage_limit_reached\"")) {
    return { reasonCode: "usage_limit_reached" };
  }
  return {};
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
  missingFinalOutput: boolean;
  resourceExhausted: boolean;
  activationFailed: boolean;
  childFailureReasonCode?: FailureReasonCode;
}): { error_class?: string; reason_code?: FailureReasonCode } {
  if (input.success || input.cancelled) {
    return {};
  }
  if (input.timedOut || input.stopReason === "timeout") {
    return { error_class: "timeout", reason_code: "timeout" };
  }
  if (input.resourceExhausted || input.stopReason === "resource_exhausted") {
    return { error_class: "resource_exhausted", reason_code: "disk_reserve_exhausted" };
  }
  if (input.activationFailed || input.childFailureReasonCode === "effect_profile_activation_failed" || input.childFailureReasonCode === "skill_content_mismatch") {
    return {
      error_class: "capability_unavailable",
      reason_code: input.childFailureReasonCode ?? "effect_profile_activation_failed",
    };
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
  if (input.missingFinalOutput) {
    return { error_class: "missing_final_output", reason_code: "missing_final_output" };
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
  skillBinding: ActivationSkillBinding | null;
}> {
  if (!resolved.skill || !skillFilePath) {
    return {
      resolvedSkillPath: null,
      resolvedSkillSha256: null,
      skillBinding: null,
    };
  }
  const resolvedSkillPath = path.resolve(skillFilePath);
  const content = await fs.readFile(resolvedSkillPath);
  const resolvedSkillSha256 = createHash("sha256").update(content).digest("hex");
  return {
    resolvedSkillPath,
    resolvedSkillSha256,
    skillBinding: {
      name: resolved.skill,
      path: resolvedSkillPath,
      content_sha256: resolvedSkillSha256,
      expected_content_sha256: null,
    },
  };
}

export async function assertExpectedSkillBinding(
  resolved: Pick<ResolvedRunSubagentRequest, "skill" | "expectedSkillSha256">,
  skillFilePath: string | undefined,
): Promise<void> {
  if (!resolved.expectedSkillSha256) {
    return;
  }
  let audit: Awaited<ReturnType<typeof resolvedSkillAuditMetadata>>;
  try {
    audit = await resolvedSkillAuditMetadata(resolved, skillFilePath);
  } catch (error) {
    throw new ValidationError(
      `resolved skill content could not be verified before child launch: ${(error as Error).message}`,
      "skill_content_mismatch",
    );
  }
  if (audit.resolvedSkillSha256 !== resolved.expectedSkillSha256) {
    throw new ValidationError(
      `resolved skill content SHA-256 does not match expected_skill_sha256 for ${JSON.stringify(resolved.skill)}`,
      "skill_content_mismatch",
    );
  }
}

function activationReceiptFromLine(input: {
  line: string;
  resolved: ResolvedRunSubagentRequest;
  skillBinding: ActivationSkillBinding | null;
}): ActivationReceipt | undefined {
  try {
    const event = JSON.parse(input.line) as { type?: unknown; receipt?: unknown };
    if (event.type !== "subagent007.activation_confirmed") {
      return undefined;
    }
    return validatedActivationReceipt({
      value: event.receipt,
      effectProfile: input.resolved.effectProfile,
      skillBinding: input.skillBinding,
      expectedSkillSha256: input.resolved.expectedSkillSha256,
    });
  } catch {
    return undefined;
  }
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
    rootRunId?: string;
    recursionDepth?: number;
    onChildControlReady?: (send: (message: string) => boolean) => void;
    onInputResponseAccepted?: (response: ChildInputResponseAccepted) => void;
    onTranscriptStaged?: (stagingPath: string) => void | Promise<void>;
    onChildSpawned?: () => void | Promise<void>;
    onActivationConfirmed?: (receipt: ActivationReceipt) => void | Promise<void>;
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
  let skillAudit: Awaited<ReturnType<typeof resolvedSkillAuditMetadata>>;
  try {
    skillAudit = await resolvedSkillAuditMetadata(resolved, skillFilePath);
  } catch (error) {
    if (resolved.expectedSkillSha256 || resolved.effectProfile) {
      throw new ValidationError(
        `resolved skill content could not be verified before child launch: ${(error as Error).message}`,
        "skill_content_mismatch",
      );
    }
    throw error;
  }
  await assertExpectedSkillBinding(resolved, skillFilePath);
  const skillBinding = skillAudit.skillBinding
    ? {
        ...skillAudit.skillBinding,
        expected_content_sha256: resolved.expectedSkillSha256 ?? null,
      }
    : null;
  const runId = options.runId ?? newRunId();
  const mailboxRoot = options.mailboxRoot ?? defaultInputRequestsDir();
  const inputRequestsDir = path.join(mailboxRoot, runId);
  await fs.mkdir(inputRequestsDir, { recursive: true });
  const finalMessageTarget = await createFinalMessageTarget(resolved.outputMode, "subagent007-pi-final-");

  let childRequest: { requestPath: string; cleanup: () => Promise<void> } | undefined;
  let transcript: StreamingRunTranscript | undefined;
  try {
    const childEntrypoint = await assertPiChildEntrypointAvailable();
    const diskReserve = await assertDiskReserveAvailable(options.runsDir);
    const timeoutBudget = computeTimeoutBudget(
      resolved.timeoutMs ?? (options.allowTimeout ? undefined : defaultRunSubagentTimeoutMs()),
    );
    const sessionMode = sessionModeFor(resolved.continuity);
    const promptProvenance = options.promptProvenance ?? createPromptProvenance({
      publicPrompt: resolved.prompt,
      skill: resolved.skill,
    });
    transcript = await createStreamingRunTranscript(options.runsDir, {
      promptProvenance,
      ownerId: runId,
    });
    await options.onTranscriptStaged?.(transcript.stagingPath);
    const childSkillFilePath = resolved.skill ? skillAudit.resolvedSkillPath ?? skillFilePath : undefined;
    const childPayload: PiChildRequestFile = {
      prompt: promptProvenance.composed_child_prompt,
      cwd: resolved.cwd,
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel,
      skill: resolved.skill,
      skillFilePath: childSkillFilePath,
      outputMode: resolved.outputMode,
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
      recursiveControl: recursiveControlConfigForChild({
        runId,
        rootRunId: options.rootRunId,
        recursionDepth: options.recursionDepth,
      }),
      ...(resolved.effectProfile ? { effectProfile: resolved.effectProfile } : {}),
      ...(resolved.expectedSkillSha256 ? { expectedSkillSha256: resolved.expectedSkillSha256 } : {}),
      ...((resolved.effectProfile || resolved.expectedSkillSha256) && skillBinding
        ? { skillBinding }
        : {}),
    };
    if (resolved.effectProfile) {
      delete childPayload.recursiveControl;
    }
    childRequest = await writeChildRequestFile(childPayload);
    let parsedSessionId: string | null = null;
    let childFailure: ChildFailureMetadata = {};
    let activationReceipt: ActivationReceipt | undefined;
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
      diskReserve,
      onControlReady: options.onChildControlReady,
      onChildSpawned: options.onChildSpawned,
      onOutputLine: async (line) => {
        await transcript?.appendProcessLine(line);
        parsedSessionId ??= extractSubagentSessionId(line);
        const lineActivationReceipt = activationReceiptFromLine({ line, resolved, skillBinding });
        if (!activationReceipt && lineActivationReceipt) {
          activationReceipt = lineActivationReceipt;
          await options.onActivationConfirmed?.(lineActivationReceipt);
        }
        const lineFailure = childFailureMetadataFromLine(line);
        if (lineFailure.reasonCode || lineFailure.usageLimitMetadata) {
          childFailure = lineFailure;
        }
        const accepted = inputResponseAcceptedFromLine(line);
        if (accepted?.runId === runId) {
          options.onInputResponseAccepted?.(accepted);
        }
        try {
          await options.onOutputLine?.(line);
        } catch {
          // Active event projection remains best-effort; transcript persistence is authoritative.
        }
      },
    });
    const finalMessage = await readFinalMessage(finalMessageTarget.outputLastMessagePath);
    const writtenOutputMode: OutputMode = finalMessage ? "final" : "transcript";
    const output = finalMessage
      ? await writeRunOutput(finalMessage, options.runsDir)
      : await transcript.finalize();
    if (finalMessage) {
      await transcript.discard();
    }
    const processSuccess =
      processResult.exitCode === 0 &&
      !processResult.timedOut &&
      !processResult.cancelled &&
      !processResult.resourceExhausted;
    const activationRequired = Boolean(resolved.effectProfile || resolved.expectedSkillSha256);
    const activationConfirmed = !activationRequired || activationReceipt !== undefined;
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
    const missingFinalOutput = processSuccess && resolved.outputMode === "final" && !finalMessage;
    const success =
      processSuccess && activationConfirmed && !missingFinalOutput && (sessionMode.kind !== "fresh" || sessionEstablished);
    const partialOutputAvailable = partialOutputAvailableForRun({
      timedOut: processResult.timedOut,
      resourceExhausted: processResult.resourceExhausted,
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
      requested_skill: resolved.skill ?? null,
      resolved_skill_path: skillAudit.resolvedSkillPath,
      resolved_skill_sha256: skillAudit.resolvedSkillSha256,
      ...(resolved.expectedSkillSha256 ? { expected_skill_sha256: resolved.expectedSkillSha256 } : {}),
      ...(resolved.effectProfile ? { requested_effect_profile: resolved.effectProfile } : {}),
      ...(activationReceipt?.resolved_effect_profile
        ? { resolved_effect_profile: activationReceipt.resolved_effect_profile }
        : {}),
      ...(activationReceipt ? { activation_receipt: activationReceipt } : {}),
      requested_output_mode: resolved.outputMode,
      written_output_mode: writtenOutputMode,
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
        missingFinalOutput,
        resourceExhausted: processResult.resourceExhausted,
        activationFailed: !activationConfirmed,
        childFailureReasonCode: childFailure.reasonCode ?? (
          !activationConfirmed
            ? resolved.effectProfile
              ? "effect_profile_activation_failed"
              : "skill_content_mismatch"
            : undefined
        ),
      }),
      ...(childFailure.usageLimitMetadata ?? {}),
      ...(timeoutRecoveryHint ? { timeout_recovery_hint: timeoutRecoveryHint } : {}),
      session_id: sessionId,
      session_established: sessionEstablished,
      input_requests_dir: inputRequestsDir,
    };
    return result;
  } finally {
    await finalMessageTarget.cleanup();
    await childRequest?.cleanup();
    // An unsettled .partial transcript is intentionally retained for crash/failure recovery.
    await transcript?.preservePartial().catch(() => {
      // Preserve the original run failure when the filesystem cannot even close the partial artifact.
    });
  }
}
