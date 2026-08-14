import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
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
  pendingTerminalOutputs,
  prepareRunOutput,
  readFinalMessage,
  type PendingTerminalOutputs,
  type PreparedRunOutput,
  type StoredRunOutput,
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
import {
  SkillBindingVerificationError,
  verifySkillFileBinding,
} from "./skillVerification.js";
import type { FailureReasonCode, RunStopReason } from "./types.js";
import {
  assertResolvedBoundedControllerPython,
  materializeResearchControllerCompletion,
  resolveBoundedControllerPython,
  type ResolvedBoundedControllerPython,
} from "./boundedController.js";
import {
  terminalProjectionIsValid,
  type TerminalProjectionInput,
} from "./terminalProjection.js";
import type {
  ActivationReceipt,
  ActivationToolBinding,
  AuthoringEffectScopeBinding,
  RecursiveDelegationReceipt,
  ActivationSkillBinding,
  OutputMode,
  ModelClass,
  PromptProvenance,
  ResolvedRunSubagentRequest,
  RunContinuity,
  RunSubagentRequest,
  RunSubagentResult,
  SkillSnapshotActivationReceipt,
  SkillSnapshotLaunchBinding,
  SpecialistCatalogueScope,
  SystemSkillActivationReceipt,
} from "./types.js";
import { ValidationError } from "./types.js";
import { validateAndResolveRequest } from "./validate.js";
import {
  recursiveControlConfigForChild,
  type RecursiveControlChildConfig,
} from "./recursiveControl.js";
import {
  boundedControllerActivationBindings,
  boundedControllerScriptPath,
  isBoundedEffectProfile,
  resolveWorkspaceReadOnlyWebProvider,
  taskRootReadOnlyActivationBindings,
  validatedActivationReceipt,
} from "./toolProfile.js";
import {
  resolveSkillSnapshotLaunchBinding,
  SkillSnapshotLaunchError,
  validatedSkillSnapshotActivationReceipt,
} from "./skillSnapshot.js";
import {
  assertAuthoringEffectScopeTerminal,
  captureAuthoringEffectScope,
  isEffectScopedAuthoringProfile,
  type CapturedAuthoringEffectScope,
} from "./authoringEffectScope.js";
import {
  resolveSystemSkillSource,
  validatedSystemSkillActivationReceipt,
  type ResolvedSystemSkillSource,
} from "./systemSkill.js";
import { captureSkillRuntimeBundle } from "./skillRuntimeBundle.js";

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
  recursiveDelegation: ResolvedRunSubagentRequest["recursiveDelegation"];
  requestedRecursiveDelegation: RunSubagentRequest["recursive_delegation"] | null;
  effectProfile?: ResolvedRunSubagentRequest["effectProfile"];
  expectedSkillSha256?: string;
  skillBinding?: ActivationSkillBinding;
  expectedActivationToolBindings?: ActivationToolBinding[];
  controllerPython?: ResolvedBoundedControllerPython;
  skillSnapshotBinding?: SkillSnapshotLaunchBinding;
  expectedSkillSnapshotActivationReceipt?: SkillSnapshotActivationReceipt;
  expectedEffectScopeBinding?: AuthoringEffectScopeBinding;
  systemSkill?: string;
  expectedSystemSkillPath?: string;
  specialistCatalogueScope?: SpecialistCatalogueScope;
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
  if (request.skillBinding && request.skillFilePath && !request.skillSnapshotBinding) {
    const skillSnapshotDir = path.join(dir, "skill-snapshot");
    const skillSnapshotPath = path.join(skillSnapshotDir, "SKILL.md");
    try {
      if (request.effectProfile === "task_root_read_only_v1") {
        const captured = await captureSkillRuntimeBundle(path.dirname(request.skillBinding.path));
        const canonicalSkillPath = await fs.realpath(request.skillBinding.path);
        const capturedSkill = captured.files.find((file) => file.relative_path === "SKILL.md");
        if (
          captured.resolved_skill_path !== canonicalSkillPath ||
          capturedSkill?.content_sha256 !== request.skillBinding.content_sha256
        ) {
          throw new Error("selected skill bundle does not match its admitted SKILL.md binding");
        }
        await fs.mkdir(skillSnapshotDir, { recursive: true, mode: 0o700 });
        for (const file of captured.files) {
          const content = captured.contents.get(file.relative_path);
          if (!content) throw new Error(`selected skill bundle bytes are absent for ${file.relative_path}`);
          const target = path.join(skillSnapshotDir, ...file.relative_path.split("/"));
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await fs.writeFile(target, content, { flag: "wx", mode: file.executable ? 0o500 : 0o400 });
        }
      } else {
        await fs.mkdir(skillSnapshotDir, { recursive: true });
        await fs.copyFile(request.skillFilePath, skillSnapshotPath);
        await fs.chmod(skillSnapshotPath, 0o400);
      }
    } catch (error) {
      throw new ValidationError(
        `resolved selected skill runtime could not be snapshotted before child launch: ${(error as Error).message}`,
        "skill_content_mismatch",
      );
    }
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
    errorEvent?.reason_code === "skill_content_mismatch" ||
    errorEvent?.reason_code === "system_skill_activation_failed"
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
  if (input.activationFailed || input.childFailureReasonCode === "effect_profile_activation_failed" || input.childFailureReasonCode === "skill_content_mismatch" || input.childFailureReasonCode === "system_skill_activation_failed") {
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
  resolved: Pick<ResolvedRunSubagentRequest, "skill" | "expectedSkillSha256">,
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
  const skillBinding = await verifySkillFileBinding({
    skill_name: resolved.skill,
    ...(resolved.expectedSkillSha256
      ? { expected_skill_sha256: resolved.expectedSkillSha256 }
      : {}),
    skillFilePath,
  });
  return {
    resolvedSkillPath: skillBinding.path,
    resolvedSkillSha256: skillBinding.content_sha256,
    skillBinding,
  };
}

function launchSkillContentError(error: unknown): ValidationError {
  if (error instanceof SkillBindingVerificationError) {
    const message = error.failureCode === "skill_unreadable"
      ? "resolved skill content could not be verified before child launch"
      : `resolved skill content SHA-256 does not match expected_skill_sha256 for ${JSON.stringify(error.skillName)}`;
    return new ValidationError(message, "skill_content_mismatch");
  }
  return new ValidationError(
    `resolved skill content could not be verified before child launch: ${(error as Error).message}`,
    "skill_content_mismatch",
  );
}

function launchSkillSnapshotError(error: unknown): ValidationError {
  const message = error instanceof Error ? error.message : String(error);
  return new ValidationError(
    `skill snapshot activation rejected before child launch: ${message}`,
    error instanceof SkillSnapshotLaunchError ? error.reasonCode : "skill_snapshot_altered",
  );
}

export async function assertSkillSnapshotBinding(
  resolved: Pick<ResolvedRunSubagentRequest, "skill" | "skillSnapshotBinding">,
): Promise<Awaited<ReturnType<typeof resolveSkillSnapshotLaunchBinding>> | null> {
  if (!resolved.skillSnapshotBinding || !resolved.skill) return null;
  try {
    return await resolveSkillSnapshotLaunchBinding({
      skill_name: resolved.skill,
      binding: resolved.skillSnapshotBinding,
    });
  } catch (error) {
    throw launchSkillSnapshotError(error);
  }
}

export async function resolveSystemSkillSourceForRequest(
  resolved: Pick<ResolvedRunSubagentRequest, "cwd" | "systemSkill">,
): Promise<ResolvedSystemSkillSource | null> {
  if (!resolved.systemSkill) return null;
  try {
    return await resolveSystemSkillSource({
      systemSkillName: resolved.systemSkill,
      cwd: resolved.cwd,
      agentDir: resolvePiAgentDir(),
    });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(
      `system skill could not be resolved and read before child launch: ${error instanceof Error ? error.message : String(error)}`,
      "invalid_skill",
    );
  }
}

export async function assertExpectedSkillBinding(
  resolved: Pick<ResolvedRunSubagentRequest, "skill" | "expectedSkillSha256">,
  skillFilePath: string | undefined,
): Promise<void> {
  if (!resolved.expectedSkillSha256) {
    return;
  }
  try {
    await resolvedSkillAuditMetadata(resolved, skillFilePath);
  } catch (error) {
    throw launchSkillContentError(error);
  }
}

export async function captureAuthoringEffectScopeForRequest(
  resolved: ResolvedRunSubagentRequest,
): Promise<CapturedAuthoringEffectScope | null> {
  if (!isEffectScopedAuthoringProfile(resolved.effectProfile)) return null;
  return captureAuthoringEffectScope({
    taskRoot: resolved.cwd,
    effectProfile: resolved.effectProfile,
    recursiveDelegation: resolved.recursiveDelegation,
    ...(resolved.effectProfile === "task_root_authoring_v1"
      ? { allowedOutputPaths: resolved.allowedOutputPaths ?? [] }
      : {}),
  });
}

export interface BoundedActivationExpectation {
  effectProfile: Extract<NonNullable<ResolvedRunSubagentRequest["effectProfile"]>, "researcher_bounded_v1" | "assumption_audit_bounded_v1">;
  toolBindings: ActivationToolBinding[];
  controllerPython: ResolvedBoundedControllerPython;
  scriptPath: string;
}

export async function expectedBoundedActivationToolBindings(input: {
  resolved: Pick<ResolvedRunSubagentRequest, "effectProfile" | "skill" | "skillSnapshotBinding">;
  snapshotActivation: Awaited<ReturnType<typeof resolveSkillSnapshotLaunchBinding>> | null;
  childEntrypoint: string;
}): Promise<BoundedActivationExpectation | undefined> {
  if (!isBoundedEffectProfile(input.resolved.effectProfile)) {
    return undefined;
  }
  if (!input.resolved.skill || !input.snapshotActivation) {
    throw new ValidationError(
      `${input.resolved.effectProfile} requires an exact canonical skill snapshot binding`,
      "invalid_skill_snapshot_binding",
    );
  }
  try {
    const [webProvider, controllerPython] = await Promise.all([
      resolveWorkspaceReadOnlyWebProvider(resolvePiAgentDir()),
      resolveBoundedControllerPython(input.resolved.effectProfile),
    ]);
    const controller = await boundedControllerScriptPath(
      input.resolved.effectProfile,
      input.resolved.skill,
      input.snapshotActivation.receipt.resolved_skill_path,
    );
    return {
      effectProfile: input.resolved.effectProfile,
      toolBindings: await boundedControllerActivationBindings({
        effectProfile: input.resolved.effectProfile,
        skillName: input.resolved.skill,
        snapshotSkillFilePath: input.snapshotActivation.receipt.resolved_skill_path,
        childEntrypoint: input.childEntrypoint,
        webProvider,
        controllerPython,
      }),
      controllerPython,
      scriptPath: controller.scriptPath,
    };
  } catch (error) {
    throw new ValidationError(
      `bounded effect profile activation could not bind its provider/controller: ${error instanceof Error ? error.message : String(error)}`,
      "effect_profile_activation_failed",
    );
  }
}

function activationReceiptFromLine(input: {
  line: string;
  resolved: ResolvedRunSubagentRequest;
  skillBinding: ActivationSkillBinding | null;
  expectedToolBindings?: readonly ActivationToolBinding[];
  expectedEffectScopeBinding?: AuthoringEffectScopeBinding;
}): ActivationReceipt | undefined {
  try {
    const event = JSON.parse(input.line) as { type?: unknown; receipt?: unknown };
    if (event.type !== "subagent007.activation_confirmed") {
      return undefined;
    }
    const validated = validatedActivationReceipt({
      value: event.receipt,
      effectProfile: input.resolved.effectProfile,
      skillBinding: input.skillBinding,
      expectedSkillSha256: input.resolved.expectedSkillSha256,
      expectedToolBindings: input.expectedToolBindings,
      expectedEffectScopeBinding: input.expectedEffectScopeBinding,
    });
    return validated;
  } catch {
    return undefined;
  }
}

function skillSnapshotActivationReceiptFromLine(
  line: string,
  expected: SkillSnapshotActivationReceipt | null,
  binding: SkillSnapshotLaunchBinding | undefined,
): SkillSnapshotActivationReceipt | undefined {
  if (!expected || !binding) return undefined;
  try {
    const event = JSON.parse(line) as { type?: unknown; receipt?: unknown };
    if (event.type !== "subagent007.skill_snapshot_activation_confirmed") return undefined;
    const validated = validatedSkillSnapshotActivationReceipt({ value: event.receipt, binding });
    return validated && JSON.stringify(validated) === JSON.stringify(expected) ? expected : undefined;
  } catch {
    return undefined;
  }
}

export function validatedRecursiveDelegationReceipt(input: {
  value: unknown;
  requestedRecursiveDelegation: ResolvedRunSubagentRequest["requestedRecursiveDelegation"];
  resolvedRecursiveDelegation: ResolvedRunSubagentRequest["recursiveDelegation"];
}): RecursiveDelegationReceipt | undefined {
  const receipt = input.value !== null && typeof input.value === "object" && !Array.isArray(input.value)
    ? input.value as Record<string, unknown>
    : undefined;
  if (!receipt || Object.keys(receipt).sort().join("\0") !== [
    "confirmed_before_prompt",
    "delegate_tool_active",
    "requested_recursive_delegation",
    "resolved_recursive_delegation",
    "schema_version",
  ].sort().join("\0")) return undefined;
  const expectedActive = input.resolvedRecursiveDelegation === "enabled";
  if (
    receipt.schema_version !== 1 || receipt.confirmed_before_prompt !== true ||
    receipt.requested_recursive_delegation !== input.requestedRecursiveDelegation ||
    receipt.resolved_recursive_delegation !== input.resolvedRecursiveDelegation ||
    receipt.delegate_tool_active !== expectedActive
  ) return undefined;
  return receipt as unknown as RecursiveDelegationReceipt;
}

function systemSkillActivationReceiptFromLine(
  line: string,
  source: ResolvedSystemSkillSource | null,
): SystemSkillActivationReceipt | undefined {
  if (!source) return undefined;
  try {
    const event = JSON.parse(line) as { type?: unknown; receipt?: unknown };
    if (event.type !== "subagent007.system_skill_activation_confirmed") return undefined;
    return validatedSystemSkillActivationReceipt({
      value: event.receipt,
      expectedName: source.name,
      expectedPath: source.path,
    });
  } catch {
    return undefined;
  }
}

function recursiveDelegationReceiptFromLine(
  line: string,
  resolved: ResolvedRunSubagentRequest,
): RecursiveDelegationReceipt | undefined {
  try {
    const event = JSON.parse(line) as { type?: unknown; receipt?: unknown };
    if (event.type !== "subagent007.recursive_delegation_confirmed") return undefined;
    return validatedRecursiveDelegationReceipt({
      value: event.receipt,
      requestedRecursiveDelegation: resolved.requestedRecursiveDelegation,
      resolvedRecursiveDelegation: resolved.recursiveDelegation,
    });
  } catch { return undefined; }
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
    onTerminalOutputsPrepared?: (ownership: PendingTerminalOutputs) => void | Promise<void>;
    onChildSpawned?: (occurredAt: string) => void | Promise<void>;
    onActivationConfirmed?: (receipt: ActivationReceipt) => void | Promise<void>;
    onSkillSnapshotActivationConfirmed?: (receipt: SkillSnapshotActivationReceipt) => void | Promise<void>;
    onRecursiveDelegationConfirmed?: (receipt: RecursiveDelegationReceipt) => void | Promise<void>;
    onSystemSkillActivationConfirmed?: (receipt: SystemSkillActivationReceipt) => void | Promise<void>;
    /**
     * The durable-run owner receives this once, after all mutable preflights
     * and immediately before the child request is written.  It persists the
     * exact expectations that later receipts must satisfy.
     */
    onOwnerLaunchObservation?: (observation: {
      authoringEffectScope?: CapturedAuthoringEffectScope;
      requestedEffectProfile?: ResolvedRunSubagentRequest["effectProfile"];
      expectedSkillSha256?: string;
      skillBinding: ActivationSkillBinding | null;
      expectedToolBindings: readonly ActivationToolBinding[];
      skillSnapshotBinding?: SkillSnapshotLaunchBinding;
      skillSnapshotActivationReceipt?: SkillSnapshotActivationReceipt;
      requestedRecursiveDelegation: ResolvedRunSubagentRequest["requestedRecursiveDelegation"];
      resolvedRecursiveDelegation: ResolvedRunSubagentRequest["recursiveDelegation"];
      systemSkillName?: string;
      systemSkillPath?: string;
      specialistCatalogueScope?: SpecialistCatalogueScope;
      governingModelClass?: ModelClass;
    }) => void | Promise<void>;
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
  const snapshotActivation = await assertSkillSnapshotBinding(resolved);
  const systemSkillSource = await resolveSystemSkillSourceForRequest(resolved);
  const skillFilePath = snapshotActivation?.receipt.resolved_skill_path ?? options.skillFilePath ?? resolveSkillFilePathForRequest(resolved);
  let skillAudit: Awaited<ReturnType<typeof resolvedSkillAuditMetadata>>;
  try {
    skillAudit = await resolvedSkillAuditMetadata(resolved, skillFilePath);
  } catch (error) {
    if (resolved.expectedSkillSha256 || resolved.effectProfile) {
      throw launchSkillContentError(error);
    }
    throw error instanceof SkillBindingVerificationError && error.cause
      ? error.cause
      : error;
  }
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
  const strictPreparedOutputs: PreparedRunOutput[] = [];
  let strictOwnershipAccepted = false;
  try {
    const childEntrypoint = await assertPiChildEntrypointAvailable();
    const boundedActivation = await expectedBoundedActivationToolBindings({
      resolved,
      snapshotActivation,
      childEntrypoint,
    });
    let taskRootReadOnlyBindings: ActivationToolBinding[] | undefined;
    if (resolved.effectProfile === "task_root_read_only_v1") {
      try {
        taskRootReadOnlyBindings = await taskRootReadOnlyActivationBindings(
          fileURLToPath(import.meta.url),
          resolved.cwd,
        );
      } catch (error) {
        throw new ValidationError(
          `task_root_read_only_v1 could not bind its path guard: ${error instanceof Error ? error.message : String(error)}`,
          "effect_profile_activation_failed",
        );
      }
    }
    const expectedActivationToolBindings = taskRootReadOnlyBindings ?? boundedActivation?.toolBindings;
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
    // Capture only at the launch seam.  A queued run therefore binds the
    // tree that exists when it actually receives capacity, rather than an
    // earlier stale pre-admission observation.
    const authoringEffectScope = await captureAuthoringEffectScopeForRequest(resolved);
    await options.onOwnerLaunchObservation?.({
      ...(authoringEffectScope ? { authoringEffectScope } : {}),
      ...(resolved.effectProfile ? { requestedEffectProfile: resolved.effectProfile } : {}),
      ...(resolved.expectedSkillSha256 ? { expectedSkillSha256: resolved.expectedSkillSha256 } : {}),
      skillBinding,
      expectedToolBindings: expectedActivationToolBindings ?? [],
      ...(resolved.skillSnapshotBinding ? { skillSnapshotBinding: resolved.skillSnapshotBinding } : {}),
      ...(snapshotActivation ? { skillSnapshotActivationReceipt: snapshotActivation.receipt } : {}),
      requestedRecursiveDelegation: resolved.requestedRecursiveDelegation,
      resolvedRecursiveDelegation: resolved.recursiveDelegation,
      ...(systemSkillSource ? {
        systemSkillName: systemSkillSource.name,
        systemSkillPath: systemSkillSource.path,
        ...(resolved.specialistCatalogueScope
          ? { specialistCatalogueScope: resolved.specialistCatalogueScope }
          : {}),
        governingModelClass: resolved.modelClass,
      } : {}),
    });
    const childSkillFilePath = resolved.skill
      ? snapshotActivation?.receipt.resolved_skill_path ?? skillAudit.resolvedSkillPath ?? skillFilePath
      : undefined;
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
      ...(resolved.recursiveDelegation === "enabled"
        ? {
            recursiveControl: recursiveControlConfigForChild({
              runId,
              rootRunId: options.rootRunId,
              recursionDepth: options.recursionDepth,
              systemSkillName: systemSkillSource?.name,
              specialistCatalogueScope: resolved.specialistCatalogueScope,
              governingModelClass: systemSkillSource ? resolved.modelClass : undefined,
            }),
          }
        : {}),
      recursiveDelegation: resolved.recursiveDelegation,
      requestedRecursiveDelegation: request.recursive_delegation ?? null,
      ...(resolved.effectProfile ? { effectProfile: resolved.effectProfile } : {}),
      ...(resolved.expectedSkillSha256 ? { expectedSkillSha256: resolved.expectedSkillSha256 } : {}),
      ...((resolved.effectProfile || resolved.expectedSkillSha256) && skillBinding
        ? { skillBinding }
        : {}),
      ...(expectedActivationToolBindings
        ? { expectedActivationToolBindings: [...expectedActivationToolBindings] }
        : {}),
      ...(boundedActivation ? { controllerPython: boundedActivation.controllerPython } : {}),
      ...(resolved.skillSnapshotBinding ? { skillSnapshotBinding: resolved.skillSnapshotBinding } : {}),
      ...(snapshotActivation
        ? { expectedSkillSnapshotActivationReceipt: snapshotActivation.receipt }
        : {}),
      ...(authoringEffectScope
        ? { expectedEffectScopeBinding: authoringEffectScope.binding }
        : {}),
      ...(systemSkillSource ? {
        systemSkill: systemSkillSource.name,
        expectedSystemSkillPath: systemSkillSource.path,
        ...(resolved.specialistCatalogueScope
          ? { specialistCatalogueScope: resolved.specialistCatalogueScope }
          : {}),
      } : {}),
    };
    childRequest = await writeChildRequestFile(childPayload);
    if (boundedActivation) {
      try {
        await assertResolvedBoundedControllerPython(boundedActivation.controllerPython, boundedActivation.effectProfile);
      } catch (error) {
        throw new ValidationError(
          `bounded controller interpreter changed before child launch: ${error instanceof Error ? error.message : String(error)}`,
          "effect_profile_activation_failed",
        );
      }
    }
    let parsedSessionId: string | null = null;
    let childFailure: ChildFailureMetadata = {};
    let activationReceipt: ActivationReceipt | undefined;
    let skillSnapshotActivationReceipt: SkillSnapshotActivationReceipt | undefined;
    let recursiveDelegationReceipt: RecursiveDelegationReceipt | undefined;
    let systemSkillActivationReceipt: SystemSkillActivationReceipt | undefined;
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
        const lineActivationReceipt = activationReceiptFromLine({
          line,
          resolved,
          skillBinding,
          expectedToolBindings: expectedActivationToolBindings,
          expectedEffectScopeBinding: authoringEffectScope?.binding,
        });
        if (!activationReceipt && lineActivationReceipt) {
          activationReceipt = lineActivationReceipt;
          await options.onActivationConfirmed?.(lineActivationReceipt);
        }
        const lineSnapshotReceipt = skillSnapshotActivationReceiptFromLine(
          line,
          snapshotActivation?.receipt ?? null,
          resolved.skillSnapshotBinding,
        );
        if (!skillSnapshotActivationReceipt && lineSnapshotReceipt) {
          skillSnapshotActivationReceipt = lineSnapshotReceipt;
          await options.onSkillSnapshotActivationConfirmed?.(lineSnapshotReceipt);
        }
        const lineRecursiveReceipt = recursiveDelegationReceiptFromLine(line, resolved);
        if (!recursiveDelegationReceipt && lineRecursiveReceipt) {
          recursiveDelegationReceipt = lineRecursiveReceipt;
          await options.onRecursiveDelegationConfirmed?.(lineRecursiveReceipt);
        }
        const lineSystemSkillReceipt = systemSkillActivationReceiptFromLine(line, systemSkillSource);
        if (!systemSkillActivationReceipt && lineSystemSkillReceipt) {
          systemSkillActivationReceipt = lineSystemSkillReceipt;
          await options.onSystemSkillActivationConfirmed?.(lineSystemSkillReceipt);
        }
        const lineFailure = childFailureMetadataFromLine(line);
        if (lineFailure.reasonCode || lineFailure.usageLimitMetadata) {
          childFailure = lineFailure;
        }
        const accepted = inputResponseAcceptedFromLine(line);
        if (accepted?.runId === runId) {
          options.onInputResponseAccepted?.(accepted);
        }
        await options.onOutputLine?.(line);
      },
    });
    let terminalEffectScopeError: ValidationError | undefined;
    let strictResearchOutput: Awaited<ReturnType<typeof materializeResearchControllerCompletion>>;
    if (authoringEffectScope) {
      try {
        await assertAuthoringEffectScopeTerminal(authoringEffectScope);
        if (snapshotActivation) {
          const terminalSnapshot = await assertSkillSnapshotBinding(resolved);
          if (!terminalSnapshot || JSON.stringify(terminalSnapshot.receipt) !== JSON.stringify(snapshotActivation.receipt)) {
            throw new Error("immutable skill snapshot identity changed before terminalization");
          }
        }
      } catch (error) {
        terminalEffectScopeError = error instanceof ValidationError && error.reasonCode === "authoring_effect_scope_drift"
          ? error
          : new ValidationError(
              `authoring effect scope terminal reinspection failed: ${error instanceof Error ? error.message : String(error)}`,
              "authoring_effect_scope_drift",
            );
      }
    }
    if (
      !terminalEffectScopeError &&
      resolved.effectProfile === "researcher_bounded_v1" &&
      activationReceipt?.schema_version === 4 &&
      boundedActivation &&
      authoringEffectScope
    ) {
      strictResearchOutput = await materializeResearchControllerCompletion({
        taskRoot: resolved.cwd,
        scriptPath: boundedActivation.scriptPath,
        controllerPython: boundedActivation.controllerPython,
        effectScopeBinding: authoringEffectScope.binding,
      });
    }
    const finalMessage = await readFinalMessage(finalMessageTarget.outputLastMessagePath);
    const writtenOutputMode: OutputMode = strictResearchOutput || finalMessage ? "final" : "transcript";
    let output: StoredRunOutput;
    let packetOutput: StoredRunOutput | undefined;
    if (strictResearchOutput) {
      if (!options.onTerminalOutputsPrepared) {
        throw new Error("strict Researcher output requires durable terminal-output ownership");
      }
      const primaryPrepared = await prepareRunOutput(
        strictResearchOutput.primaryMarkdown,
        "primary",
        options.runsDir,
      );
      strictPreparedOutputs.push(primaryPrepared);
      const packetPrepared = await prepareRunOutput(
        strictResearchOutput.packetMarkdown,
        "packet",
        options.runsDir,
      );
      strictPreparedOutputs.push(packetPrepared);
      const strictPendingOwnership = pendingTerminalOutputs(
        runId,
        primaryPrepared.ownership,
        packetPrepared.ownership,
      );
      if (
        primaryPrepared.ownership.content_sha256 !== strictResearchOutput.receipt.primary_sha256 ||
        packetPrepared.ownership.content_sha256 !== strictResearchOutput.receipt.packet_sha256
      ) {
        throw new Error("strict Researcher prepared bytes do not match the controller receipt");
      }
      await options.onTerminalOutputsPrepared(strictPendingOwnership);
      strictOwnershipAccepted = true;
      output = await primaryPrepared.publish();
      packetOutput = await packetPrepared.publish();
    } else {
      output = finalMessage
        ? await writeRunOutput(finalMessage, options.runsDir)
        : await transcript.finalize();
    }
    const strictResearchOutputsMatch = !strictResearchOutput || (
      output.reference.content_sha256 === strictResearchOutput.receipt.primary_sha256 &&
      packetOutput?.reference.content_sha256 === strictResearchOutput.receipt.packet_sha256
    );
    const controllerTerminalReceipt =
      strictResearchOutput && strictResearchOutputsMatch
        ? strictResearchOutput.receipt
        : undefined;
    if (strictResearchOutput || finalMessage) {
      await transcript.discard();
    }
    const processSuccess =
      processResult.exitCode === 0 &&
      !processResult.timedOut &&
      !processResult.cancelled &&
      !processResult.resourceExhausted;
    const activationRequired = Boolean(resolved.effectProfile || resolved.expectedSkillSha256);
    const activationConfirmed = !activationRequired || activationReceipt !== undefined;
    const skillSnapshotActivationConfirmed = !resolved.skillSnapshotBinding || skillSnapshotActivationReceipt !== undefined;
    const recursiveDelegationConfirmed = recursiveDelegationReceipt !== undefined;
    const systemSkillActivationConfirmed = !systemSkillSource || systemSkillActivationReceipt !== undefined;
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
    const missingFinalOutput = processSuccess && resolved.outputMode === "final" &&
      (resolved.effectProfile === "researcher_bounded_v1" ? !strictResearchOutput : !finalMessage);
    const controllerCompletionConfirmed =
      resolved.effectProfile !== "researcher_bounded_v1" ||
      (strictResearchOutput !== undefined && strictResearchOutputsMatch);
    const success =
      processSuccess && !terminalEffectScopeError && activationConfirmed && skillSnapshotActivationConfirmed &&
      recursiveDelegationConfirmed && systemSkillActivationConfirmed && controllerCompletionConfirmed && !missingFinalOutput &&
      (sessionMode.kind !== "fresh" || sessionEstablished);
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
      output_references: [
        { ...output.reference, output_mode: writtenOutputMode },
        ...(packetOutput
          ? [{ ...packetOutput.reference, name: "packet" as const, output_mode: "final" as const }]
          : []),
      ],
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
      size_bytes: output.reference.size_bytes,
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
      ...(controllerTerminalReceipt
        ? { controller_terminal_receipt: controllerTerminalReceipt }
        : {}),
      ...(resolved.skillSnapshotBinding ? { skill_snapshot_binding: resolved.skillSnapshotBinding } : {}),
      ...(skillSnapshotActivationReceipt
        ? { skill_snapshot_activation_receipt: skillSnapshotActivationReceipt }
        : {}),
      ...(request.recursive_delegation ? { requested_recursive_delegation: request.recursive_delegation } : {}),
      resolved_recursive_delegation: resolved.recursiveDelegation,
      ...(recursiveDelegationReceipt ? { recursive_delegation_receipt: recursiveDelegationReceipt } : {}),
      ...(systemSkillSource ? { requested_system_skill: systemSkillSource.name } : {}),
      ...(resolved.specialistCatalogueScope
        ? { requested_specialist_catalogue_scope: resolved.specialistCatalogueScope }
        : {}),
      ...(systemSkillActivationReceipt ? { system_skill_activation_receipt: systemSkillActivationReceipt } : {}),
      requested_output_mode: resolved.outputMode,
      written_output_mode: writtenOutputMode,
      stop_reason: processResult.stopReason,
      stop_signal: processResult.stopSignal,
      ...(terminalEffectScopeError ? {
        error_class: "authoring_effect_scope_drift",
        reason_code: "authoring_effect_scope_drift" as const,
      } : runErrorTaxonomy({
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
        activationFailed: !activationConfirmed || !skillSnapshotActivationConfirmed || !recursiveDelegationConfirmed || !systemSkillActivationConfirmed,
        childFailureReasonCode: childFailure.reasonCode ?? (
          !skillSnapshotActivationConfirmed
            ? "skill_snapshot_activation_failed"
            : !recursiveDelegationConfirmed
            ? "recursive_delegation_activation_failed"
            : !systemSkillActivationConfirmed
            ? "system_skill_activation_failed"
            : !activationConfirmed
            ? resolved.effectProfile
              ? "effect_profile_activation_failed"
              : "skill_content_mismatch"
            : undefined
        ),
      })),
      ...(childFailure.usageLimitMetadata ?? {}),
      ...(timeoutRecoveryHint ? { timeout_recovery_hint: timeoutRecoveryHint } : {}),
      session_id: sessionId,
      session_established: sessionEstablished,
      input_requests_dir: inputRequestsDir,
    };
    if (!terminalProjectionIsValid({
      requestedEffectProfile: resolved.effectProfile,
      activationClass: resolved.effectProfile === "researcher_bounded_v1" &&
          activationReceipt?.schema_version === 4
        ? "researcher_v4_strict"
        : "other",
      status: result.status as TerminalProjectionInput["status"],
      outputReferences: result.output_references,
      controllerTerminalReceipt: result.controller_terminal_receipt,
    })) {
      throw new Error(
        "terminal output projection is inconsistent with its validated activation and controller receipt",
      );
    }
    return result;
  } finally {
    if (!strictOwnershipAccepted && strictPreparedOutputs.length > 0) {
      for (const prepared of strictPreparedOutputs) {
        try {
          await prepared.discard();
        } catch {}
      }
    }
    await finalMessageTarget.cleanup();
    await childRequest?.cleanup();
    // An unsettled .partial transcript is intentionally retained for crash/failure recovery.
    await transcript?.preservePartial().catch(() => {
      // Preserve the original run failure when the filesystem cannot even close the partial artifact.
    });
  }
}
