import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  failureClassForProcessResult,
  failureReasonCodeForError,
  logFailure,
  type FailureClass,
  type FailureLogTool,
  type FailureReasonCode,
} from "./failureLog.js";
import {
  DURABLE_RUN_CONTRACT_NAME,
  DURABLE_RUN_CONTRACT_VERSION,
  TERMINAL_RUN_STATUSES,
  type DurableRunStatus,
} from "./durableRunContract.js";
import {
  closePendingInputRequestsForRun,
  defaultInputRequestsDir,
  listInputRequests,
  newRunId,
  removeTerminalInputRequestsForRun,
  settleInputResponse,
  validateInputResponse,
  type InputRequestView,
} from "./inputMailbox.js";
import {
  assertPiChildEntrypointAvailable,
  assertExpectedSkillBinding,
  assertSkillSnapshotBinding,
  expectedBoundedActivationToolBindings,
  runSubagentCore,
  resolveSkillFilePathForRequest,
  RUN_SUBAGENT_TIMEOUT_RECOVERY_HINT,
  validatedRecursiveDelegationReceipt,
} from "./runSubagent.js";
import {
  validatedSkillSnapshotActivationReceipt,
  validatedSkillSnapshotLaunchBinding,
} from "./skillSnapshot.js";
import {
  isBoundedEffectProfile,
  validatedActivationReceipt,
  validatedProjectedActivationReceipt,
} from "./toolProfile.js";
import {
  assertAuthoringEffectScopeBinding,
  type CapturedAuthoringEffectScope,
} from "./authoringEffectScope.js";
import {
  runSubagentSession,
  validateRunSubagentSessionRequestPreflight,
} from "./session.js";
import { DEFAULT_HEARTBEAT_MESSAGE, type HeartbeatNotify } from "./progress.js";
import { PUBLIC_PROMPT_REDACTED_MARKER, serverContractPacketMarker, serverContractSkillMarker } from "./prompt.js";
import { skillBindingForPublicMarker } from "./skillBinding.js";
import {
  appendRunPublicEvent,
  publicOutputExcerptProjection,
  readRunPublicEvents,
  recentEventsProjection,
  removeRunPublicEvents,
  terminalEventsProjection,
} from "./runEvents.js";
import { publicOutputLineFromProcessLine } from "./transcript.js";
import {
  terminalRunTaskEventDetails,
  terminalRunTaskStatus,
  type RunTaskActivePhase,
  type RunTaskTerminalStatus,
} from "./runLifecycle.js";
import type {
  RecursiveDelegationReceipt,
  RunPublicEvent,
  RunPublicEventName,
  RunSubagentPromotion,
  RunSubagentRequest,
  RunSubagentResult,
  RunSubagentSessionRequest,
  RunSubagentSessionResult,
  StartRunTaskRequest,
} from "./types.js";
import {
  MODEL_CLASSES,
  OUTPUT_MODES,
  PACKET_PARSE_STATUSES,
  EFFECT_PROFILES,
  RECURSIVE_DELEGATIONS,
  RESUME_MODES,
  RUN_STOP_REASONS,
  SESSION_PACKET_POLICIES,
  ValidationError,
} from "./types.js";
import { loadConfig } from "./config.js";
import {
  assertDeadlineRiskTimeoutBudget,
  runSubagentOneShotIncompatibility,
  type RunSubagentOneShotIncompatibility,
  validateAndResolveRequest,
} from "./validate.js";
import { defaultSubagentStatePath, recoverStreamingRunTranscript, runOutputReference } from "./output.js";
import { assertModelClassUsableForOneShot } from "./modelHealth.js";
import { safeIntegerFromEnv } from "./env.js";
import {
  acquireActiveChildLease,
  activeChildLeaseLiveness,
  admitActiveChild,
  hasLiveQueuedRunTicket,
  type ActiveChildAdmission,
  type ActiveChildLease,
} from "./activeChildLease.js";
import { assertDiskReserveAvailable } from "./diskReserve.js";
import { processIsDefinitelyGone } from "./processLiveness.js";
import {
  canonicalClientStartRequestSha256,
  canonicalJson,
  clientStartAdmissionOwnerLiveness,
  claimClientStartAdmission,
  findClientStartAdmission,
  resolveClientStartAdmissionBinding,
  validatedClientStartRequestIdentity,
  type ClientStartAdmission,
  type ClientStartBinding,
} from "./clientStartAdmission.js";

type RunTaskStatus = DurableRunStatus;
const TERMINAL_RUN_STATUS_SET = new Set<RunTaskStatus>(TERMINAL_RUN_STATUSES);
const RUN_STOP_REASON_SET = new Set<string>(RUN_STOP_REASONS);
const MODEL_CLASS_SET = new Set<string>(MODEL_CLASSES);
const OUTPUT_MODE_SET = new Set<string>(OUTPUT_MODES);
const PACKET_PARSE_STATUS_SET = new Set<string>(PACKET_PARSE_STATUSES);
const RESUME_MODE_SET = new Set<string>(RESUME_MODES);
const SESSION_PACKET_POLICY_SET = new Set<string>(SESSION_PACKET_POLICIES);
const NONTERMINAL_RUN_PHASE_SET = new Set<RunTaskActivePhase>([
  "starting",
  "queued",
  "awaiting_child_event",
  "running_silent",
  "running",
  "input_required",
  "cancelling",
]);
const EFFECT_PROFILE_SET = new Set<string>(EFFECT_PROFILES);
const RECURSIVE_DELEGATION_SET = new Set<string>(RECURSIVE_DELEGATIONS);
const OWNER_SETTLEMENT_EVENT_SET = new Set<string>(["failed", "cancellation_settled", "completed", "timeout"]);

type RunTaskTerminalResult = RunSubagentResult | RunSubagentSessionResult;
type ChildLifecycleEventName = Extract<
  RunPublicEventName,
  "child_spawned" | "child_bridge_started" | "child_session_established" | "activation_confirmed" | "skill_snapshot_activation_confirmed" | "recursive_delegation_confirmed" | "child_prompt_submitted"
>;
type StandardChildLifecycleEventName = Exclude<ChildLifecycleEventName, "activation_confirmed" | "skill_snapshot_activation_confirmed" | "recursive_delegation_confirmed">;
type RunTaskFailureLogTool = Extract<
  FailureLogTool,
  "run_subagent" | "schedule_run" | "start_run" | "start_session_run" | "run_subagent_session"
>;

export interface RunTaskView extends Partial<RunSubagentResult>, Partial<RunSubagentSessionResult> {
  run_id: string;
  task_id: string;
  contract_name: typeof DURABLE_RUN_CONTRACT_NAME;
  contract_version: typeof DURABLE_RUN_CONTRACT_VERSION;
  task_kind?: "run" | "session";
  parent_run_id?: string;
  root_run_id: string;
  recursion_depth: number;
  child_run_ids: string[];
  descendant_run_ids: string[];
  descendant_terminal_statuses: Record<string, RunTaskTerminalStatus>;
  status: DurableRunStatus;
  started_at: string;
  finished_at?: string;
  input_requests_dir: string;
  input_requests: InputRequestView[];
  elapsed_ms?: number;
  last_progress_at?: string;
  last_progress_message?: string;
  heartbeat_count?: number;
  active_phase?: RunTaskActivePhase;
  last_phase_at?: string;
  last_child_lifecycle_event?: ChildLifecycleEventName;
  last_child_lifecycle_at?: string;
  first_public_output_at?: string;
  no_public_output_elapsed_ms?: number;
  recent_events?: RunPublicEvent[];
  last_public_output_excerpt?: string;
  requested_wait_ms?: number;
  effective_wait_ms?: number;
  wait_truncated?: boolean;
  error?: string;
  error_class?: string;
  reason_code?: FailureReasonCode;
  partial_output_path?: string;
  child_started?: boolean;
  queued_at?: string;
  child_started_at?: string;
  queue_wait_ms?: number;
  client_start_binding?: ClientStartBinding;
}

export interface RunTaskLineage {
  parentRunId?: string;
  rootRunId?: string;
  recursionDepth?: number;
}

export type RecursiveCallerLineage = Required<RunTaskLineage>;

interface RunTaskState {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  mailboxRoot: string;
  inputRequestsDir: string;
  terminalInputRequests?: InputRequestView[];
  abortController: AbortController;
  taskKind: "run" | "session";
  result?: RunTaskTerminalResult;
  error?: Error;
  cancelRequested: boolean;
  heartbeatCount: number;
  lastProgressAt?: string;
  lastProgressMessage?: string;
  activePhase: RunTaskActivePhase;
  lastPhaseAt: string;
  lastChildLifecycleEvent?: ChildLifecycleEventName;
  lastChildLifecycleAt?: string;
  firstPublicOutputAt?: string;
  recentEvents: RunPublicEvent[];
  lastPublicOutputExcerpt?: string;
  promise: Promise<void>;
  terminalSnapshotStarted: boolean;
  cwd?: string;
  failureLogTool?: RunTaskFailureLogTool;
  sessionKey?: string;
  promotion?: RunSubagentPromotion;
  parentRunId?: string;
  rootRunId: string;
  recursionDepth: number;
  childRunIds: string[];
  descendantRunIds: string[];
  descendantTerminalStatuses: Record<string, RunTaskTerminalStatus>;
  childControlSend?: (message: string) => boolean;
  acceptedInputResponses: Map<string, AcceptedInputResponse>;
  pendingInputDeliveries: Map<string, PendingInputDelivery>;
  inputMutationQueue: Promise<void>;
  terminalizing: boolean;
  partialOutputPath?: string;
  childStarted: boolean;
  queuedAt?: string;
  childStartedAt?: string;
  capacityReleased: boolean;
  clientStartBinding?: ClientStartBinding;
  requestedEffectProfile?: RunSubagentRequest["effect_profile"];
  activationReceipt?: RunSubagentResult["activation_receipt"];
  skillSnapshotBinding?: RunSubagentResult["skill_snapshot_binding"];
  skillSnapshotActivationReceipt?: RunSubagentResult["skill_snapshot_activation_receipt"];
  skillSnapshotActivationObservation: {
    promise: Promise<RunSubagentResult["skill_snapshot_activation_receipt"] | undefined>;
    resolve: (receipt: RunSubagentResult["skill_snapshot_activation_receipt"] | undefined) => void;
  };
  recursiveDelegationReceipt?: RecursiveDelegationReceipt;
  requestedRecursiveDelegation?: RunSubagentRequest["recursive_delegation"];
  expectedSkillSha256?: string;
  ownerRecordAdmission?: RunOwnerRecordAdmission;
  ownerLaunchObservation?: RunOwnerLaunchObservation;
}

interface PendingInputDelivery {
  responseId: string;
  answer: string;
  receipt: string;
  completion: Promise<AnswerRunTaskInputResult>;
  resolve: (result: AnswerRunTaskInputResult) => void;
  reject: (error: Error) => void;
}

interface AcceptedInputResponse {
  responseId: string;
  answerSha256: string;
  receipt: string;
}

type RunTaskProgressView = Pick<
  RunTaskView,
  | "elapsed_ms"
  | "last_progress_at"
  | "last_progress_message"
  | "heartbeat_count"
  | "active_phase"
  | "last_phase_at"
  | "last_child_lifecycle_event"
  | "last_child_lifecycle_at"
  | "first_public_output_at"
  | "no_public_output_elapsed_ms"
  | "recent_events"
  | "last_public_output_excerpt"
>;

const tasks = new Map<string, RunTaskState>();
const restartDriftReconciliations = new Map<string, Promise<RunTaskView>>();
const ownerRecordWriteChains = new Map<string, Promise<void>>();
const DEFAULT_SCHEDULE_WAIT_MS = 1_000;
const DEFAULT_SCHEDULE_MAX_WAIT_MS = 30_000;
const SCHEDULE_MAX_WAIT_ENV = "SUBAGENT007_SCHEDULE_RUN_MAX_WAIT_MS";
const PROMOTED_RUN_WAIT_MS = DEFAULT_SCHEDULE_WAIT_MS;

function defaultRunTasksDir(): string {
  return defaultSubagentStatePath("SUBAGENT007_RUN_TASKS_DIR", "run-tasks");
}

function taskRecordPath(runId: string): string {
  return path.join(defaultRunTasksDir(), `${runId}.json`);
}

const RUN_OWNER_RECORD_NAME = "subagent007.run_owner_record" as const;
const RUN_OWNER_RECORD_VERSION = 1 as const;
const RUN_OWNER_RECORD_REQUEST_DOMAIN = "subagent007.run_owner_record.request.v1\n";
const RUN_OWNER_RECORD_PROMPT_DOMAIN = "subagent007.run_owner_record.prompt.v1\n";
const RUN_OWNER_RECORD_SCOPE_DOMAIN = "subagent007.run_owner_record.effect_scope.v1\n";
const LIVE_INPUT_RESPONSE_DOMAIN = "subagent007.live_input_response.v1\n";

interface RunOwnerRecordAdmission {
  run_id: string;
  task_kind: "run" | "session";
  request_bytes: string;
  request_sha256: string;
  declarations: OwnerRequestDeclarations;
}

interface RunOwnerLaunchObservation {
  effect_scope_binding_bytes?: string;
  effect_scope_binding_sha256?: string;
  activation_expectation: {
    requested_effect_profile: RunSubagentRequest["effect_profile"] | null;
    expected_skill_sha256: string | null;
    skill_binding: unknown;
    tool_bindings: unknown[];
    skill_snapshot_binding: unknown;
    skill_snapshot_activation_receipt: unknown;
    requested_recursive_delegation: "disabled" | "enabled" | null;
    resolved_recursive_delegation: "disabled" | "enabled";
  };
  queue: {
    queued_at: string | null;
    child_started_at: string | null;
    queue_wait_ms: number | null;
  };
}

interface RunOwnerSettlement {
  status: RunTaskTerminalStatus;
  event: RunPublicEvent;
  occurred_at: string;
}

interface RunOwnerRecordV1 {
  record_name: typeof RUN_OWNER_RECORD_NAME;
  record_version: typeof RUN_OWNER_RECORD_VERSION;
  revision: number;
  immutable_admission: RunOwnerRecordAdmission;
  launch_observation?: RunOwnerLaunchObservation;
  settlement?: RunOwnerSettlement;
  public_view: RunTaskView;
}

function canonicalOwnerJson(value: unknown): string {
  const bytes = canonicalJson(value);
  if (bytes === undefined) throw new Error("owner record canonical JSON rejects unsupported values");
  return bytes;
}

function ownerRecordDigest(domain: string, canonicalBytes: string): string {
  return createHash("sha256").update(domain).update(canonicalBytes).digest("hex");
}

function inputAnswerSha256(answer: string): string {
  return ownerRecordDigest(LIVE_INPUT_RESPONSE_DOMAIN, answer);
}

function sameCanonicalOwnerJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalOwnerJson(left) === canonicalOwnerJson(right);
  } catch {
    return false;
  }
}

function ownerRequestDeclarationsFromRequest(
  request: RunSubagentRequest | RunSubagentSessionRequest,
): OwnerRequestDeclarations {
  if ("session_key" in request) {
    return { requestedRecursiveDelegation: null };
  }
  return {
    ...(request.effect_profile ? { effectProfile: request.effect_profile } : {}),
    ...(request.expected_skill_sha256 ? { expectedSkillSha256: request.expected_skill_sha256 } : {}),
    ...(request.skill_snapshot_binding ? { skillSnapshotBinding: request.skill_snapshot_binding } : {}),
    requestedRecursiveDelegation: request.recursive_delegation ?? null,
  };
}

/**
 * The owner needs a stable admission identity for exact comparison, but the
 * durable record is not a prompt archive.  Keep all non-secret request facts
 * in canonical form and bind the prompt with a domain-separated digest.
 */
function ownerRecordRequestIdentity(
  state: RunTaskState,
  request: RunSubagentRequest | RunSubagentSessionRequest,
): unknown {
  const identity = state.clientStartBinding
    ? validatedClientStartRequestIdentity(request as StartRunTaskRequest)
    : request;
  const value = identity as Record<string, unknown>;
  const prompt = value.prompt;
  if (typeof prompt !== "string") {
    throw new ValidationError("run owner admission requires a prompt string", "run_liveness_unknown");
  }
  const { prompt: _prompt, ...nonSecretRequest } = value;
  return {
    ...nonSecretRequest,
    prompt_sha256: ownerRecordDigest(
      RUN_OWNER_RECORD_PROMPT_DOMAIN,
      prompt,
    ),
  };
}

function ownerRecordAdmissionFor(
  state: RunTaskState,
  request: RunSubagentRequest | RunSubagentSessionRequest,
): RunOwnerRecordAdmission {
  const requestBytes = canonicalOwnerJson(ownerRecordRequestIdentity(state, request));
  return {
    run_id: state.runId,
    task_kind: state.taskKind,
    request_bytes: requestBytes,
    request_sha256: ownerRecordDigest(RUN_OWNER_RECORD_REQUEST_DOMAIN, requestBytes),
    declarations: ownerRequestDeclarationsFromRequest(request),
  };
}

function ensureOwnerRecordAdmission(
  state: RunTaskState,
  request: RunSubagentRequest | RunSubagentSessionRequest,
): void {
  const admission = ownerRecordAdmissionFor(state, request);
  if (state.ownerRecordAdmission && !sameCanonicalOwnerJson(state.ownerRecordAdmission, admission)) {
    throw new ValidationError("run owner admission changed after it was captured", "client_start_id_conflict");
  }
  state.ownerRecordAdmission = admission;
}

function exactRecordKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalidOwnerRecord(message: string): never {
  throw new ValidationError(message, "run_liveness_unknown");
}

function recordOwnerLaunchObservation(
  state: RunTaskState,
  observation: {
    authoringEffectScope?: CapturedAuthoringEffectScope;
    requestedEffectProfile?: RunSubagentRequest["effect_profile"];
    expectedSkillSha256?: string;
    skillBinding: unknown;
    expectedToolBindings: readonly unknown[];
    skillSnapshotBinding?: unknown;
    skillSnapshotActivationReceipt?: unknown;
    requestedRecursiveDelegation: "disabled" | "enabled" | null;
    resolvedRecursiveDelegation: "disabled" | "enabled";
  },
): void {
  const scopeBytes = observation.authoringEffectScope
    ? canonicalOwnerJson(observation.authoringEffectScope.binding)
    : undefined;
  state.ownerLaunchObservation = {
    ...(scopeBytes ? {
      effect_scope_binding_bytes: scopeBytes,
      effect_scope_binding_sha256: ownerRecordDigest(RUN_OWNER_RECORD_SCOPE_DOMAIN, scopeBytes),
    } : {}),
    activation_expectation: {
      requested_effect_profile: observation.requestedEffectProfile ?? null,
      expected_skill_sha256: observation.expectedSkillSha256 ?? null,
      skill_binding: observation.skillBinding,
      tool_bindings: [...observation.expectedToolBindings],
      skill_snapshot_binding: observation.skillSnapshotBinding ?? null,
      skill_snapshot_activation_receipt: observation.skillSnapshotActivationReceipt ?? null,
      requested_recursive_delegation: observation.requestedRecursiveDelegation,
      resolved_recursive_delegation: observation.resolvedRecursiveDelegation,
    },
    queue: {
      queued_at: state.queuedAt ?? null,
      child_started_at: state.childStartedAt ?? null,
      queue_wait_ms: state.queuedAt && state.childStartedAt
        ? Date.parse(state.childStartedAt) - Date.parse(state.queuedAt)
        : null,
    },
  };
}

function settlementForSnapshot(snapshot: RunTaskView): RunOwnerSettlement {
  const terminalEvents = (snapshot.recent_events ?? []).filter((event) => event.kind === "terminal" &&
    OWNER_SETTLEMENT_EVENT_SET.has(event.event ?? ""));
  const event = terminalEvents[0];
  if (!event || terminalEvents.length !== 1 || !isTerminalRunStatus(snapshot.status) || !isFiniteTimestamp(snapshot.finished_at) ||
    event.occurred_at !== snapshot.finished_at) {
    throw new Error("terminal owner record requires an exact settlement projection");
  }
  return {
    status: snapshot.status as RunTaskTerminalStatus,
    event,
    occurred_at: snapshot.finished_at,
  };
}

function assertRunOwnerRecord(record: RunOwnerRecordV1): void {
  const value = record as unknown as Record<string, unknown>;
  if (!exactRecordKeys(value, [
    "record_name", "record_version", "revision", "immutable_admission", "launch_observation", "settlement", "public_view",
  ].filter((key) => value[key] !== undefined))) {
    invalidOwnerRecord("run owner record has unexpected keys");
  }
  if (record.record_name !== RUN_OWNER_RECORD_NAME || record.record_version !== RUN_OWNER_RECORD_VERSION ||
    !Number.isSafeInteger(record.revision) || record.revision < 1) {
    invalidOwnerRecord("run owner record has an invalid version or revision");
  }
  const admission = record.immutable_admission;
  if (!admission || !exactRecordKeys(admission as unknown as Record<string, unknown>, [
    "run_id", "task_kind", "request_bytes", "request_sha256", "declarations",
  ]) || !isNonemptyString(admission.run_id) || (admission.task_kind !== "run" && admission.task_kind !== "session") ||
    !isNonemptyString(admission.request_bytes) || !/^[0-9a-f]{64}$/.test(admission.request_sha256) ||
    ownerRecordDigest(RUN_OWNER_RECORD_REQUEST_DOMAIN, admission.request_bytes) !== admission.request_sha256) {
    invalidOwnerRecord("run owner record has an invalid immutable admission");
  }
  try {
    if (canonicalOwnerJson(JSON.parse(admission.request_bytes)) !== admission.request_bytes) {
      invalidOwnerRecord("run owner record request bytes are not canonical");
    }
  } catch {
    invalidOwnerRecord("run owner record request bytes are unreadable");
  }
  if (record.public_view.run_id !== admission.run_id || record.public_view.task_id !== admission.run_id ||
    record.public_view.task_kind !== admission.task_kind ||
    !sameCanonicalOwnerJson(ownerRequestDeclarations(record.public_view), admission.declarations)) {
    invalidOwnerRecord("run owner record public view does not match immutable admission");
  }
  if (record.launch_observation) {
    const launch = record.launch_observation;
    if (!exactRecordKeys(launch as unknown as Record<string, unknown>, [
      "effect_scope_binding_bytes", "effect_scope_binding_sha256", "activation_expectation", "queue",
    ].filter((key) => (launch as unknown as Record<string, unknown>)[key] !== undefined)) ||
      !isRecord(launch.activation_expectation) || !isRecord(launch.queue)) {
      invalidOwnerRecord("run owner record launch observation is malformed");
    }
    if ((launch.effect_scope_binding_bytes === undefined) !== (launch.effect_scope_binding_sha256 === undefined)) {
      invalidOwnerRecord("run owner record effect scope binding is incomplete");
    }
    if (launch.effect_scope_binding_bytes !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(launch.effect_scope_binding_sha256 ?? "") ||
        ownerRecordDigest(RUN_OWNER_RECORD_SCOPE_DOMAIN, launch.effect_scope_binding_bytes) !== launch.effect_scope_binding_sha256) {
        invalidOwnerRecord("run owner record effect scope digest is invalid");
      }
      let expectedScope: unknown;
      try {
        expectedScope = JSON.parse(launch.effect_scope_binding_bytes);
        if (canonicalOwnerJson(expectedScope) !== launch.effect_scope_binding_bytes) throw new Error("noncanonical");
        assertAuthoringEffectScopeBinding(expectedScope as import("./types.js").AuthoringEffectScopeBinding);
      } catch {
        invalidOwnerRecord("run owner record effect scope binding is invalid");
      }
      const receipt = record.public_view.activation_receipt;
      const receiptScope = receipt && "effect_scope_binding" in receipt
        ? receipt.effect_scope_binding
        : undefined;
      if (receiptScope !== undefined && !sameCanonicalOwnerJson(receiptScope, expectedScope)) {
        invalidOwnerRecord("run owner record activation receipt does not match captured effect scope");
      }
    }
    const expectation = launch.activation_expectation as Record<string, unknown>;
    if (!exactRecordKeys(expectation, [
      "requested_effect_profile", "expected_skill_sha256", "skill_binding", "tool_bindings",
      "skill_snapshot_binding", "skill_snapshot_activation_receipt",
      "requested_recursive_delegation", "resolved_recursive_delegation",
    ]) ||
      expectation.requested_effect_profile !== (admission.declarations.effectProfile ?? null) ||
      expectation.expected_skill_sha256 !== (admission.declarations.expectedSkillSha256 ?? null) ||
      !sameCanonicalOwnerJson(expectation.skill_snapshot_binding, admission.declarations.skillSnapshotBinding ?? null) ||
      expectation.requested_recursive_delegation !== admission.declarations.requestedRecursiveDelegation ||
      !Array.isArray(expectation.tool_bindings) ||
      !["disabled", "enabled"].includes(String(expectation.resolved_recursive_delegation))) {
      invalidOwnerRecord("run owner record activation expectation does not match immutable admission");
    }
    const queue = launch.queue as Record<string, unknown>;
    if (!exactRecordKeys(queue, ["queued_at", "child_started_at", "queue_wait_ms"]) ||
      ![null, undefined].includes(queue.queued_at as null | undefined) && !isFiniteTimestamp(queue.queued_at) ||
      ![null, undefined].includes(queue.child_started_at as null | undefined) && !isFiniteTimestamp(queue.child_started_at) ||
      !(queue.queue_wait_ms === null || (typeof queue.queue_wait_ms === "number" && Number.isFinite(queue.queue_wait_ms) && queue.queue_wait_ms >= 0)) ||
      (queue.queued_at !== null && queue.child_started_at !== null &&
        (queue.queue_wait_ms !== Date.parse(queue.child_started_at as string) - Date.parse(queue.queued_at as string)))) {
      invalidOwnerRecord("run owner record queue observation is inconsistent");
    }
    const expectedScope = launch.effect_scope_binding_bytes
      ? JSON.parse(launch.effect_scope_binding_bytes)
      : undefined;
    const promptSubmitted = childPromptWasSubmitted(record.public_view);
    if (promptSubmitted) {
      const receipt = record.public_view.activation_receipt;
      if ((expectation.requested_effect_profile !== null || expectation.expected_skill_sha256 !== null) &&
        !validatedActivationReceipt({
          value: receipt,
          ...(expectation.requested_effect_profile !== null
            ? { effectProfile: expectation.requested_effect_profile as RunSubagentRequest["effect_profile"] }
            : {}),
          skillBinding: expectation.skill_binding as import("./types.js").ActivationSkillBinding | null,
          ...(expectation.expected_skill_sha256 !== null
            ? { expectedSkillSha256: expectation.expected_skill_sha256 as string }
            : {}),
          ...(isBoundedEffectProfile(expectation.requested_effect_profile as RunSubagentRequest["effect_profile"])
            ? { expectedToolBindings: expectation.tool_bindings as import("./types.js").ActivationToolBinding[] }
            : {}),
          ...(expectedScope ? { expectedEffectScopeBinding: expectedScope as import("./types.js").AuthoringEffectScopeBinding } : {}),
        })) {
        invalidOwnerRecord("run owner record activation receipt does not match retained launch expectations");
      }
      if (expectation.skill_snapshot_binding !== null &&
        (!record.public_view.skill_snapshot_activation_receipt ||
          validatedSkillSnapshotActivationReceipt({
            value: record.public_view.skill_snapshot_activation_receipt,
            binding: expectation.skill_snapshot_binding as import("./types.js").SkillSnapshotLaunchBinding,
          }) === undefined)) {
        invalidOwnerRecord("run owner record snapshot receipt does not match retained launch expectations");
      }
      if (!record.public_view.recursive_delegation_receipt ||
        record.public_view.resolved_recursive_delegation !== expectation.resolved_recursive_delegation ||
        validatedRecursiveDelegationReceipt({
          value: record.public_view.recursive_delegation_receipt,
          requestedRecursiveDelegation: expectation.requested_recursive_delegation as "disabled" | "enabled" | null,
          resolvedRecursiveDelegation: expectation.resolved_recursive_delegation as "disabled" | "enabled",
        }) === undefined) {
        invalidOwnerRecord("run owner record recursive receipt does not match retained launch expectations");
      }
    }
  }
  assertCurrentRunTaskSnapshot(record.public_view);
  if (record.settlement) {
    const projectedSettlement = settlementForSnapshot(record.public_view);
    if (!isTerminalRunStatus(record.public_view.status) ||
      record.settlement.status !== record.public_view.status ||
      record.settlement.occurred_at !== record.public_view.finished_at ||
      !sameCanonicalOwnerJson(record.settlement.event, projectedSettlement.event)) {
      invalidOwnerRecord("run owner record settlement does not match its public projection");
    }
  } else if (isTerminalRunStatus(record.public_view.status)) {
    invalidOwnerRecord("terminal run owner record is missing its settlement");
  }
}

function ownerRecordForSnapshot(
  snapshot: RunTaskView,
  existing: RunOwnerRecordV1 | undefined,
  explicitState?: RunTaskState,
): RunOwnerRecordV1 {
  const state = explicitState ?? tasks.get(snapshot.run_id);
  const admission = existing?.immutable_admission ?? state?.ownerRecordAdmission;
  if (!admission) {
    invalidOwnerRecord("current v3 run has no owner admission record");
  }
  if (state?.ownerRecordAdmission && !sameCanonicalOwnerJson(admission, state.ownerRecordAdmission)) {
    invalidOwnerRecord("run owner admission changed during persistence");
  }
  const launch = state?.ownerLaunchObservation ?? existing?.launch_observation;
  return {
    record_name: RUN_OWNER_RECORD_NAME,
    record_version: RUN_OWNER_RECORD_VERSION,
    revision: (existing?.revision ?? 0) + 1,
    immutable_admission: admission,
    ...(launch ? { launch_observation: launch } : {}),
    ...(isTerminalRunStatus(snapshot.status) ? { settlement: settlementForSnapshot(snapshot) } : {}),
    public_view: snapshot,
  };
}

function ownerRecordFromValue(value: unknown): RunOwnerRecordV1 | undefined {
  if (!isRecord(value) || value.record_name !== RUN_OWNER_RECORD_NAME) return undefined;
  const record = value as unknown as RunOwnerRecordV1;
  assertRunOwnerRecord(record);
  return record;
}

async function readRunOwnerRecordFile(filePath: string): Promise<RunOwnerRecordV1 | undefined> {
  return ownerRecordFromValue(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
}

async function readPersistedRunView(filePath: string): Promise<RunTaskView> {
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  const record = ownerRecordFromValue(value);
  if (record) return record.public_view;
  const legacy = value as RunTaskView;
  if (legacy.client_start_binding ||
    (legacy.contract_name === DURABLE_RUN_CONTRACT_NAME && legacy.contract_version === DURABLE_RUN_CONTRACT_VERSION)) {
    invalidOwnerRecord("current v3 run snapshot is missing its owner record envelope");
  }
  return legacy;
}

async function serializeOwnerRecordWrite<T>(runId: string, operation: () => Promise<T>): Promise<T> {
  const previous = ownerRecordWriteChains.get(runId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  ownerRecordWriteChains.set(runId, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (ownerRecordWriteChains.get(runId) === queued) ownerRecordWriteChains.delete(runId);
  }
}

async function writeTaskSnapshot(view: RunTaskView): Promise<void> {
  await serializeOwnerRecordWrite(view.run_id, async () => {
    const recordPath = taskRecordPath(view.run_id);
    const existingRecord = await readRunOwnerRecordFile(recordPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const existing = existingRecord?.public_view;
    if (
      existing &&
      isRestartDriftSnapshot(existing) &&
      isTerminalRunStatus(view.status) &&
      !isRestartDriftSnapshot(view)
    ) return;
    const runTasksDir = defaultRunTasksDir();
    const terminal = isTerminalRunStatus(view.status);
    let snapshot = view;
    if (terminal) {
      const persistedEvents = await readRunPublicEvents(runTasksDir, view.run_id);
      const existingEvents = existing?.recent_events ?? [];
      const viewEvents = view.recent_events ?? [];
      // Event JSONL is staging.  If a crash happened after it recorded a
      // child lifecycle line but before the owner record recorded
      // `child_started`, a declaration-only owner terminal must not turn that
      // line into durable launch evidence during its final merge.
      const ownerObservableEvents = [...existingEvents, ...persistedEvents, ...viewEvents].filter((event) =>
        view.child_started !== false || event.kind !== "child",
      );
      const canonicalEvents = terminalEventsProjection(
        ownerObservableEvents.sort((left, right) =>
          left.occurred_at.localeCompare(right.occurred_at)
        ),
      );
      snapshot = {
        ...view,
        recent_events: canonicalEvents,
        ...(canonicalEvents.length > 0
          ? { last_public_output_excerpt: publicOutputExcerptProjection(canonicalEvents) }
          : {}),
      };
    }
    const record = ownerRecordForSnapshot(snapshot, existingRecord);
    assertRunOwnerRecord(record);
    await fs.mkdir(runTasksDir, { recursive: true });
    const tmpPath = `${recordPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    const handle = await fs.open(tmpPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmpPath, recordPath);
      await fsyncRunTasksDirectory();
    } finally {
      await fs.rm(tmpPath, { force: true });
    }
    if (terminal) {
      const cleanupResults = await Promise.allSettled([
        removeRunPublicEvents(runTasksDir, snapshot.run_id),
        removeTerminalInputRequestsForRun({
          mailboxRoot: path.dirname(snapshot.input_requests_dir),
          runId: snapshot.run_id,
        }),
      ]);
      for (const result of cleanupResults) {
        if (result.status === "rejected") {
          console.error(
            `[subagent007 warning] terminal state cleanup failed for run ${snapshot.run_id}: ${String(result.reason)}`,
          );
        }
      }
    }
  });
}

async function fsyncRunTasksDirectory(): Promise<void> {
  const directoryHandle = await fs.open(defaultRunTasksDir(), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function preparedClientStartCandidatePrefix(clientStartId: string): string {
  return `.client-start-candidate-${createHash("sha256").update(clientStartId).digest("hex")}-`;
}

function preparedClientStartCandidatePath(binding: ClientStartBinding, ownerPid: number): string {
  return path.join(
    defaultRunTasksDir(),
    `${preparedClientStartCandidatePrefix(binding.client_start_id)}${ownerPid}-${binding.run_id}.prepared`,
  );
}

async function reconcilePreparedClientStartCandidates(clientStartId?: string): Promise<number> {
  const runTasksDir = defaultRunTasksDir();
  const prefix = clientStartId === undefined ? ".client-start-candidate-" : preparedClientStartCandidatePrefix(clientStartId);
  const entries = await fs.readdir(runTasksDir).catch(() => []);
  let reconciled = 0;
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".prepared")) continue;
    const match = /^\.client-start-candidate-[0-9a-f]{64}-(\d+)-.+\.prepared$/.exec(entry);
    if (!match) continue;
    const candidatePath = path.join(runTasksDir, entry);
    let candidate: RunTaskView;
    try {
      candidate = await readPersistedRunView(candidatePath);
    } catch {
      continue;
    }
    if (!candidate.client_start_binding) continue;
    let admission: ClientStartAdmission;
    try {
      admission = await resolveClientStartAdmissionBinding(candidate.client_start_binding);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      if (!processIsDefinitelyGone(Number(match[1]))) continue;
      await fs.rm(candidatePath, { force: true });
      reconciled += 1;
      continue;
    }
    if (preparedClientStartCandidatePath(admission.binding, admission.owner_pid) !== candidatePath) continue;
    await promotePreparedClientStartCandidate(admission);
    reconciled += 1;
  }
  if (reconciled > 0) await fsyncRunTasksDirectory();
  return reconciled;
}

async function writePreparedClientStartCandidate(
  state: RunTaskState,
  request: StartRunTaskRequest,
): Promise<string> {
  if (!state.clientStartBinding) throw new Error("prepared client start candidate requires a binding identity");
  bindRequestToRunTaskState(state, request);
  ensureOwnerRecordAdmission(state, request);
  await fs.mkdir(defaultRunTasksDir(), { recursive: true });
  await reconcilePreparedClientStartCandidates(state.clientStartBinding.client_start_id);
  const candidatePath = preparedClientStartCandidatePath(state.clientStartBinding, process.pid);
  const handle = await fs.open(candidatePath, "wx", 0o600);
  try {
    const record = ownerRecordForSnapshot(activeRunTaskView(state, []), undefined, state);
    assertRunOwnerRecord(record);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncRunTasksDirectory();
  return candidatePath;
}

async function discardPreparedClientStartCandidate(candidatePath: string): Promise<void> {
  await fs.rm(candidatePath, { force: true });
  await fsyncRunTasksDirectory();
}

function validateClientStartSnapshotBinding(view: RunTaskView, admission: ClientStartAdmission): void {
  if (
    view.run_id !== admission.binding.run_id ||
    view.task_id !== admission.binding.run_id ||
    view.client_start_binding?.client_start_id !== admission.binding.client_start_id ||
    view.client_start_binding.request_sha256 !== admission.binding.request_sha256 ||
    view.client_start_binding.run_id !== admission.binding.run_id
  ) {
    throw new ValidationError(
      "client_start_id run snapshot does not match its authoritative binding",
      "client_start_id_conflict",
    );
  }
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isFiniteTimestamp(value: unknown): value is string {
  return isNonemptyString(value) && Number.isFinite(Date.parse(value));
}

function isNullableFiniteNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isUniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every(isNonemptyString) &&
    new Set(value).size === value.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || isNonemptyString(value);
}

function invalidCurrentRunTaskSnapshot(view: RunTaskView, message: string): never {
  throw new ValidationError(
    message,
    view.client_start_binding ? "client_start_id_conflict" : "run_liveness_unknown",
  );
}

function hasTerminalCoreEvidence(view: RunTaskView): boolean {
  return typeof view.success === "boolean" &&
    (view.exit_code === null || Number.isSafeInteger(view.exit_code)) &&
    typeof view.timed_out === "boolean" &&
    typeof view.partial_output_available === "boolean" &&
    typeof view.resume_possible === "boolean" &&
    typeof view.duration_ms === "number" && Number.isFinite(view.duration_ms) && view.duration_ms >= 0 &&
    isNullableFiniteNumber(view.requested_timeout_ms) &&
    isNullableFiniteNumber(view.resolved_timeout_ms) &&
    isNullableFiniteNumber(view.effective_timeout_ms) &&
    Array.isArray(view.output_references);
}

function hasProcessResultEvidence(view: RunTaskView): boolean {
  return isNonemptyString(view.output_path) &&
    typeof view.timeout_floor_ms === "number" && Number.isFinite(view.timeout_floor_ms) && view.timeout_floor_ms >= 0 &&
    typeof view.timeout_headroom_ms === "number" && Number.isFinite(view.timeout_headroom_ms) && view.timeout_headroom_ms >= 0 &&
    typeof view.kill_grace_ms === "number" && Number.isFinite(view.kill_grace_ms) && view.kill_grace_ms >= 0 &&
    typeof view.force_grace_ms === "number" && Number.isFinite(view.force_grace_ms) && view.force_grace_ms >= 0 &&
    typeof view.size_bytes === "number" && Number.isFinite(view.size_bytes) && view.size_bytes >= 0 &&
    typeof view.resolved_model_class === "string" && MODEL_CLASS_SET.has(view.resolved_model_class) &&
    OUTPUT_MODE_SET.has(view.requested_output_mode ?? "") &&
    OUTPUT_MODE_SET.has(view.written_output_mode ?? "") &&
    (view.stop_signal === null || isNonemptyString(view.stop_signal));
}

function hasAnyOwnField(view: RunTaskView, fields: readonly string[]): boolean {
  return fields.some((field) => Object.prototype.hasOwnProperty.call(view, field) &&
    (view as unknown as Record<string, unknown>)[field] !== undefined);
}

// These are child-process result fields shared by ordinary and session runs.
// They are forbidden only on owner-generated terminals, which deliberately
// carry the smaller synthetic failure envelope.
const PROCESS_RESULT_FIELDS = [
  "timeout_floor_ms",
  "timeout_headroom_ms",
  "kill_grace_ms",
  "force_grace_ms",
  "size_bytes",
  "resolved_model_class",
  "requested_skill",
  "resolved_skill_path",
  "resolved_skill_sha256",
  "requested_output_mode",
  "written_output_mode",
  "stop_signal",
] as const;

const SESSION_RESULT_FIELDS = [
  "session_dir",
  "manifest_path",
  "ledger_path",
  "attempts_path",
  "subagent_session_id",
  "attempt_subagent_session_id",
  "attempt_session_established",
  "created_or_resumed",
  "resume_mode",
  "requested_packet_policy",
  "packet_path",
  "packet_parse_status",
  "packet_error",
  "claimed_packet",
  "run_record",
  "model_changed_from_manifest",
] as const;

const OWNER_ONLY_FORBIDDEN_FIELDS = [
  ...PROCESS_RESULT_FIELDS,
  ...SESSION_RESULT_FIELDS,
  "timeout_recovery_hint",
  "partial_output_path",
  "provider_error_type",
  "provider_status_code",
  "provider_error_message",
  "usage_limit_plan_type",
  "usage_limit_resets_at",
  "usage_limit_resets_in_seconds",
  "usage_limit_retry_after_seconds",
  "usage_limit_primary_used_percent",
  "usage_limit_secondary_used_percent",
  "usage_limit_primary_reset_after_seconds",
  "usage_limit_secondary_reset_after_seconds",
] as const;

const OWNER_PROMOTION_FIELDS = [
  "auto_promoted_from",
  "promotion_reason_code",
  "promotion_reason",
  "poll_with",
  "cancel_with",
] as const;

const OWNER_VALIDATION_REASON_CODES = new Set<FailureReasonCode>([
  "child_entrypoint_missing", "child_entrypoint_not_file", "config_missing_default_model_class",
  "cancelled_before_first_output", "cwd_inaccessible", "cwd_not_absolute", "cwd_not_directory",
  "disk_reserve_exhausted", "client_start_id_conflict", "invalid_output_mode", "invalid_packet_policy",
  "invalid_model", "invalid_model_class", "model_class_unhealthy", "invalid_resume_mode",
  "invalid_session_id", "invalid_session_key", "invalid_skill", "invalid_thinking_level",
  "invalid_tool_profile", "invalid_effect_profile", "authoring_effect_scope_invalid",
  "authoring_effect_scope_drift", "invalid_expected_skill_sha256", "effect_profile_unsupported",
  "skill_binding_unsupported", "effect_profile_activation_failed", "skill_content_mismatch",
  "invalid_skill_snapshot_binding", "skill_snapshot_not_found", "skill_snapshot_altered",
  "skill_snapshot_reference_mismatch", "skill_snapshot_reference_closed", "skill_snapshot_activation_failed",
  "invalid_timeout_ms", "invalid_wait_ms", "local_capacity_exhausted", "local_queue_exhausted",
  "timeout_underbudget_for_deadline_risk", "missing_session_id", "missing_final_output",
  "nonzero_exit", "packet_required_invalid", "packet_required_missing", "packet_required_not_ready",
  "prompt_missing", "raw_session_id_unsupported", "recursive_control_invalid", "recursive_depth_exceeded",
  "run_not_accepting_input", "run_liveness_unknown", "run_not_found", "run_subagent_incompatible_workload",
  "run_subagent_timeout_unsupported", "input_request_already_answered", "input_request_already_closed",
  "input_request_already_timed_out", "input_request_not_found", "input_request_not_part_of_run",
  "input_response_id_conflict", "session_already_exists", "session_already_running", "session_cwd_mismatch",
  "session_does_not_exist", "session_ledger_invalid", "session_commit_invalid", "session_manifest_invalid",
  "session_skill_mismatch", "spawn_error", "timeout", "usage_limit_reached", "process_signal_terminated",
  "recursive_delegation_reauthorization_required", "recursive_delegation_effect_conflict",
  "recursive_delegation_activation_failed", "recursive_delegation_unsupported", "unknown_error",
  "unknown_validation_error",
]);

function hasOwnDefined(view: RunTaskView, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(view, field) &&
    (view as unknown as Record<string, unknown>)[field] !== undefined;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ownerPromotionIsExact(view: RunTaskView): boolean {
  const hasAny = OWNER_PROMOTION_FIELDS.some((field) => hasOwnDefined(view, field));
  if (!hasAny) return true;
  return view.task_kind === "run" && view.client_start_binding === undefined &&
    view.auto_promoted_from === "run_subagent" &&
    ["skill_bound", "prompt_too_long", "broad_work", "workspace_write"].includes(view.promotion_reason_code ?? "") &&
    isNonemptyString(view.promotion_reason) && view.poll_with === "get_run" && view.cancel_with === "cancel_run";
}

type DerivedOwnerObservation =
  | { tag: "declaration_only" }
  | { tag: "observed"; child_prompt_submitted: boolean };

interface DerivedOwnerTerminalLifecycle {
  observation: DerivedOwnerObservation;
  settlement: {
    tag: "settled";
    expected_event: NonNullable<ReturnType<typeof ownerTerminalEventProjection>>;
  };
}

interface OwnerRequestDeclarations {
  effectProfile?: NonNullable<RunSubagentRequest["effect_profile"]>;
  expectedSkillSha256?: string;
  skillSnapshotBinding?: NonNullable<RunSubagentRequest["skill_snapshot_binding"]>;
  requestedRecursiveDelegation: "disabled" | "enabled" | null;
}

function ownerRequestDeclarations(view: RunTaskView): OwnerRequestDeclarations | null {
  const effectProfile = hasOwnDefined(view, "requested_effect_profile")
    ? view.requested_effect_profile
    : undefined;
  const expectedSkillSha256 = hasOwnDefined(view, "expected_skill_sha256")
    ? view.expected_skill_sha256
    : undefined;
  const rawSnapshotBinding = hasOwnDefined(view, "skill_snapshot_binding")
    ? view.skill_snapshot_binding
    : undefined;
  const hasRequestedRecursiveDelegation = hasOwnDefined(view, "requested_recursive_delegation");
  const rawRequestedRecursiveDelegation = hasRequestedRecursiveDelegation
    ? view.requested_recursive_delegation
    : undefined;
  const requestedRecursiveDelegation = rawRequestedRecursiveDelegation ?? null;
  if (
    (effectProfile !== undefined && !EFFECT_PROFILE_SET.has(effectProfile)) ||
    (expectedSkillSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedSkillSha256)) ||
    (rawSnapshotBinding !== undefined && !validatedSkillSnapshotLaunchBinding(rawSnapshotBinding)) ||
    (isBoundedEffectProfile(effectProfile) && rawSnapshotBinding === undefined) ||
    (hasRequestedRecursiveDelegation &&
      (rawRequestedRecursiveDelegation === undefined || !RECURSIVE_DELEGATION_SET.has(rawRequestedRecursiveDelegation))) ||
    (expectedSkillSha256 !== undefined && rawSnapshotBinding !== undefined) ||
    (effectProfile !== undefined && requestedRecursiveDelegation === "enabled")
  ) return null;
  return {
    ...(effectProfile ? { effectProfile } : {}),
    ...(expectedSkillSha256 ? { expectedSkillSha256 } : {}),
    ...(rawSnapshotBinding ? { skillSnapshotBinding: rawSnapshotBinding } : {}),
    requestedRecursiveDelegation,
  };
}

function hasChildLifecycleEvent(view: RunTaskView): boolean {
  return Array.isArray(view.recent_events) && view.recent_events.some((event) =>
    event.kind === "child" && [
      "child_spawned", "child_bridge_started", "child_session_established", "activation_confirmed",
      "skill_snapshot_activation_confirmed", "recursive_delegation_confirmed", "child_prompt_submitted",
    ].includes(event.event ?? ""));
}

function childPromptWasSubmitted(view: RunTaskView): boolean {
  return view.last_child_lifecycle_event === "child_prompt_submitted" ||
    (Array.isArray(view.recent_events) && view.recent_events.some((event) =>
      event.kind === "child" && event.event === "child_prompt_submitted"));
}

function projectedActivationIsExact(
  view: RunTaskView,
  declarations: OwnerRequestDeclarations,
  promptSubmitted: boolean,
): boolean {
  const triggered = declarations.effectProfile !== undefined || declarations.expectedSkillSha256 !== undefined;
  const hasReceipt = hasOwnDefined(view, "activation_receipt");
  const hasResolvedProfile = hasOwnDefined(view, "resolved_effect_profile");
  if (!hasReceipt) {
    return !hasResolvedProfile && !(promptSubmitted && triggered);
  }
  if (!triggered || !view.activation_receipt) return false;
  const receipt = validatedProjectedActivationReceipt({
    value: view.activation_receipt,
    requestedEffectProfile: declarations.effectProfile,
    expectedSkillSha256: declarations.expectedSkillSha256,
  });
  if (!receipt) return false;
  if (receipt.resolved_effect_profile === null) {
    if (hasResolvedProfile) return false;
  } else if (view.resolved_effect_profile !== receipt.resolved_effect_profile) {
    return false;
  }
  return true;
}

function projectedSnapshotActivationIsExact(
  view: RunTaskView,
  declarations: OwnerRequestDeclarations,
  promptSubmitted: boolean,
): boolean {
  const hasReceipt = hasOwnDefined(view, "skill_snapshot_activation_receipt");
  if (!hasReceipt) return !(promptSubmitted && declarations.skillSnapshotBinding !== undefined);
  if (!declarations.skillSnapshotBinding || !view.skill_snapshot_activation_receipt) return false;
  return validatedSkillSnapshotActivationReceipt({
    value: view.skill_snapshot_activation_receipt,
    binding: declarations.skillSnapshotBinding,
  }) !== undefined;
}

function projectedRecursiveActivationIsExact(
  view: RunTaskView,
  declarations: OwnerRequestDeclarations,
  promptSubmitted: boolean,
): boolean {
  const hasReceipt = hasOwnDefined(view, "recursive_delegation_receipt");
  const hasResolved = hasOwnDefined(view, "resolved_recursive_delegation");
  if (!hasReceipt) return !hasResolved && !promptSubmitted;
  if (!hasResolved || !view.recursive_delegation_receipt ||
    !RECURSIVE_DELEGATION_SET.has(view.resolved_recursive_delegation ?? "")) return false;
  return validatedRecursiveDelegationReceipt({
    value: view.recursive_delegation_receipt,
    requestedRecursiveDelegation: declarations.requestedRecursiveDelegation,
    resolvedRecursiveDelegation: view.resolved_recursive_delegation!,
  }) !== undefined;
}

function activationFamiliesJoinExactly(view: RunTaskView): boolean {
  const activationSkill = view.activation_receipt?.skill_binding;
  const snapshotReceipt = view.skill_snapshot_activation_receipt;
  if (!activationSkill || !snapshotReceipt) return true;
  return activationSkill.name === snapshotReceipt.skill_name &&
    activationSkill.path === snapshotReceipt.resolved_skill_path;
}

function derivedOwnerTerminalLifecycle(view: RunTaskView): DerivedOwnerTerminalLifecycle | null {
  const declarations = ownerRequestDeclarations(view);
  const expectedEvent = ownerTerminalEventProjection(view);
  if (!declarations || !expectedEvent) return null;
  if (view.child_started === false) {
    if (
      isNonemptyString(view.session_id) || view.session_established !== false ||
      hasOwnDefined(view, "child_started_at") || hasOwnDefined(view, "queue_wait_ms") ||
      hasOwnDefined(view, "last_child_lifecycle_event") || hasOwnDefined(view, "last_child_lifecycle_at") ||
      hasOwnDefined(view, "first_public_output_at") ||
      hasChildLifecycleEvent(view) || hasOwnDefined(view, "resolved_effect_profile") ||
      hasOwnDefined(view, "activation_receipt") || hasOwnDefined(view, "skill_snapshot_activation_receipt") ||
      hasOwnDefined(view, "resolved_recursive_delegation") || hasOwnDefined(view, "recursive_delegation_receipt")
    ) return null;
    return {
      observation: { tag: "declaration_only" },
      settlement: { tag: "settled", expected_event: expectedEvent },
    };
  }
  const promptSubmitted = childPromptWasSubmitted(view);
  if (
    (hasOwnDefined(view, "last_child_lifecycle_event") !== hasOwnDefined(view, "last_child_lifecycle_at")) ||
    (hasOwnDefined(view, "last_child_lifecycle_at") && !isFiniteTimestamp(view.last_child_lifecycle_at)) ||
    (hasOwnDefined(view, "child_started_at") && !isFiniteTimestamp(view.child_started_at)) ||
    (hasOwnDefined(view, "queue_wait_ms") &&
      (typeof view.queue_wait_ms !== "number" || !Number.isFinite(view.queue_wait_ms) || view.queue_wait_ms < 0)) ||
    !projectedActivationIsExact(view, declarations, promptSubmitted) ||
    !projectedSnapshotActivationIsExact(view, declarations, promptSubmitted) ||
    !projectedRecursiveActivationIsExact(view, declarations, promptSubmitted) ||
    !activationFamiliesJoinExactly(view)
  ) return null;
  return {
    observation: { tag: "observed", child_prompt_submitted: promptSubmitted },
    settlement: { tag: "settled", expected_event: expectedEvent },
  };
}

function ownerOutputClosureIsExact(view: RunTaskView, restartDrift: boolean): boolean {
  const outputReferences = view.output_references;
  if (!Array.isArray(outputReferences)) return false;
  if (!restartDrift) {
    return view.partial_output_available === false && view.output_path === undefined && outputReferences.length === 0;
  }
  if (view.partial_output_available === false) {
    return view.output_path === undefined && outputReferences.length === 0;
  }
  if (!isNonemptyString(view.output_path) || !path.isAbsolute(view.output_path) || outputReferences.length !== 1) return false;
  const reference = outputReferences[0];
  return isRecord(reference) && Object.keys(reference).sort().join("\0") === [
    "content_type", "encoding", "kind", "name", "output_mode", "path", "size_bytes",
  ].sort().join("\0") &&
    reference.kind === "file" && reference.name === "primary" && reference.path === view.output_path &&
    reference.content_type === "text/markdown" && reference.encoding === "utf-8" && reference.output_mode === "transcript" &&
    Number.isSafeInteger(reference.size_bytes) && (reference.size_bytes as number) >= 0;
}

function ownerTerminalEventProjection(view: RunTaskView): Pick<RunPublicEvent, "kind" | "event" | "text" | "occurred_at" | "metadata"> | null {
  if (!isFiniteTimestamp(view.finished_at)) return null;
  const cleanCancellation = view.status === "cancelled" && view.child_started === false;
  const restartDrift = view.error_class === "restart_drift" && view.reason_code === "server_restarted_active_run";
  if (cleanCancellation) {
    return {
      kind: "terminal", event: "cancellation_settled", text: "[cancellation_settled] run cancelled",
      occurred_at: view.finished_at, metadata: {},
    };
  }
  if (restartDrift) {
    return {
      kind: "terminal", event: "failed", text: "[failed] run is not active after MCP server restart",
      occurred_at: view.finished_at,
      metadata: syntheticTerminalFailureEventMetadata(view as ReturnType<typeof syntheticTerminalFailureEnvelope>),
    };
  }
  if (!isNonemptyString(view.error)) return null;
  const metadata = {
    ...syntheticTerminalFailureEventMetadata(view as ReturnType<typeof syntheticTerminalFailureEnvelope>),
    error: view.error,
  };
  return view.status === "cancelled"
    ? { kind: "terminal", event: "cancellation_settled", text: "[cancellation_settled] run cancelled", occurred_at: view.finished_at, metadata }
    : { kind: "terminal", event: "failed", text: `[failed] ${view.error}`, occurred_at: view.finished_at, metadata };
}

function hasExactOwnerTerminalEvent(
  view: RunTaskView,
  expected: NonNullable<ReturnType<typeof ownerTerminalEventProjection>>,
): boolean {
  if (!Array.isArray(view.recent_events)) return false;
  const terminalEvents = view.recent_events.filter((event) => event.kind === "terminal" &&
    OWNER_SETTLEMENT_EVENT_SET.has(event.event ?? ""));
  return terminalEvents.length === 1 &&
    terminalEvents[0]?.event === expected.event && terminalEvents[0]?.text === expected.text &&
    terminalEvents[0]?.occurred_at === expected.occurred_at && sameJsonValue(terminalEvents[0]?.metadata ?? {}, expected.metadata ?? {});
}

function hasConsistentResultStatus(view: RunTaskView): boolean {
  const stopReason = view.stop_reason;
  if (
    typeof stopReason !== "string" || !RUN_STOP_REASON_SET.has(stopReason) ||
    view.error !== undefined || view.child_started !== true
  ) return false;
  if (terminalRunTaskStatus({
    success: view.success ?? false,
    timed_out: view.timed_out ?? false,
    stop_reason: stopReason as import("./types.js").RunStopReason,
  }) !== view.status) return false;
  switch (view.status) {
    case "completed":
      return view.success === true && view.exit_code === 0 && view.timed_out === false &&
        stopReason === "completed" && view.child_started === true &&
        view.error_class === undefined && view.reason_code === undefined;
    case "failed":
      return view.success === false && view.timed_out === false &&
        stopReason !== "cancelled" && stopReason !== "timeout" &&
        isNonemptyString(view.error_class) && isNonemptyString(view.reason_code);
    case "cancelled":
      return view.success === false && view.timed_out === false && stopReason === "cancelled";
    case "timed_out":
      return view.success === false && view.timed_out === true && stopReason === "timeout";
    default:
      return false;
  }
}

function hasRunTerminalEvidence(view: RunTaskView): boolean {
  return hasProcessResultEvidence(view) &&
    isNullableString(view.session_id) &&
    typeof view.session_established === "boolean" &&
    view.session_key === undefined &&
    !hasAnyOwnField(view, SESSION_RESULT_FIELDS);
}

function hasSessionTerminalEvidence(view: RunTaskView): boolean {
  const record = view.run_record;
  if (!hasProcessResultEvidence(view) ||
    !isNonemptyString(view.session_key) ||
    !isNonemptyString(view.session_dir) ||
    !isNonemptyString(view.manifest_path) ||
    !isNonemptyString(view.ledger_path) ||
    !isNonemptyString(view.attempts_path) ||
    !isNullableString(view.subagent_session_id) ||
    typeof view.session_established !== "boolean" ||
    !["created", "resumed", "not_created"].includes(view.created_or_resumed ?? "") ||
    !RESUME_MODE_SET.has(view.resume_mode ?? "") ||
    !SESSION_PACKET_POLICY_SET.has(view.requested_packet_policy ?? "") ||
    !isNullableString(view.packet_path) ||
    !PACKET_PARSE_STATUS_SET.has(view.packet_parse_status ?? "") ||
    (view.packet_error !== undefined && !isNonemptyString(view.packet_error)) ||
    !(view.claimed_packet === null || isRecord(view.claimed_packet)) ||
    typeof view.model_changed_from_manifest !== "boolean" ||
    !isRecord(record) ||
    view.session_id !== undefined
  ) return false;
  const attemptId = view.attempt_subagent_session_id;
  const attemptEstablished = view.attempt_session_established;
  const recordAttemptId = record.attempt_subagent_session_id;
  const recordAttemptEstablished = record.attempt_session_established;
  const noAttemptSession = attemptId === null && attemptEstablished === false &&
    recordAttemptId === null && recordAttemptEstablished === false &&
    view.success === false &&
    (view.status === "failed" || view.status === "cancelled" || view.status === "timed_out") &&
    view.created_or_resumed === "not_created" &&
    view.subagent_session_id === null && view.session_established === false;
  const establishedAttempt = isNonemptyString(attemptId) && attemptEstablished === true &&
    recordAttemptId === attemptId && recordAttemptEstablished === true;
  const historicalAttempt = attemptId === undefined && attemptEstablished === undefined &&
    recordAttemptId === undefined && recordAttemptEstablished === undefined;
  // A successful attempt commits a new/resumed session identity.  A failed
  // attempt records `not_created`, but may truthfully retain the prior
  // committed identity from an existing manifest.
  const sessionCommitMatches = view.success
    ? view.session_established === true && isNonemptyString(view.subagent_session_id) &&
      (view.created_or_resumed === "created" || view.created_or_resumed === "resumed")
    : view.created_or_resumed === "not_created" &&
      (view.session_established === isNonemptyString(view.subagent_session_id));
  return isNonemptyString(record.run_id) &&
    Number.isSafeInteger(record.sequence) && record.sequence > 0 &&
    isFiniteTimestamp(record.started_at) && isFiniteTimestamp(record.finished_at) &&
    record.action === view.created_or_resumed &&
    record.subagent_session_id === view.subagent_session_id &&
    record.resume_mode === view.resume_mode &&
    record.output_path === view.output_path &&
    record.packet_path === view.packet_path &&
    record.packet_policy === view.requested_packet_policy &&
    record.success === view.success &&
    record.exit_code === view.exit_code &&
    record.timed_out === view.timed_out &&
    record.duration_ms === view.duration_ms &&
    record.requested_skill === view.requested_skill &&
    record.requested_output_mode === view.requested_output_mode &&
    record.written_output_mode === view.written_output_mode &&
    record.stop_reason === view.stop_reason &&
    record.packet_parse_status === view.packet_parse_status &&
    sessionCommitMatches && (noAttemptSession || establishedAttempt || historicalAttempt);
}

function hasOwnerTerminalEvidence(view: RunTaskView): boolean {
  if (view.stop_reason !== undefined || (view.status !== "failed" && view.status !== "cancelled")) return false;
  if (hasAnyOwnField(view, OWNER_ONLY_FORBIDDEN_FIELDS)) return false;
  if (view.task_kind === "run" && view.session_key !== undefined) return false;
  if (
    view.success !== false || view.exit_code !== null || view.timed_out !== false ||
    view.resume_possible !== false || view.requested_timeout_ms !== null ||
    view.resolved_timeout_ms !== null || view.effective_timeout_ms !== null ||
    !hasOwnDefined(view, "session_id") || !isNullableString(view.session_id) ||
    !hasOwnDefined(view, "session_established") || typeof view.session_established !== "boolean" ||
    view.session_established !== isNonemptyString(view.session_id) ||
    view.duration_ms !== elapsedMsBetween(view.started_at, view.finished_at ?? "") ||
    view.last_phase_at !== view.finished_at
  ) return false;
  const lifecycle = derivedOwnerTerminalLifecycle(view);
  if (!lifecycle) return false;
  const expectedEvent = lifecycle.settlement.expected_event;
  const restartDrift = view.status === "failed" && view.error_class === "restart_drift" &&
    view.reason_code === "server_restarted_active_run";
  if (!ownerOutputClosureIsExact(view, restartDrift)) return false;
  const cleanCancellation = view.status === "cancelled" && view.child_started === false;
  if (cleanCancellation) {
    return view.error === undefined && view.error_class === undefined && view.reason_code === undefined &&
      hasExactOwnerTerminalEvent(view, expectedEvent);
  }
  if (restartDrift) {
    return view.error === "run is not active in this MCP server process; the server may have restarted" &&
      hasExactOwnerTerminalEvent(view, expectedEvent);
  }
  const typedCancellation = view.status === "cancelled" && view.child_started === true;
  const ordinaryFailure = view.status === "failed";
  if (!typedCancellation && !ordinaryFailure) return false;
  if (!isNonemptyString(view.error) || !isNonemptyString(view.error_class) || !isNonemptyString(view.reason_code)) return false;
  const taxonomyValid = view.error_class === "unknown_error"
    ? view.reason_code === "handler_error"
    : view.error_class === "validation_error" && OWNER_VALIDATION_REASON_CODES.has(view.reason_code);
  return taxonomyValid && hasExactOwnerTerminalEvent(view, expectedEvent);
}

function hasCurrentSnapshotStructure(view: RunTaskView): boolean {
  return view.contract_name === DURABLE_RUN_CONTRACT_NAME &&
    view.contract_version === DURABLE_RUN_CONTRACT_VERSION &&
    isNonemptyString(view.run_id) &&
    view.task_id === view.run_id &&
    (view.task_kind === "run" || view.task_kind === "session") &&
    isNonemptyString(view.root_run_id) &&
    Number.isSafeInteger(view.recursion_depth) && view.recursion_depth >= 0 &&
    isUniqueStringArray(view.child_run_ids) &&
    isUniqueStringArray(view.descendant_run_ids) &&
    !!view.descendant_terminal_statuses && typeof view.descendant_terminal_statuses === "object" && !Array.isArray(view.descendant_terminal_statuses) &&
    Object.values(view.descendant_terminal_statuses).every((status) => TERMINAL_RUN_STATUS_SET.has(status)) &&
    isFiniteTimestamp(view.started_at) &&
    isNonemptyString(view.input_requests_dir) && path.isAbsolute(view.input_requests_dir) &&
    Array.isArray(view.input_requests) &&
    typeof view.child_started === "boolean" &&
    isFiniteTimestamp(view.last_phase_at) &&
    typeof view.active_phase === "string" &&
    (view.task_kind !== "session" || isNonemptyString(view.session_key));
}

export function assertCurrentRunTaskSnapshot(view: RunTaskView, admission?: ClientStartAdmission): void {
  if (!hasCurrentSnapshotStructure(view)) {
    invalidCurrentRunTaskSnapshot(view, "current durable run snapshot has an invalid structural lifecycle");
  }
  const binding = view.client_start_binding;
  if (binding && (
    !isNonemptyString(binding.client_start_id) ||
    !/^[0-9a-f]{64}$/.test(binding.request_sha256) ||
    binding.run_id !== view.run_id ||
    view.task_kind !== "run"
  )) {
    invalidCurrentRunTaskSnapshot(view, "current durable run snapshot has an invalid client_start_id identity");
  }
  if (admission) {
    validateClientStartSnapshotBinding(view, admission);
    if (view.started_at !== admission.admitted_at) {
      invalidCurrentRunTaskSnapshot(view, "client_start_id run snapshot start identity does not match admission");
    }
  }
  if (!ownerPromotionIsExact(view)) {
    invalidCurrentRunTaskSnapshot(view, "current durable run snapshot has invalid promotion evidence");
  }
  if (!isTerminalRunStatus(view.status)) {
    const hasTerminalEvidence = view.finished_at !== undefined ||
      view.success !== undefined || view.exit_code !== undefined || view.timed_out !== undefined ||
      view.stop_reason !== undefined || view.error !== undefined || view.error_class !== undefined ||
      view.reason_code !== undefined;
    const inputRequired = view.status === "input_required";
    const pendingInput = view.input_requests.some((request) => request.status === "pending");
    const validActive = (view.status === "working" || inputRequired) &&
      NONTERMINAL_RUN_PHASE_SET.has(view.active_phase as RunTaskActivePhase) &&
      !hasTerminalEvidence &&
      (inputRequired ? (
        view.child_started === true &&
        view.active_phase === "input_required" &&
        pendingInput
      ) : (
        view.active_phase !== "input_required" && !pendingInput
      ));
    if (!validActive) {
      invalidCurrentRunTaskSnapshot(view, "current durable run snapshot has inconsistent active evidence");
    }
    return;
  }
  if (!isFiniteTimestamp(view.finished_at) ||
    Date.parse(view.finished_at) < Date.parse(view.started_at) ||
    view.active_phase !== view.status ||
    !hasTerminalCoreEvidence(view) ||
    view.input_requests.some((request) => request.status === "pending")) {
    invalidCurrentRunTaskSnapshot(view, "current durable run snapshot has inconsistent terminal result evidence");
  }
  const sourceValid = view.stop_reason === undefined
    ? hasOwnerTerminalEvidence(view)
    : view.task_kind === "session"
      ? hasSessionTerminalEvidence(view) && hasConsistentResultStatus(view)
      : hasRunTerminalEvidence(view) && hasConsistentResultStatus(view);
  if (!sourceValid) {
    invalidCurrentRunTaskSnapshot(view, "current durable run snapshot has invalid task-kind terminal evidence");
  }
}

function validatePreparedClientStartCandidate(view: RunTaskView, admission: ClientStartAdmission): void {
  assertCurrentRunTaskSnapshot(view, admission);
  if (view.status !== "working" || view.child_started !== false || view.active_phase !== "starting") {
    throw new ValidationError(
      "prepared client_start_id candidate is not a nonterminal pre-child run",
      "client_start_id_conflict",
    );
  }
}

async function joinExactCanonicalClientStartRun(
  admission: ClientStartAdmission,
): Promise<RunTaskView> {
  const authoritative = await resolveClientStartAdmissionBinding(admission.binding);
  const existing = await readTaskSnapshot(authoritative.binding.run_id);
  if (!existing) {
    throw new ValidationError(
      "authoritative client_start_id binding has no exact promoted run candidate",
      "client_start_id_conflict",
    );
  }
  assertCurrentRunTaskSnapshot(existing, authoritative);
  return existing;
}

async function promotePreparedClientStartCandidate(admission: ClientStartAdmission): Promise<RunTaskView> {
  const candidatePath = preparedClientStartCandidatePath(admission.binding, admission.owner_pid);
  let candidate: RunTaskView;
  try {
    if (
      process.env.SUBAGENT007_TEST_FAIL_CLIENT_START_PROMOTION_READ
      === admission.binding.client_start_id
    ) {
      throw new Error("injected client-start prepared candidate read failure");
    }
    candidate = await readPersistedRunView(candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return joinExactCanonicalClientStartRun(admission);
    }
    throw new ValidationError(
      "authoritative client_start_id binding has no readable prepared run candidate",
      "client_start_id_conflict",
    );
  }
  validatePreparedClientStartCandidate(candidate, admission);
  await waitAtClientStartPromotionAfterReadTestBarrier(admission.binding.client_start_id);
  try {
    await fs.link(candidatePath, taskRecordPath(admission.binding.run_id));
    await fsyncRunTasksDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOENT") throw error;
    candidate = await joinExactCanonicalClientStartRun(admission);
  }
  await discardPreparedClientStartCandidate(candidatePath);
  return candidate;
}

async function readTaskSnapshot(runId: string): Promise<RunTaskView | null> {
  try {
    const recordPath = taskRecordPath(runId);
    const ownerRecord = await readRunOwnerRecordFile(recordPath);
    if (ownerRecord) return ownerRecord.public_view;
    const view = JSON.parse(await fs.readFile(recordPath, "utf8")) as RunTaskView;
    if (
      view.client_start_binding ||
      (view.contract_name === DURABLE_RUN_CONTRACT_NAME && view.contract_version === DURABLE_RUN_CONTRACT_VERSION)
    ) {
      // Current-v3 snapshots without the owner envelope cannot establish an
      // owner-admitted claim.  They are diagnostic only and must never be
      // normalized or republished as authoritative evidence.
      invalidOwnerRecord("current v3 run snapshot is missing its owner record envelope");
    }
    return view;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function assertNoOrphanedClientStartSnapshot(clientStartId: string): Promise<void> {
  const entries = await fs.readdir(defaultRunTasksDir()).catch(() => []);
  for (const entry of entries) {
    if (entry.startsWith(".") || !entry.endsWith(".json")) continue;
    const snapshot = await readPersistedRunView(path.join(defaultRunTasksDir(), entry))
      .catch(() => undefined);
    if (snapshot?.client_start_binding?.client_start_id === clientStartId) {
      throw new ValidationError(
        "client_start_id has a durable run snapshot but its authoritative admission record is missing",
        "client_start_id_conflict",
      );
    }
  }
}

export async function reconcileRunTaskSnapshotTemps(): Promise<number> {
  const runTasksDir = defaultRunTasksDir();
  let reconciled = await reconcilePreparedClientStartCandidates();
  const entries = await fs.readdir(runTasksDir).catch(() => []);
  const candidatesByRun = new Map<string, Array<{ path: string; mtimeMs: number }>>();
  for (const entry of entries) {
    const match = /^(.*)\.json\.tmp-(\d+)-[0-9a-f]+$/.exec(entry);
    if (!match || !processIsDefinitelyGone(Number(match[2]))) {
      continue;
    }
    const candidatePath = path.join(runTasksDir, entry);
    const stat = await fs.stat(candidatePath).catch(() => null);
    if (!stat?.isFile()) {
      continue;
    }
    const candidates = candidatesByRun.get(match[1]) ?? [];
    candidates.push({ path: candidatePath, mtimeMs: stat.mtimeMs });
    candidatesByRun.set(match[1], candidates);
  }

  for (const [runId, candidates] of candidatesByRun) {
    const recordPath = taskRecordPath(runId);
    const canonicalExists = await fs.stat(recordPath).then(() => true, () => false);
    if (!canonicalExists) {
      for (const candidate of candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)) {
        const valid = await readPersistedRunView(candidate.path)
          .then((snapshot) => snapshot.run_id === runId, () => false);
        if (!valid) {
          continue;
        }
        try {
          await fs.link(candidate.path, recordPath);
          reconciled += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
          }
        }
        break;
      }
    }
    for (const candidate of candidates) {
      await fs.rm(candidate.path, { force: true });
      reconciled += 1;
    }
  }
  return reconciled;
}

function taskNotFound(runId: string): ValidationError {
  return new ValidationError(`run not found: ${runId}`, "run_not_found");
}

function serializeInputMutation<T>(state: RunTaskState, operation: () => Promise<T>): Promise<T> {
  const previous = state.inputMutationQueue;
  let release!: () => void;
  state.inputMutationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  return (async () => {
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  })();
}

function rejectPendingInputDeliveries(state: RunTaskState, error: ValidationError): void {
  for (const delivery of state.pendingInputDeliveries.values()) {
    delivery.reject(error);
  }
  state.pendingInputDeliveries.clear();
}

function createRunTaskState(
  taskKind: "run" | "session",
  sessionKey?: string,
  lineage: RunTaskLineage = {},
  fixedRunId?: string,
  clientStartBinding?: ClientStartBinding,
  fixedStartedAt?: string,
): RunTaskState {
  const runId = fixedRunId ?? newRunId();
  const mailboxRoot = defaultInputRequestsDir();
  const startedAt = fixedStartedAt ?? new Date().toISOString();
  let resolveSkillSnapshotActivation!: (
    receipt: RunSubagentResult["skill_snapshot_activation_receipt"] | undefined,
  ) => void;
  const skillSnapshotActivationPromise = new Promise<RunSubagentResult["skill_snapshot_activation_receipt"] | undefined>((resolve) => {
    resolveSkillSnapshotActivation = resolve;
  });
  const state: RunTaskState = {
    runId,
    startedAt,
    mailboxRoot,
    inputRequestsDir: path.join(mailboxRoot, runId),
    abortController: new AbortController(),
    taskKind,
    cancelRequested: false,
    heartbeatCount: 0,
    activePhase: "starting",
    lastPhaseAt: startedAt,
    recentEvents: [],
    terminalSnapshotStarted: false,
    promise: Promise.resolve(),
    skillSnapshotActivationObservation: {
      promise: skillSnapshotActivationPromise,
      resolve: resolveSkillSnapshotActivation,
    },
    ...(sessionKey ? { sessionKey } : {}),
    ...(lineage.parentRunId ? { parentRunId: lineage.parentRunId } : {}),
    rootRunId: lineage.rootRunId ?? runId,
    recursionDepth: lineage.recursionDepth ?? 0,
    childRunIds: [],
    descendantRunIds: [],
    descendantTerminalStatuses: {},
    acceptedInputResponses: new Map(),
    pendingInputDeliveries: new Map(),
    inputMutationQueue: Promise.resolve(),
    terminalizing: false,
    childStarted: false,
    capacityReleased: false,
    ...(clientStartBinding ? { clientStartBinding } : {}),
  };
  setTaskProgress(state, DEFAULT_HEARTBEAT_MESSAGE, 0);
  return state;
}

function setTaskPhase(state: RunTaskState, phase: RunTaskActivePhase, occurredAt = new Date().toISOString()): void {
  if (state.terminalSnapshotStarted) {
    return;
  }
  if (
    state.cancelRequested
    && phase !== "cancelling"
    && phase !== "cancelled"
    && phase !== "timed_out"
    && phase !== "completed"
    && phase !== "failed"
  ) {
    return;
  }
  state.activePhase = phase;
  state.lastPhaseAt = occurredAt;
}

function noteChildLifecycle(
  state: RunTaskState,
  event: ChildLifecycleEventName,
  occurredAt = new Date().toISOString(),
): void {
  if (state.terminalSnapshotStarted) {
    return;
  }
  state.lastChildLifecycleEvent = event;
  state.lastChildLifecycleAt = occurredAt;
}

function noteFirstPublicOutput(state: RunTaskState, occurredAt = new Date().toISOString()): void {
  if (state.terminalSnapshotStarted || state.firstPublicOutputAt) {
    return;
  }
  state.firstPublicOutputAt = occurredAt;
}

function contractFields(): Pick<RunTaskView, "contract_name" | "contract_version"> {
  return {
    contract_name: DURABLE_RUN_CONTRACT_NAME,
    contract_version: DURABLE_RUN_CONTRACT_VERSION,
  };
}

function normalizeHistoricalSnapshotForRepublication(snapshot: RunTaskView): RunTaskView {
  // Historical v3 snapshots can predate a later internal field.  Republishing
  // upgrades only the owner-controlled contract marker; it never invents
  // child, session, output, or lineage evidence.
  return {
    ...snapshot,
    ...contractFields(),
  };
}

function errorTaxonomyForError(error: Error): { error_class: string; reason_code: FailureReasonCode } {
  return {
    error_class: error instanceof ValidationError ? "validation_error" : "unknown_error",
    reason_code: failureReasonCodeForError(error),
  };
}

function elapsedMsBetween(startedAt: string, finishedAt: string): number {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) {
    return 0;
  }
  return Math.max(0, finished - started);
}

function syntheticTerminalFailureEnvelope(options: {
  startedAt: string;
  finishedAt: string;
  errorClass: string;
  reasonCode: FailureReasonCode;
  sessionId?: string | null;
  sessionEstablished?: boolean;
  outputPath?: string;
  outputReferences?: RunTaskView["output_references"];
  partialOutputAvailable?: boolean;
}): Pick<
  RunTaskView,
  | "success"
  | "exit_code"
  | "timed_out"
  | "partial_output_available"
  | "resume_possible"
  | "duration_ms"
  | "requested_timeout_ms"
  | "resolved_timeout_ms"
  | "effective_timeout_ms"
  | "session_id"
  | "session_established"
  | "output_references"
  | "error_class"
  | "reason_code"
> & { output_path?: string } {
  return {
    success: false,
    exit_code: null,
    timed_out: false,
    partial_output_available: options.partialOutputAvailable ?? false,
    resume_possible: false,
    duration_ms: elapsedMsBetween(options.startedAt, options.finishedAt),
    requested_timeout_ms: null,
    resolved_timeout_ms: null,
    effective_timeout_ms: null,
    session_id: options.sessionId ?? null,
    session_established: options.sessionEstablished ?? (options.sessionId !== undefined && options.sessionId !== null),
    output_references: options.outputReferences ?? [],
    ...(options.outputPath ? { output_path: options.outputPath } : {}),
    error_class: options.errorClass,
    reason_code: options.reasonCode,
  };
}

function sessionIdFromEvents(events: RunPublicEvent[] | undefined): string | null {
  if (!events) {
    return null;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const sessionId = event.metadata?.session_id;
    if (typeof sessionId === "string" && sessionId.trim() !== "") {
      return sessionId;
    }
  }
  return null;
}

function syntheticTerminalFailureEventMetadata(
  envelope: ReturnType<typeof syntheticTerminalFailureEnvelope>,
): Record<string, unknown> {
  return {
    success: envelope.success,
    error_class: envelope.error_class,
    reason_code: envelope.reason_code,
    exit_code: envelope.exit_code,
    timed_out: envelope.timed_out,
    duration_ms: envelope.duration_ms,
    effective_timeout_ms: envelope.effective_timeout_ms,
    partial_output_available: envelope.partial_output_available,
    resume_possible: envelope.resume_possible,
    session_id: envelope.session_id,
    output_reference_count: envelope.output_references?.length ?? 0,
  };
}

function progressView(state: RunTaskState, elapsedMs: number): RunTaskProgressView {
  const noPublicOutputElapsedMs = state.firstPublicOutputAt === undefined
    ? Math.max(0, elapsedMs)
    : undefined;
  return {
    elapsed_ms: elapsedMs,
    ...(state.lastProgressAt ? { last_progress_at: state.lastProgressAt } : {}),
    ...(state.lastProgressMessage ? { last_progress_message: state.lastProgressMessage } : {}),
    heartbeat_count: state.heartbeatCount,
    active_phase: state.activePhase,
    last_phase_at: state.lastPhaseAt,
    ...(state.lastChildLifecycleEvent ? { last_child_lifecycle_event: state.lastChildLifecycleEvent } : {}),
    ...(state.lastChildLifecycleAt ? { last_child_lifecycle_at: state.lastChildLifecycleAt } : {}),
    ...(state.firstPublicOutputAt ? { first_public_output_at: state.firstPublicOutputAt } : {}),
    ...(noPublicOutputElapsedMs !== undefined ? { no_public_output_elapsed_ms: noPublicOutputElapsedMs } : {}),
    recent_events: state.recentEvents,
    ...(state.lastPublicOutputExcerpt ? { last_public_output_excerpt: state.lastPublicOutputExcerpt } : {}),
  };
}

function terminalProgressView(state: RunTaskState, result: RunTaskTerminalResult): RunTaskProgressView {
  const terminalEvent = terminalRunTaskEventDetails(result);
  const recentEvents = state.recentEvents.some((event) => event.kind === "terminal" && event.event === terminalEvent.event)
    ? state.recentEvents
    : recentEventsProjection([
        ...state.recentEvents,
        {
          kind: "terminal",
          event: terminalEvent.event,
          text: terminalEvent.text,
          occurred_at: state.finishedAt ?? new Date().toISOString(),
          metadata: {
            success: result.success,
            stop_reason: result.stop_reason,
            exit_code: result.exit_code,
            timed_out: result.timed_out,
          },
        },
      ]);
  return {
    ...progressView(state, result.duration_ms),
    active_phase: terminalEvent.phase,
    last_phase_at: state.finishedAt ?? state.lastPhaseAt,
    recent_events: recentEvents,
  };
}

function promotionView(state: RunTaskState): Partial<RunSubagentPromotion> {
  return state.promotion ?? {};
}

function admissionView(state: RunTaskState): Pick<
  RunTaskView,
  "child_started" | "queued_at" | "child_started_at" | "queue_wait_ms" | "client_start_binding"
> {
  return {
    child_started: state.childStarted,
    ...(state.queuedAt ? { queued_at: state.queuedAt } : {}),
    ...(state.queuedAt && state.childStartedAt ? {
      child_started_at: state.childStartedAt,
      queue_wait_ms: Math.max(0, Date.parse(state.childStartedAt) - Date.parse(state.queuedAt)),
    } : {}),
    ...(state.clientStartBinding ? { client_start_binding: state.clientStartBinding } : {}),
  };
}

function lineageView(state: RunTaskState): Pick<
  RunTaskView,
  "parent_run_id" | "root_run_id" | "recursion_depth" | "child_run_ids" | "descendant_run_ids" | "descendant_terminal_statuses"
> {
  return {
    ...(state.parentRunId ? { parent_run_id: state.parentRunId } : {}),
    root_run_id: state.rootRunId,
    recursion_depth: state.recursionDepth,
    child_run_ids: state.childRunIds,
    descendant_run_ids: state.descendantRunIds,
    descendant_terminal_statuses: state.descendantTerminalStatuses,
  };
}

function activeProgressView(state: RunTaskState): RunTaskProgressView {
  return progressView(state, Math.max(0, Date.now() - Date.parse(state.startedAt)));
}

function activationView(state: RunTaskState): Pick<
  RunTaskView,
  "requested_effect_profile" | "resolved_effect_profile" | "expected_skill_sha256" | "activation_receipt" | "skill_snapshot_binding" | "skill_snapshot_activation_receipt" | "requested_recursive_delegation" | "resolved_recursive_delegation" | "recursive_delegation_receipt"
> {
  return {
    ...(state.requestedEffectProfile ? { requested_effect_profile: state.requestedEffectProfile } : {}),
    ...(state.expectedSkillSha256 ? { expected_skill_sha256: state.expectedSkillSha256 } : {}),
    ...(state.activationReceipt
      ? {
          ...(state.activationReceipt.resolved_effect_profile
            ? { resolved_effect_profile: state.activationReceipt.resolved_effect_profile }
            : {}),
          activation_receipt: state.activationReceipt,
        }
      : {}),
    ...(state.skillSnapshotBinding ? { skill_snapshot_binding: state.skillSnapshotBinding } : {}),
    ...(state.skillSnapshotActivationReceipt
      ? { skill_snapshot_activation_receipt: state.skillSnapshotActivationReceipt }
      : {}),
    ...(state.requestedRecursiveDelegation ? { requested_recursive_delegation: state.requestedRecursiveDelegation } : {}),
    ...(state.recursiveDelegationReceipt ? {
      resolved_recursive_delegation: state.recursiveDelegationReceipt.resolved_recursive_delegation,
      recursive_delegation_receipt: state.recursiveDelegationReceipt,
    } : {}),
  };
}

function activeRunTaskView(state: RunTaskState, inputRequests: InputRequestView[]): RunTaskView {
  const hasPendingInput = inputRequests.some((request) => request.status === "pending");
  if (hasPendingInput) {
    setTaskPhase(state, "input_required");
  }
  return {
    ...contractFields(),
    run_id: state.runId,
    task_id: state.runId,
    task_kind: state.taskKind,
    ...lineageView(state),
    ...promotionView(state),
    ...(state.sessionKey ? { session_key: state.sessionKey } : {}),
    status: hasPendingInput
      ? "input_required"
      : "working",
    started_at: state.startedAt,
    input_requests_dir: state.inputRequestsDir,
    input_requests: inputRequests,
    ...admissionView(state),
    ...activeProgressView(state),
    ...activationView(state),
    ...(state.partialOutputPath ? { partial_output_path: state.partialOutputPath } : {}),
  };
}

function setTaskProgress(state: RunTaskState, message: string, heartbeatCount = state.heartbeatCount): void {
  if (state.terminalSnapshotStarted) {
    return;
  }
  state.heartbeatCount = heartbeatCount;
  state.lastProgressAt = new Date().toISOString();
  state.lastProgressMessage = message;
}

async function appendStatusEvent(
  state: RunTaskState,
  event: RunPublicEvent,
  progressMessage = event.text,
): Promise<void> {
  const written = await appendPublicEvent(state, event);
  setTaskProgress(state, progressMessage);
  state.lastProgressAt = written.occurred_at;
}

async function appendChildLifecycleEvent(
  state: RunTaskState,
  event: ChildLifecycleEventName,
  text: string,
  progressMessage: string,
  options: { occurredAt?: string; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  const occurredAt = options.occurredAt ?? new Date().toISOString();
  noteChildLifecycle(state, event, occurredAt);
  await appendStatusEvent(state, {
    kind: "child",
    event,
    text,
    occurred_at: occurredAt,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  }, progressMessage);
}

async function appendPublicEvent(state: RunTaskState, event: RunPublicEvent): Promise<RunPublicEvent> {
  const written = await appendRunPublicEvent(defaultRunTasksDir(), state.runId, event);
  const events = [...state.recentEvents, written];
  state.recentEvents = recentEventsProjection(events);
  state.lastPublicOutputExcerpt = publicOutputExcerptProjection(events);
  return written;
}

function recursiveChildMetadata(child: RunTaskState): Record<string, unknown> {
  return {
    child_run_id: child.runId,
    parent_run_id: child.parentRunId,
    root_run_id: child.rootRunId,
    recursion_depth: child.recursionDepth,
  };
}

async function appendParentRecursiveChildEvent(
  parent: RunTaskState,
  event: RunPublicEvent,
  progressMessage: string,
): Promise<void> {
  if (parent.result || parent.error || parent.terminalSnapshotStarted) {
    await appendPublicEvent(parent, event);
  } else {
    await appendStatusEvent(parent, event, progressMessage);
  }
  await writeTaskSnapshot(await getRunTask(parent.runId));
}

async function appendParentRecursiveChildStartedEvent(child: RunTaskState): Promise<void> {
  if (!child.parentRunId) {
    return;
  }
  const parent = tasks.get(child.parentRunId);
  if (!parent) {
    return;
  }
  const occurredAt = new Date().toISOString();
  await appendParentRecursiveChildEvent(parent, {
    kind: "task",
    event: "recursive_child_started",
    text: `[recursive_child_started] child run ${child.runId}`,
    occurred_at: occurredAt,
    metadata: recursiveChildMetadata(child),
  }, "recursive child started");
}

function terminalStatusForRecursiveChild(child: RunTaskState): RunTaskTerminalStatus {
  if (child.result) {
    return terminalRunTaskStatus(child.result);
  }
  return child.cancelRequested ? "cancelled" : "failed";
}

async function appendParentRecursiveChildFinishedEvent(child: RunTaskState): Promise<void> {
  if (!child.parentRunId) {
    return;
  }
  const parent = tasks.get(child.parentRunId);
  if (!parent) {
    return;
  }
  const status = terminalStatusForRecursiveChild(child);
  const success = child.result?.success ?? false;
  const occurredAt = child.finishedAt ?? new Date().toISOString();
  let ancestorId: string | undefined = child.parentRunId;
  while (ancestorId) {
    const ancestor = tasks.get(ancestorId);
    if (!ancestor) break;
    ancestor.descendantTerminalStatuses = {
      ...ancestor.descendantTerminalStatuses,
      [child.runId]: status,
    };
    ancestorId = ancestor.parentRunId;
  }
  await appendParentRecursiveChildEvent(parent, {
    kind: "task",
    event: "recursive_child_finished",
    text: `[recursive_child_finished] child run ${child.runId} status=${status}`,
    occurred_at: occurredAt,
    metadata: {
      ...recursiveChildMetadata(child),
      status,
      success,
    },
  }, `recursive child ${status}`);
}

async function handleTaskHeartbeat(
  state: RunTaskState,
  beat: number,
  message: string | undefined,
  notify: HeartbeatNotify | undefined,
): Promise<void> {
  const hasPublicOutput = state.firstPublicOutputAt !== undefined;
  const progressMessage = hasPublicOutput
    ? message ?? DEFAULT_HEARTBEAT_MESSAGE
    : "child alive; waiting for first public output";
  if (!hasPublicOutput && (state.activePhase === "awaiting_child_event" || state.activePhase === "running_silent")) {
    setTaskPhase(state, "running_silent");
  } else if (hasPublicOutput && (state.activePhase === "awaiting_child_event" || state.activePhase === "running_silent")) {
    setTaskPhase(state, "running");
  }
  setTaskProgress(state, progressMessage, beat);
  await writeTaskSnapshot(await getRunTask(state.runId));
  await notify?.(beat, progressMessage);
}

async function appendRunStartedEvent(
  state: RunTaskState,
  request: RunSubagentRequest | RunSubagentSessionRequest,
): Promise<void> {
  await appendStatusEvent(state, {
    kind: "task",
    event: "run_started",
    text: `[run_started] ${state.taskKind} ${state.runId}`,
    occurred_at: state.startedAt,
    metadata: {
      task_kind: state.taskKind,
      cwd: typeof request.cwd === "string" ? request.cwd : undefined,
      tool: state.failureLogTool,
    },
  }, DEFAULT_HEARTBEAT_MESSAGE);
  if (typeof request.prompt === "string" && request.prompt.trim() !== "") {
    await appendPublicEvent(state, {
      kind: "user",
      event: "message",
      text: `[user]\n${PUBLIC_PROMPT_REDACTED_MARKER}`,
      occurred_at: state.startedAt,
    });
  }
  const skill = skillBindingForPublicMarker(request);
  if (skill) {
    await appendPublicEvent(state, {
      kind: "task",
      event: "message",
      text: serverContractSkillMarker(skill),
      occurred_at: state.startedAt,
    });
  }
  if ("packet_policy" in request && request.packet_policy && request.packet_policy !== "none") {
    await appendPublicEvent(state, {
      kind: "packet",
      event: "message",
      text: serverContractPacketMarker(request.packet_policy),
      occurred_at: state.startedAt,
    });
  }
}

async function prepareChildRun(state: RunTaskState): Promise<void> {
  const occurredAt = new Date().toISOString();
  setTaskPhase(state, "starting", occurredAt);
  setTaskProgress(state, "preparing child process");
  await writeTaskSnapshot(await getRunTask(state.runId));
}

function bindRequestToRunTaskState(
  state: RunTaskState,
  request: RunSubagentRequest | RunSubagentSessionRequest,
): void {
  state.cwd = typeof request.cwd === "string" ? request.cwd : undefined;
  if ("effect_profile" in request) {
    state.requestedEffectProfile = request.effect_profile;
    state.expectedSkillSha256 = request.expected_skill_sha256;
  }
  if ("skill_snapshot_binding" in request) state.skillSnapshotBinding = request.skill_snapshot_binding;
  if ("recursive_delegation" in request) state.requestedRecursiveDelegation = request.recursive_delegation;
}

async function registerRunTaskState(
  state: RunTaskState,
  request: RunSubagentRequest | RunSubagentSessionRequest,
): Promise<void> {
  ensureOwnerRecordAdmission(state, request);
  bindRequestToRunTaskState(state, request);
  tasks.set(state.runId, state);
  await appendRunStartedEvent(state, request);
  await writeTaskSnapshot(await getRunTask(state.runId));
}

async function recordParentChildRun(state: RunTaskState): Promise<void> {
  if (!state.parentRunId) {
    return;
  }
  const parent = tasks.get(state.parentRunId);
  if (!parent || parent.childRunIds.includes(state.runId)) {
    return;
  }
  parent.childRunIds = [...parent.childRunIds, state.runId];
  let ancestor: RunTaskState | undefined = parent;
  while (ancestor) {
    if (!ancestor.descendantRunIds.includes(state.runId)) {
      ancestor.descendantRunIds = [...ancestor.descendantRunIds, state.runId];
      await writeTaskSnapshot(await getRunTask(ancestor.runId));
    }
    ancestor = ancestor.parentRunId ? tasks.get(ancestor.parentRunId) : undefined;
  }
  await appendParentRecursiveChildStartedEvent(state);
}

async function settleDescendantSubtreeBeforeTerminal(state: RunTaskState): Promise<void> {
  const children = state.childRunIds.map((id) => tasks.get(id)).filter((child): child is RunTaskState => Boolean(child));
  if (children.length === 0) return;
  setTaskProgress(state, "waiting for recursive descendants to settle");
  await writeTaskSnapshot(await getRunTask(state.runId));
  const abnormal = state.cancelRequested || Boolean(state.error) || (state.result !== undefined && !state.result.success);
  if (abnormal) {
    for (const child of children) {
      if (!child.terminalSnapshotStarted) child.abortController.abort();
    }
  }
  await Promise.allSettled(children.map((child) => child.promise));
}

export function lineageForRecursiveDelegate(caller: RecursiveCallerLineage): RunTaskLineage {
  const parent = tasks.get(caller.parentRunId);
  if (!parent) {
    throw new ValidationError(
      `recursive delegate parent run is not active: ${caller.parentRunId}`,
      "recursive_control_invalid",
    );
  }
  if (
    parent.rootRunId !== caller.rootRunId ||
    parent.recursionDepth !== caller.recursionDepth ||
    parent.requestedRecursiveDelegation !== "enabled"
  ) {
    throw new ValidationError(
      "recursive delegate caller lineage does not match the active parent run",
      "recursive_control_invalid",
    );
  }
  return {
    parentRunId: parent.runId,
    rootRunId: parent.rootRunId,
    recursionDepth: parent.recursionDepth + 1,
  };
}

export async function waitForObservedSkillSnapshotActivation(
  runId: string,
): Promise<RunSubagentResult["skill_snapshot_activation_receipt"] | undefined> {
  const state = tasks.get(runId);
  if (!state) return undefined;
  return state.skillSnapshotActivationReceipt ?? state.skillSnapshotActivationObservation.promise;
}

async function registerRunTaskStateWithChildLease(
  state: RunTaskState,
  request: RunSubagentRequest | RunSubagentSessionRequest,
): Promise<ActiveChildLease> {
  const childLease = await acquireActiveChildLease(state.runId);
  try {
    await registerRunTaskState(state, request);
    await recordParentChildRun(state);
    return childLease;
  } catch (error) {
    state.error = error instanceof Error ? error : new Error(String(error));
    await finalizeRegisteredRunTask(state, childLease, "run registration failed");
    throw error;
  }
}

async function registerRunTaskStateWithAdmission(
  state: RunTaskState,
  request: RunSubagentRequest,
  admission: ActiveChildAdmission,
  alreadyRegistered = false,
): Promise<void> {
  try {
    if (admission.kind === "queued") {
      state.queuedAt = admission.ticket.queuedAt;
      setTaskPhase(state, "queued", admission.ticket.queuedAt);
      setTaskProgress(state, "queued; waiting for local child capacity");
    }
    if (alreadyRegistered) {
      if (admission.kind === "queued") await writeTaskSnapshot(await getRunTask(state.runId));
    } else {
      await registerRunTaskState(state, request);
    }
    await recordParentChildRun(state);
  } catch (error) {
    if (!alreadyRegistered) {
      if (admission.kind === "active") {
        await releaseChildLease(admission.lease);
      } else {
        await releaseQueueTicket(admission.ticket);
      }
      tasks.delete(state.runId);
    }
    throw error;
  }
}

async function releaseChildLease(childLease: ActiveChildLease): Promise<boolean> {
  for (const delayMs of [0, 10, 50, 250]) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      await childLease.release();
      return true;
    } catch {
      // Retry before conservatively retaining capacity ownership.
    }
  }
  console.error("[subagent007 warning] active child capacity release could not be confirmed");
  return false;
}

async function releaseQueueTicket(ticket: Extract<ActiveChildAdmission, { kind: "queued" }>["ticket"]): Promise<void> {
  try {
    await ticket.release();
  } catch (error) {
    console.error(`[subagent007 warning] queued run ticket release failed: ${String(error)}`);
  }
}

async function hasDurableTerminalSnapshot(runId: string): Promise<boolean> {
  const snapshot = await readTaskSnapshot(runId).catch(() => null);
  return snapshot !== null && isTerminalRunStatus(snapshot.status);
}

function maybeEvictTerminalTask(state: RunTaskState): void {
  if (!state.terminalSnapshotStarted || !state.capacityReleased) {
    return;
  }
  // Exact input retries are explicitly live-only.  Keep the hashed response
  // identity in this owner process, never in the durable owner record; a
  // restart therefore continues to fail closed.
  if (state.acceptedInputResponses.size > 0) {
    return;
  }
  const hasUnfinishedChild = state.childRunIds.some((childRunId) => {
    const child = tasks.get(childRunId);
    return child !== undefined && (!child.terminalSnapshotStarted || !child.capacityReleased);
  });
  if (!hasUnfinishedChild && tasks.get(state.runId) === state) {
    tasks.delete(state.runId);
  }
}

async function finalizeRegisteredRunTask(
  state: RunTaskState,
  childLease: ActiveChildLease,
  closeReason: string,
): Promise<void> {
  let terminalDurable = false;
  try {
    await settleDescendantSubtreeBeforeTerminal(state);
    await finalizeRunTask(state, closeReason);
    terminalDurable = true;
  } finally {
    terminalDurable ||= await hasDurableTerminalSnapshot(state.runId);
    if (terminalDurable) {
      state.capacityReleased = await releaseChildLease(childLease);
      maybeEvictTerminalTask(state);
      if (state.parentRunId) {
        const parent = tasks.get(state.parentRunId);
        if (parent) {
          maybeEvictTerminalTask(parent);
        }
      }
    }
  }
}

function containBackgroundRunFailure(state: RunTaskState, promise: Promise<void>): Promise<void> {
  return promise.catch(async (error: unknown) => {
    if (await hasDurableTerminalSnapshot(state.runId)) {
      return;
    }
    state.error = error instanceof Error ? error : new Error(String(error));
    state.result = undefined;
    state.finishedAt ??= new Date().toISOString();
    state.terminalizing = true;
    console.error(
      `[subagent007 background failure] run_id=${state.runId} ${state.error.message}`,
    );
  });
}

async function appendClosedInputEvents(
  state: RunTaskState,
  closed: Awaited<ReturnType<typeof closePendingInputRequestsForRun>>,
): Promise<void> {
  for (const request of closed) {
    await appendStatusEvent(state, {
      kind: "input",
      event: "input_closed",
      text: `[input_closed] ${request.request_id}`,
      occurred_at: request.settled_at,
      metadata: {
        request_id: request.request_id,
        status: "closed",
      },
    }, "input request closed");
  }
}

function sawChildProgressPastSpawn(state: RunTaskState): boolean {
  return state.recentEvents.some((event) =>
    event.kind === "child" &&
    (event.event === "child_session_established" || event.event === "child_prompt_submitted")
  );
}

async function logTerminalRunTaskFailure(state: RunTaskState): Promise<void> {
  if (await authoritativeRestartDriftSnapshot(state.runId)) {
    return;
  }
  const result = state.result;
  if (!result || state.taskKind !== "run" || result.success) {
    return;
  }
  const cancelledBeforeFirstOutput =
    result.stop_reason === "cancelled" &&
    state.heartbeatCount > 0 &&
    state.firstPublicOutputAt === undefined &&
    !sawChildProgressPastSpawn(state);
  if (result.stop_reason === "cancelled" && !cancelledBeforeFirstOutput) {
    return;
  }
  const failureClass: FailureClass = cancelledBeforeFirstOutput
    ? "cancelled"
    : result.error_class === "timeout"
      ? "timeout"
      : result.error_class === "resource_exhausted"
        ? "resource_exhausted"
      : result.error_class === "capability_unavailable"
        ? "capability_unavailable"
      : result.error_class === "missing_final_output"
        ? "missing_final_output"
      : result.error_class === "missing_session_id"
        ? "missing_session_id"
        : result.error_class === "nonzero_exit"
          ? "nonzero_exit"
          : failureClassForProcessResult(result);
  const reasonCode: FailureReasonCode = failureClass === "cancelled"
    ? "cancelled_before_first_output"
    : failureClass === "timeout"
      ? "timeout"
      : failureClass === "resource_exhausted"
        ? "disk_reserve_exhausted"
      : failureClass === "missing_session_id"
        ? "missing_session_id"
      : failureClass === "missing_final_output"
          ? "missing_final_output"
          : failureClass === "nonzero_exit" && result.reason_code
            ? result.reason_code
            : failureClass === "nonzero_exit"
              ? "nonzero_exit"
              : failureClass === "capability_unavailable" && result.reason_code
                ? result.reason_code
              : failureClass === "signal_terminated"
                ? "process_signal_terminated"
                : "unknown_error";
  await logFailure({
    tool: state.failureLogTool ?? "run_subagent",
    failure_class: failureClass,
    reason_code: reasonCode,
    cwd: state.cwd,
    run_id: state.runId,
    task_kind: state.taskKind,
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
    stop_reason: result.stop_reason,
    stop_signal: result.stop_signal,
    provider_error_type: result.provider_error_type,
    provider_status_code: result.provider_status_code,
    provider_error_message: result.provider_error_message,
    usage_limit_plan_type: result.usage_limit_plan_type,
    usage_limit_resets_at: result.usage_limit_resets_at,
    usage_limit_resets_in_seconds: result.usage_limit_resets_in_seconds,
    usage_limit_retry_after_seconds: result.usage_limit_retry_after_seconds,
    usage_limit_primary_used_percent: result.usage_limit_primary_used_percent,
    usage_limit_secondary_used_percent: result.usage_limit_secondary_used_percent,
    usage_limit_primary_reset_after_seconds: result.usage_limit_primary_reset_after_seconds,
    usage_limit_secondary_reset_after_seconds: result.usage_limit_secondary_reset_after_seconds,
    ...(state.promotion
      ? {
          auto_promoted_from: state.promotion.auto_promoted_from,
          promotion_reason_code: state.promotion.promotion_reason_code,
          promotion_reason: state.promotion.promotion_reason,
        }
      : {}),
    model_class: result.resolved_model_class,
    skill: result.requested_skill,
    resolved_skill_path: result.resolved_skill_path,
    resolved_skill_sha256: result.resolved_skill_sha256,
    expected_skill_sha256: result.expected_skill_sha256,
    requested_effect_profile: result.requested_effect_profile,
    resolved_effect_profile: result.resolved_effect_profile,
    activation_toolset_sha256: result.activation_receipt?.toolset_sha256,
    output_mode: result.requested_output_mode,
  });
}

async function finalizeRunTask(state: RunTaskState, closeReason: string): Promise<void> {
  await serializeInputMutation(state, async () => {
    state.terminalizing = true;
    state.skillSnapshotActivationObservation.resolve(state.skillSnapshotActivationReceipt);
    rejectPendingInputDeliveries(
      state,
      new ValidationError(`run is not accepting input: ${state.runId}`, "run_not_accepting_input"),
    );
    const preservedRestartDrift = await authoritativeRestartDriftSnapshot(state.runId);
    if (preservedRestartDrift) {
      state.finishedAt = preservedRestartDrift.finished_at ?? new Date().toISOString();
      state.terminalSnapshotStarted = true;
      return;
    }
    state.finishedAt = new Date().toISOString();
    normalizeAcceptedCancellation(state);
    normalizeOwnerTerminalError(state);
    state.childControlSend = undefined;
    // Preserve only hashed receipt identities in this live owner process for
    // exact retries; terminal input staging still compacts after the owner
    // record commits and cannot replay across process loss.
    const closed = await closePendingInputRequestsForRun({
      mailboxRoot: state.mailboxRoot,
      runId: state.runId,
      reason: closeReason,
    });
    await appendClosedInputEvents(state, closed);
    const restartDriftAfterInputClose = await authoritativeRestartDriftSnapshot(state.runId);
    if (restartDriftAfterInputClose) {
      state.finishedAt = restartDriftAfterInputClose.finished_at ?? state.finishedAt;
      state.terminalSnapshotStarted = true;
      return;
    }
    await appendTerminalEvent(state);
    const restartDriftBeforePersist = await authoritativeRestartDriftSnapshot(state.runId);
    if (restartDriftBeforePersist) {
      state.finishedAt = restartDriftBeforePersist.finished_at ?? state.finishedAt;
      state.terminalSnapshotStarted = true;
      return;
    }
    state.terminalInputRequests = await listInputRequests({
      mailboxRoot: state.mailboxRoot,
      runId: state.runId,
    });
    state.terminalSnapshotStarted = true;
    await logTerminalRunTaskFailure(state);
    await writeTaskSnapshot(await getRunTask(state.runId, true));
    await appendParentRecursiveChildFinishedEvent(state);
  });
}

function durableTaskCloseReason(state: RunTaskState): string {
  return state.cancelRequested ? "run cancelled" : "run reached a terminal state";
}

function normalizeAcceptedCancellation(state: RunTaskState): void {
  if (!state.cancelRequested || !state.result) {
    return;
  }
  if (state.result.stop_reason === "cancelled") {
    if (!state.childStarted) {
      // A cancellation accepted before launch belongs to the owner terminal
      // family. It must not retain a process-result envelope because no child
      // was ever started.
      state.result = undefined;
      state.error = new ValidationError("run cancelled before child launch", "local_capacity_exhausted");
    }
    return;
  }
  state.result = {
    ...state.result,
    status: "cancelled",
    success: false,
    timed_out: false,
    stop_reason: "cancelled",
    error_class: undefined,
    reason_code: undefined,
  };
}

function normalizeOwnerTerminalError(state: RunTaskState): void {
  if (!state.error || state.error.message.trim() !== "") return;
  state.error = state.error instanceof ValidationError
    ? new ValidationError("run task failed without an error message", state.error.reasonCode)
    : new Error("run task handler failed");
}

async function logBackgroundHandlerError(
  tool: Extract<FailureLogTool, "run_subagent" | "run_subagent_session" | "schedule_run" | "start_run" | "start_session_run">,
  request: RunSubagentRequest | RunSubagentSessionRequest,
  error: unknown,
): Promise<void> {
  if (error instanceof ValidationError) {
    return;
  }
  await logFailure({
    tool,
    failure_class: "unknown_error",
    reason_code: "handler_error",
    cwd: typeof request.cwd === "string" ? request.cwd : undefined,
    success: false,
  });
}

function packetTerminalEvent(result: RunTaskTerminalResult, occurredAt: string): RunPublicEvent | null {
  if (!("packet_parse_status" in result) || result.packet_parse_status === "not_run") {
    return null;
  }
  const packetAccepted = result.success && result.packet_parse_status === "valid";
  return {
    kind: "packet",
    event: packetAccepted ? "packet_accepted" : "packet_rejected",
    text: packetAccepted
      ? `[packet_accepted] packet_parse_status=${result.packet_parse_status}`
      : `[packet_rejected] packet_parse_status=${result.packet_parse_status}`,
    occurred_at: occurredAt,
    metadata: {
      packet_parse_status: result.packet_parse_status,
      packet_error: result.packet_error,
      committed: result.success,
    },
  };
}

function eventObjectFromJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isProcessControlMarkerLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "[subagent007 cancelled]" || trimmed.startsWith("[subagent007 timeout]");
}

function isStandardChildLifecycleEventName(value: unknown): value is StandardChildLifecycleEventName {
  return value === "child_bridge_started" ||
    value === "child_session_established" ||
    value === "child_prompt_submitted";
}

function childLifecycleFromProcessLine(line: string): {
  event: ChildLifecycleEventName;
  text: string;
  progressMessage: string;
  metadata?: Record<string, unknown>;
} | null {
  const parsed = eventObjectFromJsonLine(line);
  if (!parsed) {
    return null;
  }
  if (parsed.type === "subagent007.session") {
    return {
      event: "child_session_established",
      text: "[child_session_established] Pi session established",
      progressMessage: "Pi session established; waiting for first public output",
      metadata: {
        session_id: typeof parsed.session_id === "string" ? parsed.session_id : null,
        session_file: typeof parsed.session_file === "string" ? parsed.session_file : null,
        pi_session_id: typeof parsed.pi_session_id === "string" ? parsed.pi_session_id : undefined,
      },
    };
  }
  if (parsed.type === "subagent007.activation_confirmed") {
    return {
      event: "activation_confirmed",
      text: "[activation_confirmed] constrained child activation confirmed",
      progressMessage: "constrained activation confirmed before prompt",
    };
  }
  if (parsed.type === "subagent007.skill_snapshot_activation_confirmed") {
    return {
      event: "skill_snapshot_activation_confirmed",
      text: "[skill_snapshot_activation_confirmed] immutable runtime snapshot confirmed",
      progressMessage: "immutable runtime snapshot confirmed before prompt",
    };
  }
  if (parsed.type === "subagent007.recursive_delegation_confirmed") {
    return {
      event: "recursive_delegation_confirmed",
      text: "[recursive_delegation_confirmed] recursive delegation authority confirmed",
      progressMessage: "recursive delegation authority confirmed before prompt",
    };
  }
  if (parsed.type !== "subagent007.lifecycle") {
    return null;
  }
  const event = parsed.event ?? parsed.phase;
  if (!isStandardChildLifecycleEventName(event)) {
    return null;
  }
  switch (event) {
    case "child_bridge_started":
      return {
        event,
        text: "[child_bridge_started] Pi child bridge started",
        progressMessage: "child bridge started; waiting for first public output",
      };
    case "child_prompt_submitted":
      return {
        event,
        text: "[child_prompt_submitted] prompt submitted to Pi session",
        progressMessage: "prompt submitted; waiting for first public output",
      };
    case "child_session_established":
      return {
        event,
        text: "[child_session_established] Pi session established",
        progressMessage: "Pi session established; waiting for first public output",
      };
  }
  return null;
}

/**
 * A child can print a lifecycle marker, but it becomes durable owner evidence
 * only once every declaration that was required before prompting has been
 * independently accepted by its ingress validator.  This keeps a malformed
 * receipt from manufacturing an observed-prompt state that the terminal
 * record would then be unable to prove.
 */
function hasCompletePrePromptOwnerObservations(state: RunTaskState): boolean {
  const activationRequired = state.requestedEffectProfile !== undefined || state.expectedSkillSha256 !== undefined;
  return (!activationRequired || state.activationReceipt !== undefined) &&
    (state.skillSnapshotBinding === undefined || state.skillSnapshotActivationReceipt !== undefined) &&
    state.recursiveDelegationReceipt !== undefined;
}

async function appendTerminalEvent(state: RunTaskState): Promise<void> {
  const result = state.result;
  const occurredAt = state.finishedAt ?? new Date().toISOString();
  if (result) {
    const packetEvent = packetTerminalEvent(result, occurredAt);
    if (packetEvent) {
      await appendStatusEvent(state, {
        ...packetEvent,
      }, packetEvent.event === "packet_accepted" ? "packet accepted" : "packet rejected");
    }
    const terminalEvent = terminalRunTaskEventDetails(result);
    await appendStatusEvent(state, {
      kind: "terminal",
      event: terminalEvent.event,
      text: terminalEvent.text,
      occurred_at: occurredAt,
      metadata: {
        success: result.success,
        stop_reason: result.stop_reason,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
      },
    }, terminalEvent.progressMessage);
    setTaskPhase(state, terminalEvent.phase, occurredAt);
    return;
  }
  if (state.error) {
    const cancelledBeforeLaunch = state.cancelRequested && !state.childStarted;
    const taxonomy = errorTaxonomyForError(state.error);
    const sessionId = sessionIdFromEvents(state.recentEvents);
    const failureEnvelope = syntheticTerminalFailureEnvelope({
      startedAt: state.startedAt,
      finishedAt: occurredAt,
      errorClass: taxonomy.error_class,
      reasonCode: taxonomy.reason_code,
      sessionId,
    });
    const ownerView = {
      ...failureEnvelope,
      status: state.cancelRequested ? "cancelled" : "failed",
      finished_at: occurredAt,
      child_started: state.childStarted,
      last_phase_at: occurredAt,
      ...(cancelledBeforeLaunch ? {} : { error: state.error.message }),
      ...(cancelledBeforeLaunch ? { error_class: undefined, reason_code: undefined } : {}),
    } as RunTaskView;
    const terminalEvent = ownerTerminalEventProjection(ownerView);
    if (!terminalEvent) throw new Error("owner terminal event projection unexpectedly missing");
    await appendStatusEvent(state, terminalEvent, state.cancelRequested ? "run cancelled" : state.error.message);
    setTaskPhase(state, state.cancelRequested ? "cancelled" : "failed", occurredAt);
  }
}

async function observeOutputLine(state: RunTaskState, line: string): Promise<void> {
  const lifecycle = childLifecycleFromProcessLine(line);
  if (lifecycle) {
    if (lifecycle.event === "activation_confirmed" && !state.activationReceipt) {
      return;
    }
    if (lifecycle.event === "skill_snapshot_activation_confirmed" && !state.skillSnapshotActivationReceipt) {
      return;
    }
    if (lifecycle.event === "recursive_delegation_confirmed" && !state.recursiveDelegationReceipt) {
      return;
    }
    if (lifecycle.event === "child_prompt_submitted" && !hasCompletePrePromptOwnerObservations(state)) {
      return;
    }
    const occurredAt = new Date().toISOString();
    if (state.activePhase === "awaiting_child_event" || state.activePhase === "running_silent") {
      setTaskPhase(state, "running_silent", occurredAt);
    }
    await appendChildLifecycleEvent(
      state,
      lifecycle.event,
      lifecycle.text,
      lifecycle.progressMessage,
      {
        occurredAt,
        ...(lifecycle.event === "activation_confirmed" && state.activationReceipt
          ? { metadata: { receipt: state.activationReceipt } }
          : lifecycle.event === "skill_snapshot_activation_confirmed" && state.skillSnapshotActivationReceipt
            ? { metadata: { receipt: state.skillSnapshotActivationReceipt } }
          : lifecycle.event === "recursive_delegation_confirmed" && state.recursiveDelegationReceipt
            ? { metadata: { receipt: state.recursiveDelegationReceipt } }
          : lifecycle.metadata
            ? { metadata: lifecycle.metadata }
            : {}),
      },
    );
    await writeTaskSnapshot(await getRunTask(state.runId));
    return;
  }
  const publicLine = publicOutputLineFromProcessLine(line);
  if (!publicLine) {
    if (line.trim() !== "" && !isProcessControlMarkerLine(line) && !eventObjectFromJsonLine(line)) {
      const occurredAt = new Date().toISOString();
      noteFirstPublicOutput(state, occurredAt);
      if (state.activePhase === "awaiting_child_event" || state.activePhase === "running_silent") {
        setTaskPhase(state, "running", occurredAt);
      }
      setTaskProgress(state, "child output received");
      await writeTaskSnapshot(await getRunTask(state.runId));
    }
    return;
  }
  if (publicLine.kind === "user") {
    return;
  }
  const occurredAt = new Date().toISOString();
  noteFirstPublicOutput(state, occurredAt);
  if (publicLine.event === "input_required") {
    setTaskPhase(state, "input_required", occurredAt);
  } else if (publicLine.kind === "assistant" || publicLine.kind === "warning" || publicLine.kind === "error") {
    setTaskPhase(state, "running", occurredAt);
  } else if (publicLine.event === "input_timed_out" || publicLine.event === "input_closed") {
    setTaskPhase(state, "running", occurredAt);
  }
  await appendPublicEvent(state, {
    kind: publicLine.kind,
    event: publicLine.event ?? "message",
    text: publicLine.text,
    occurred_at: occurredAt,
  });
  if (publicLine.event === "input_required") {
    setTaskProgress(state, "input required");
  } else if (publicLine.event === "input_timed_out") {
    setTaskProgress(state, "input timed out");
  } else if (publicLine.event === "input_closed") {
    setTaskProgress(state, "input request closed");
  }
  await writeTaskSnapshot(await getRunTask(state.runId));
}

function taskChildRuntimeOptions(
  state: RunTaskState,
  options: { heartbeat?: HeartbeatNotify; heartbeatIntervalMs?: number },
): {
  heartbeat: HeartbeatNotify;
  heartbeatIntervalMs?: number;
  abortSignal: AbortSignal;
  onOutputLine: (line: string) => Promise<void>;
  onTranscriptStaged: (stagingPath: string) => Promise<void>;
  onChildSpawned: () => Promise<void>;
  onActivationConfirmed: (receipt: NonNullable<RunSubagentResult["activation_receipt"]>) => void;
  onSkillSnapshotActivationConfirmed: (receipt: NonNullable<RunSubagentResult["skill_snapshot_activation_receipt"]>) => void;
  onRecursiveDelegationConfirmed: (receipt: RecursiveDelegationReceipt) => void;
  onOwnerLaunchObservation: (observation: unknown) => Promise<void>;
} {
  return {
    heartbeat: (beat, message) => handleTaskHeartbeat(state, beat, message, options.heartbeat),
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    abortSignal: state.abortController.signal,
    onOutputLine: (line) => observeOutputLine(state, line),
    onActivationConfirmed: (receipt) => {
      state.activationReceipt = receipt;
    },
    onSkillSnapshotActivationConfirmed: (receipt) => {
      state.skillSnapshotActivationReceipt = receipt;
      state.skillSnapshotActivationObservation.resolve(receipt);
    },
    onRecursiveDelegationConfirmed: (receipt) => {
      state.recursiveDelegationReceipt = receipt;
    },
    onOwnerLaunchObservation: async (observation) => {
      recordOwnerLaunchObservation(state, observation as Parameters<typeof recordOwnerLaunchObservation>[1]);
      // This commit is deliberately before writeChildRequestFile/runChildProcess.
      // The child and terminal validator use the same captured scope carried
      // by runSubagentCore, while the owner record retains its independent
      // canonical binding for recovery/readback.
      await writeTaskSnapshot(await getRunTask(state.runId));
    },
    onTranscriptStaged: async (stagingPath) => {
      state.partialOutputPath = stagingPath;
      await writeTaskSnapshot(await getRunTask(state.runId));
    },
    onChildSpawned: async () => {
      const occurredAt = new Date().toISOString();
      state.childStarted = true;
      if (state.queuedAt) {
        state.childStartedAt = occurredAt;
      }
      setTaskPhase(state, "running_silent", occurredAt);
      await appendChildLifecycleEvent(
        state,
        "child_spawned",
        "[child_spawned] Pi child process started",
        "child process running; waiting for first public output",
        { occurredAt },
      );
      await writeTaskSnapshot(await getRunTask(state.runId));
    },
  };
}

function taskInputControlOptions(state: RunTaskState): {
  onChildControlReady: (send: (message: string) => boolean) => void;
  onInputResponseAccepted: (response: { requestId: string; responseId: string }) => void;
} {
  return {
    onChildControlReady: (send) => {
      state.childControlSend = send;
    },
    onInputResponseAccepted: (response) => {
      settleChildAcceptedInputResponse(state, response);
    },
  };
}

function taskRecursiveRuntimeOptions(state: RunTaskState): {
  rootRunId: string;
  recursionDepth: number;
} {
  return {
    rootRunId: state.rootRunId,
    recursionDepth: state.recursionDepth,
  };
}

async function loadSnapshotEvents(
  snapshot: RunTaskView,
): Promise<Pick<RunTaskView, "recent_events" | "last_public_output_excerpt">> {
  const events = await readRunPublicEvents(defaultRunTasksDir(), snapshot.run_id);
  if (events.length === 0) {
    return {
      ...(snapshot.recent_events ? { recent_events: snapshot.recent_events } : {}),
      ...(snapshot.last_public_output_excerpt
        ? { last_public_output_excerpt: snapshot.last_public_output_excerpt }
        : {}),
    };
  }
  const lastPublicOutputExcerpt = publicOutputExcerptProjection(events);
  return {
    recent_events: recentEventsProjection(events),
    ...(lastPublicOutputExcerpt
      ? { last_public_output_excerpt: lastPublicOutputExcerpt }
      : {}),
  };
}

function eventsForFailureLog(
  snapshot: Pick<RunTaskView, "recent_events">,
  eventProjection: Pick<RunTaskView, "recent_events">,
): RunPublicEvent[] {
  return [
    ...(snapshot.recent_events ?? []),
    ...(eventProjection.recent_events ?? []),
  ];
}

function isRunTaskFailureLogTool(value: unknown): value is RunTaskFailureLogTool {
  return value === "run_subagent" ||
    value === "schedule_run" ||
    value === "start_run" ||
    value === "start_session_run" ||
    value === "run_subagent_session";
}

function failureLogToolFromRunEvents(
  events: RunPublicEvent[],
  taskKind: RunTaskView["task_kind"],
): RunTaskFailureLogTool {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event !== "run_started") {
      continue;
    }
    const tool = event.metadata?.tool;
    if (isRunTaskFailureLogTool(tool)) {
      return tool;
    }
  }
  return taskKind === "session" ? "start_session_run" : "start_run";
}

function isRestartDriftSnapshot(snapshot: RunTaskView): boolean {
  return snapshot.status === "failed" &&
    snapshot.error_class === "restart_drift" &&
    snapshot.reason_code === "server_restarted_active_run";
}

async function authoritativeRestartDriftSnapshot(runId: string): Promise<RunTaskView | null> {
  const snapshot = await readTaskSnapshot(runId);
  if (!snapshot || !isRestartDriftSnapshot(snapshot)) {
    return null;
  }
  return snapshot;
}

async function persistRestartDriftSnapshot(
  snapshot: RunTaskView,
  eventProjection: Pick<RunTaskView, "recent_events" | "last_public_output_excerpt">,
): Promise<RunTaskView> {
  const finishedAt = new Date().toISOString();
  const sessionEvents = eventsForFailureLog(snapshot, eventProjection);
  const sessionId = snapshot.session_id ?? sessionIdFromEvents(sessionEvents);
  const recoveredOutput = snapshot.output_path || !snapshot.partial_output_path
    ? undefined
    : await recoverStreamingRunTranscript(snapshot.partial_output_path, snapshot.run_id);
  const outputPath = snapshot.output_path ?? recoveredOutput?.outputPath;
  const outputReferences = snapshot.output_references?.length
    ? snapshot.output_references
    : recoveredOutput
      ? [runOutputReference(recoveredOutput.outputPath, recoveredOutput.sizeBytes, "transcript")]
      : [];
  const failureEnvelope = syntheticTerminalFailureEnvelope({
    startedAt: snapshot.started_at,
    finishedAt,
    errorClass: "restart_drift",
    reasonCode: "server_restarted_active_run",
    sessionId,
    sessionEstablished: snapshot.session_established ?? sessionId !== null,
    outputPath,
    outputReferences,
    // Restart drift owns the recovered-output projection.  An inherited
    // durable output is equally partial diagnostic output after owner loss.
    partialOutputAvailable: outputPath !== undefined,
  });
  const mailboxRoot = path.dirname(snapshot.input_requests_dir);
  await closePendingInputRequestsForRun({
    mailboxRoot,
    runId: snapshot.run_id,
    reason: "MCP server restarted while run was active",
  });
  await appendRunPublicEvent(defaultRunTasksDir(), snapshot.run_id, {
    kind: "terminal",
    event: "failed",
    text: "[failed] run is not active after MCP server restart",
    occurred_at: finishedAt,
    metadata: syntheticTerminalFailureEventMetadata(failureEnvelope),
  });
  const inputRequests = await listInputRequests({ mailboxRoot, runId: snapshot.run_id });
  const stagedEvents = await loadSnapshotEvents(snapshot);
  // A JSONL child event may have reached staging immediately before a process
  // crash, while the owner record still truthfully says that no child launch
  // was committed.  Staging is not coequal owner evidence, so it must not be
  // replayed into the owner-terminal view as a launch observation.
  const restartEvents = snapshot.child_started === false
    ? stagedEvents.recent_events?.filter((event) => event.kind !== "child") ?? []
    : stagedEvents.recent_events ?? [];
  const events: Pick<RunTaskView, "recent_events" | "last_public_output_excerpt"> = {
    recent_events: restartEvents,
    ...(restartEvents.length > 0
      ? { last_public_output_excerpt: publicOutputExcerptProjection(restartEvents) }
      : {}),
  };
  const staleView: RunTaskView = {
    ...normalizeHistoricalSnapshotForRepublication(snapshot),
    ...eventProjection,
    ...events,
    status: "failed",
    finished_at: snapshot.finished_at ?? finishedAt,
    active_phase: "failed",
    last_phase_at: finishedAt,
    input_requests: inputRequests,
    ...failureEnvelope,
    partial_output_path: undefined,
    error: "run is not active in this MCP server process; the server may have restarted",
  };
  await logFailure({
    tool: failureLogToolFromRunEvents(sessionEvents, snapshot.task_kind),
    failure_class: "restart_drift",
    reason_code: "server_restarted_active_run",
    cwd: cwdFromRunStartedEvent(sessionEvents),
    run_id: snapshot.run_id,
    task_kind: snapshot.task_kind,
    output_path: staleView.output_path,
    session_key: snapshot.session_key,
    success: false,
    exit_code: null,
    timed_out: false,
    partial_output_available: staleView.partial_output_available,
    resume_possible: false,
    duration_ms: staleView.duration_ms,
    requested_timeout_ms: staleView.requested_timeout_ms,
    resolved_timeout_ms: staleView.resolved_timeout_ms,
    timeout_floor_ms: staleView.timeout_floor_ms,
    effective_timeout_ms: staleView.effective_timeout_ms,
    timeout_headroom_ms: staleView.timeout_headroom_ms,
    kill_grace_ms: staleView.kill_grace_ms,
    force_grace_ms: staleView.force_grace_ms,
    stop_reason: "failed",
    stop_signal: null,
    model_class: staleView.resolved_model_class,
    skill: staleView.requested_skill,
    output_mode: staleView.requested_output_mode,
  });
  await writeTaskSnapshot(staleView);
  return staleView;
}

function persistRestartDriftSnapshotOnce(
  snapshot: RunTaskView,
  eventProjection: Pick<RunTaskView, "recent_events" | "last_public_output_excerpt">,
): Promise<RunTaskView> {
  const existing = restartDriftReconciliations.get(snapshot.run_id);
  if (existing) {
    return existing;
  }
  const reconciliation = persistRestartDriftSnapshot(snapshot, eventProjection).finally(() => {
    restartDriftReconciliations.delete(snapshot.run_id);
  });
  restartDriftReconciliations.set(snapshot.run_id, reconciliation);
  return reconciliation;
}

async function clientStartSnapshotOwnerLiveness(
  snapshot: RunTaskView,
): Promise<"live" | "gone" | "unknown" | null> {
  if (!snapshot.client_start_binding) return null;
  try {
    const admission = await resolveClientStartAdmissionBinding(snapshot.client_start_binding);
    return await clientStartAdmissionOwnerLiveness(admission);
  } catch {
    return "unknown";
  }
}

function persistedActiveRunView(
  snapshot: RunTaskView,
  eventProjection: Pick<RunTaskView, "recent_events" | "last_public_output_excerpt">,
  inputRequests: InputRequestView[],
): RunTaskView {
  return {
    ...contractFields(),
    ...snapshot,
    ...eventProjection,
    input_requests: inputRequests,
  };
}

export async function getRunTask(runId: string, allowUnreleasedTerminal = false): Promise<RunTaskView> {
  const state = tasks.get(runId);
  if (!state) {
    let snapshot = await readTaskSnapshot(runId);
    if (!snapshot) {
      await reconcilePreparedClientStartCandidates();
      snapshot = await readTaskSnapshot(runId);
    }
    if (!snapshot) {
      throw taskNotFound(runId);
    }
    const mailboxRoot = path.dirname(snapshot.input_requests_dir);
    const inputRequests = await listInputRequests({ mailboxRoot, runId });
    const eventProjection = await loadSnapshotEvents(snapshot);
    if (snapshot.status === "working" || snapshot.status === "input_required") {
      const clientStartOwnerLiveness = await clientStartSnapshotOwnerLiveness(snapshot);
      if (clientStartOwnerLiveness === "live") {
        return persistedActiveRunView(snapshot, eventProjection, inputRequests);
      }
      if (clientStartOwnerLiveness === "unknown") {
        throw new ValidationError(
          "run liveness is unknown because its client_start_id owner binding cannot be verified",
          "run_liveness_unknown",
        );
      }
      if (clientStartOwnerLiveness === null) {
        const leaseLiveness = await activeChildLeaseLiveness(runId);
        if (leaseLiveness === "live" || await hasLiveQueuedRunTicket(runId)) {
          return persistedActiveRunView(snapshot, eventProjection, inputRequests);
        }
        if (leaseLiveness === "unknown") {
          throw new ValidationError(
            "run liveness is unknown because a legacy active-child lease is unreadable",
            "run_liveness_unknown",
          );
        }
      }
      const descendantTerminalStatuses = { ...(snapshot.descendant_terminal_statuses ?? {}) };
      for (const descendantRunId of snapshot.descendant_run_ids ?? []) {
        const descendant = await getRunTask(descendantRunId);
        if (descendant && !isTerminalRunStatus(descendant.status)) {
          return persistedActiveRunView(snapshot, eventProjection, inputRequests);
        }
        if (descendant && isTerminalRunStatus(descendant.status)) {
          descendantTerminalStatuses[descendantRunId] = descendant.status as RunTaskTerminalStatus;
        }
      }
      snapshot = { ...snapshot, descendant_terminal_statuses: descendantTerminalStatuses };
      return persistRestartDriftSnapshotOnce(
        { ...contractFields(), ...snapshot, input_requests: inputRequests },
        eventProjection,
      );
    }
    return {
      ...contractFields(),
      ...snapshot,
      ...eventProjection,
      input_requests: snapshot.input_requests ?? inputRequests,
    };
  }
  const inputRequests = state.terminalInputRequests ?? await listInputRequests({
    mailboxRoot: state.mailboxRoot,
    runId: state.runId,
  });
  if (
    (state.result || state.error) &&
    (!state.terminalSnapshotStarted || (!state.capacityReleased && !allowUnreleasedTerminal))
  ) {
    return activeRunTaskView(state, inputRequests);
  }
  if (state.result) {
    return {
      ...contractFields(),
      ...state.result,
      ...promotionView(state),
      ...activationView(state),
      run_id: state.runId,
      task_id: state.runId,
      task_kind: state.taskKind,
      ...lineageView(state),
      status: terminalRunTaskStatus(state.result),
      started_at: state.startedAt,
      finished_at: state.finishedAt,
      input_requests_dir: state.inputRequestsDir,
      input_requests: inputRequests,
      ...admissionView(state),
      ...terminalProgressView(state, state.result),
    };
  }
  if (state.error) {
    const cancelledBeforeLaunch = state.cancelRequested && !state.childStarted;
    const taxonomy = errorTaxonomyForError(state.error);
    const sessionId = sessionIdFromEvents(state.recentEvents);
    const failureEnvelope = syntheticTerminalFailureEnvelope({
      startedAt: state.startedAt,
      finishedAt: state.finishedAt ?? new Date().toISOString(),
      errorClass: taxonomy.error_class,
      reasonCode: taxonomy.reason_code,
      sessionId,
    });
    return {
      ...contractFields(),
      run_id: state.runId,
      task_id: state.runId,
      task_kind: state.taskKind,
      ...lineageView(state),
      ...promotionView(state),
      ...activationView(state),
      ...(state.sessionKey ? { session_key: state.sessionKey } : {}),
      status: state.cancelRequested ? "cancelled" : "failed",
      started_at: state.startedAt,
      finished_at: state.finishedAt,
      input_requests_dir: state.inputRequestsDir,
      input_requests: inputRequests,
      ...admissionView(state),
      ...failureEnvelope,
      ...(cancelledBeforeLaunch ? { error_class: undefined, reason_code: undefined } : {}),
      ...activeProgressView(state),
      ...(cancelledBeforeLaunch ? {} : { error: state.error.message }),
    };
  }
  return activeRunTaskView(state, inputRequests);
}

export async function reconcilePersistedActiveRunTasks(): Promise<number> {
  await reconcileRunTaskSnapshotTemps();
  const runTasksDir = defaultRunTasksDir();
  const entries = await fs.readdir(runTasksDir).catch(() => []);
  let reconciled = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const runId = entry.slice(0, -".json".length);
    const snapshot = await readTaskSnapshot(runId).catch(() => null);
    if (snapshot?.status !== "working" && snapshot?.status !== "input_required") {
      continue;
    }
    const clientStartOwnerLiveness = await clientStartSnapshotOwnerLiveness(snapshot);
    if (clientStartOwnerLiveness === "live" || clientStartOwnerLiveness === "unknown") {
      continue;
    }
    if (clientStartOwnerLiveness === null) {
      const leaseLiveness = await activeChildLeaseLiveness(runId);
      if (leaseLiveness === "live" || await hasLiveQueuedRunTicket(runId)) {
        continue;
      }
      if (leaseLiveness === "unknown") {
        continue;
      }
    }
    await getRunTask(runId);
    reconciled += 1;
  }
  const completionPath = process.env.SUBAGENT007_TEST_RECONCILIATION_COMPLETE_PATH;
  if (completionPath) await fs.writeFile(completionPath, "complete\n", { flag: "wx" });
  return reconciled;
}

function executeRunTask(
  state: RunTaskState,
  request: RunSubagentRequest,
  skillFilePath: string | undefined,
  options: { runsDir?: string; heartbeat?: HeartbeatNotify; heartbeatIntervalMs?: number },
): Promise<RunSubagentResult> {
  return runSubagentCore(request, {
    runId: state.runId,
    mailboxRoot: state.mailboxRoot,
    runsDir: options.runsDir,
    allowTimeout: true,
    skillFilePath,
    ...taskRecursiveRuntimeOptions(state),
    ...taskChildRuntimeOptions(state, options),
    ...taskInputControlOptions(state),
  });
}

async function replayClientStartAdmission(
  admission: import("./clientStartAdmission.js").ClientStartAdmission,
  request: StartRunTaskRequest,
  failureLogTool: Extract<FailureLogTool, "schedule_run" | "start_run">,
  lineage?: RunTaskLineage,
): Promise<RunTaskView> {
  if (tasks.has(admission.binding.run_id)) {
    return getRunTask(admission.binding.run_id);
  }
  let ownerLiveness = await clientStartAdmissionOwnerLiveness(admission);
  let snapshot = await readTaskSnapshot(admission.binding.run_id);
  if (!snapshot) {
    await waitAtClientStartReplayAfterTargetMissTestBarrier(admission.binding.client_start_id);
    try {
      snapshot = await promotePreparedClientStartCandidate(admission);
    } catch (error) {
      ownerLiveness = await clientStartAdmissionOwnerLiveness(admission);
      if (ownerLiveness !== "gone") throw error;
    }
  }
  if (snapshot) {
    if (
      snapshot.client_start_binding?.client_start_id !== admission.binding.client_start_id ||
      snapshot.client_start_binding.request_sha256 !== admission.binding.request_sha256 ||
      snapshot.client_start_binding.run_id !== admission.binding.run_id
    ) {
      throw new ValidationError(
        "client_start_id run snapshot does not match its durable admission binding",
        "client_start_id_conflict",
      );
    }
    ownerLiveness = await clientStartAdmissionOwnerLiveness(admission);
    if (ownerLiveness === "live") return snapshot;
    if (ownerLiveness === "unknown") {
      throw new ValidationError(
        "client_start_id owner process instance liveness is unknown",
        "run_liveness_unknown",
      );
    }
    return getRunTask(admission.binding.run_id);
  }
  ownerLiveness = await clientStartAdmissionOwnerLiveness(admission);
  if (ownerLiveness === "unknown") {
    throw new ValidationError(
      "client_start_id owner process instance liveness is unknown",
      "run_liveness_unknown",
    );
  }
  if (ownerLiveness === "live") {
    throw new ValidationError(
      "client_start_id durable admission binding has no matching run snapshot",
      "client_start_id_conflict",
    );
  }
  const recovered = createRunTaskState(
    "run",
    undefined,
    lineage,
    admission.binding.run_id,
    admission.binding,
    admission.admitted_at,
  );
  recovered.failureLogTool = failureLogTool;
  await registerRunTaskState(recovered, request);
  tasks.delete(recovered.runId);
  return getRunTask(recovered.runId);
}

async function waitAtClientStartPromotionTestBarrier(clientStartId: string): Promise<void> {
  const barrier = process.env.SUBAGENT007_TEST_CLIENT_START_PROMOTION_BARRIER;
  if (!barrier) return;
  await fs.writeFile(`${barrier}.ready`, `${clientStartId}\n`, { flag: "wx" });
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await fs.stat(`${barrier}.continue`).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("client-start promotion test barrier was not released");
}

async function waitAtClientStartPromotionAfterReadTestBarrier(clientStartId: string): Promise<void> {
  const barrier = process.env.SUBAGENT007_TEST_CLIENT_START_PROMOTION_AFTER_READ_BARRIER;
  if (!barrier) return;
  await fs.writeFile(`${barrier}.ready`, `${clientStartId}\n`, { flag: "wx" });
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await fs.stat(`${barrier}.continue`).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("client-start promotion-after-read test barrier was not released");
}

async function waitAtClientStartReplayAfterTargetMissTestBarrier(clientStartId: string): Promise<void> {
  const barrier = process.env.SUBAGENT007_TEST_CLIENT_START_REPLAY_AFTER_TARGET_MISS_BARRIER;
  if (!barrier) return;
  await fs.writeFile(`${barrier}.ready`, `${clientStartId}\n`, { flag: "wx" });
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await fs.stat(`${barrier}.continue`).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("client-start replay-after-target-miss test barrier was not released");
}

async function terminalizeClaimedClientStartFailure(
  state: RunTaskState,
  request: StartRunTaskRequest,
  admission: ClientStartAdmission,
  preparedCandidatePath: string,
  childAdmission: ActiveChildAdmission | undefined,
  error: unknown,
): Promise<RunTaskView> {
  const existing = await readTaskSnapshot(state.runId);
  if (existing) {
    validateClientStartSnapshotBinding(existing, admission);
    if (isTerminalRunStatus(existing.status)) {
      if (childAdmission?.kind === "active") {
        await releaseChildLease(childAdmission.lease);
      } else if (childAdmission?.kind === "queued") {
        await releaseQueueTicket(childAdmission.ticket);
      }
      await discardPreparedClientStartCandidate(preparedCandidatePath);
      return getRunTask(state.runId);
    }
  }

  state.error = error instanceof Error ? error : new Error(String(error));
  state.result = undefined;
  if (tasks.get(state.runId) !== state) {
    if (state.recentEvents.some((event) => event.event === "run_started")) {
      tasks.set(state.runId, state);
    } else {
      await registerRunTaskState(state, request);
    }
  }

  const childLease = childAdmission?.kind === "active"
    ? childAdmission.lease
    : { release: async () => {} };
  await finalizeRegisteredRunTask(state, childLease, "client start admission failed");
  if (childAdmission?.kind === "queued") {
    await releaseQueueTicket(childAdmission.ticket);
  }
  if (!await hasDurableTerminalSnapshot(state.runId)) {
    throw new Error(`client-start admission failure was not durably terminalized: ${state.runId}`);
  }
  await discardPreparedClientStartCandidate(preparedCandidatePath);
  return getRunTask(state.runId);
}

export async function startRunTask(
  request: StartRunTaskRequest,
  options: {
    runsDir?: string;
    heartbeat?: HeartbeatNotify;
    heartbeatIntervalMs?: number;
    failureLogTool?: Extract<FailureLogTool, "schedule_run" | "start_run">;
    lineage?: RunTaskLineage;
  } = {},
): Promise<RunTaskView> {
  const failureLogTool = options.failureLogTool ?? "start_run";
  const replayAdmission = await findClientStartAdmission(request);
  if (replayAdmission) {
    return replayClientStartAdmission(replayAdmission, request, failureLogTool, options.lineage);
  }
  const config = await loadConfig();
  const resolved = await validateAndResolveRequest(request, config);
  assertDeadlineRiskTimeoutBudget(request, resolved, failureLogTool);
  const snapshotPreflight = await assertSkillSnapshotBinding(resolved);
  const skillFilePath = snapshotPreflight?.receipt.resolved_skill_path ?? resolveSkillFilePathForRequest(resolved);
  await assertExpectedSkillBinding(resolved, skillFilePath);
  const childEntrypoint = await assertPiChildEntrypointAvailable();
  await expectedBoundedActivationToolBindings({
    resolved,
    snapshotActivation: snapshotPreflight,
    childEntrypoint,
  });
  await assertDiskReserveAvailable(options.runsDir);

  let clientStartAdmission: Awaited<ReturnType<typeof claimClientStartAdmission>>;
  let state!: RunTaskState;
  let registeredBeforeAdmission = false;
  let preparedCandidatePath: string | undefined;
  let childAdmission: ActiveChildAdmission | undefined;
  let ownsClaimedClientStart = false;
  let ownershipTransferred = false;
  try {
    if (request.client_start_id !== undefined) {
    await assertNoOrphanedClientStartSnapshot(request.client_start_id);
    if (process.env.SUBAGENT007_TEST_EXIT_BEFORE_CLIENT_START_PREPARE === request.client_start_id) {
      process.exit(87);
    }
    const admittedAt = new Date().toISOString();
    const candidateBinding: ClientStartBinding = {
      client_start_id: request.client_start_id,
      request_sha256: canonicalClientStartRequestSha256(request),
      run_id: newRunId(),
    };
    state = createRunTaskState(
      "run",
      undefined,
      options.lineage,
      candidateBinding.run_id,
      candidateBinding,
      admittedAt,
    );
    state.failureLogTool = failureLogTool;
    setTaskProgress(state, "preparing durable client start admission");
    preparedCandidatePath = await writePreparedClientStartCandidate(state, request);
    if (process.env.SUBAGENT007_TEST_EXIT_BEFORE_CLIENT_START_CLAIM === request.client_start_id) {
      process.exit(89);
    }
    try {
      clientStartAdmission = await claimClientStartAdmission(request, {
        run_id: state.runId,
        admitted_at: state.startedAt,
      });
    } catch (error) {
      await discardPreparedClientStartCandidate(preparedCandidatePath);
      throw error;
    }
    if (!clientStartAdmission?.created) {
      await discardPreparedClientStartCandidate(preparedCandidatePath);
      if (!clientStartAdmission) throw new Error("client_start_id admission unexpectedly missing");
      return replayClientStartAdmission(clientStartAdmission, request, failureLogTool, options.lineage);
    }
    ownsClaimedClientStart = true;
    if (process.env.SUBAGENT007_TEST_EXIT_AFTER_CLIENT_START_BINDING === request.client_start_id) {
      process.exit(88);
    }
    if (process.env.SUBAGENT007_TEST_THROW_AFTER_CLIENT_START_BINDING === request.client_start_id) {
      throw new Error("injected recoverable client-start post-binding failure");
    }
    await waitAtClientStartPromotionTestBarrier(request.client_start_id);
    await promotePreparedClientStartCandidate(clientStartAdmission);
    if (process.env.SUBAGENT007_TEST_EXIT_AFTER_CLIENT_START_PROMOTION === request.client_start_id) {
      process.exit(86);
    }
    } else {
    clientStartAdmission = undefined;
    state = createRunTaskState("run", undefined, options.lineage);
    state.failureLogTool = failureLogTool;
    }
    if (clientStartAdmission) {
      await registerRunTaskState(state, request);
      registeredBeforeAdmission = true;
    }
    childAdmission = await admitActiveChild(state.runId, options.lineage?.parentRunId === undefined);
    await registerRunTaskStateWithAdmission(state, request, childAdmission, registeredBeforeAdmission);
    if (state.cancelRequested) {
      throw new ValidationError("run cancelled before child launch", "local_capacity_exhausted");
    }

  if (childAdmission.kind === "queued") {
    const queuedAdmission = childAdmission;
    state.promise = containBackgroundRunFailure(state, (async () => {
      let childLease: ActiveChildLease = { release: async () => {} };
      try {
        childLease = await queuedAdmission.ticket.waitForLease(state.abortController.signal);
        if (state.cancelRequested) {
          throw new ValidationError("run cancelled before child launch", "local_capacity_exhausted");
        }
        await assertPiChildEntrypointAvailable();
        await assertDiskReserveAvailable(options.runsDir);
        await prepareChildRun(state);
        state.result = await executeRunTask(state, request, skillFilePath, options);
      } catch (error) {
        state.error = error as Error;
        await logBackgroundHandlerError(failureLogTool, request, error);
      } finally {
        await releaseQueueTicket(queuedAdmission.ticket);
        await finalizeRegisteredRunTask(state, childLease, durableTaskCloseReason(state));
      }
    })());
    ownershipTransferred = true;
    return getRunTask(state.runId);
  }

  const childLease = childAdmission.lease;
  try {
    await prepareChildRun(state);
  } catch (error) {
    if (ownsClaimedClientStart) throw error;
    state.error = error as Error;
    await logBackgroundHandlerError(failureLogTool, request, error);
    await finalizeRegisteredRunTask(state, childLease, durableTaskCloseReason(state));
    return getRunTask(state.runId);
  }

  state.promise = containBackgroundRunFailure(state, (async () => {
    try {
      state.result = await executeRunTask(state, request, skillFilePath, options);
    } catch (error) {
      state.error = error as Error;
      await logBackgroundHandlerError(failureLogTool, request, error);
    } finally {
      await finalizeRegisteredRunTask(state, childLease, durableTaskCloseReason(state));
    }
  })());

  ownershipTransferred = true;
  return getRunTask(state.runId);
  } catch (error) {
    if (
      !ownsClaimedClientStart
      || ownershipTransferred
      || !clientStartAdmission?.created
      || !preparedCandidatePath
    ) {
      throw error;
    }
    return terminalizeClaimedClientStartFailure(
      state,
      request,
      clientStartAdmission,
      preparedCandidatePath,
      childAdmission,
      error,
    );
  }
}

function scheduleWaitMs(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_SCHEDULE_WAIT_MS;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new ValidationError("wait_ms must be a nonnegative integer when provided", "invalid_wait_ms");
  }
  return value;
}

function maxScheduleWaitMs(): number {
  return safeIntegerFromEnv(SCHEDULE_MAX_WAIT_ENV, DEFAULT_SCHEDULE_MAX_WAIT_MS, 0);
}

function scheduleWaitPolicy(requestedWaitMs: number): {
  requestedWaitMs: number;
  effectiveWaitMs: number;
  waitTruncated: boolean;
} {
  const effectiveWaitMs = Math.min(requestedWaitMs, maxScheduleWaitMs());
  return {
    requestedWaitMs,
    effectiveWaitMs,
    waitTruncated: effectiveWaitMs !== requestedWaitMs,
  };
}

function withScheduleWaitMetadata(
  view: RunTaskView,
  policy: ReturnType<typeof scheduleWaitPolicy>,
): RunTaskView {
  return {
    ...view,
    requested_wait_ms: policy.requestedWaitMs,
    effective_wait_ms: policy.effectiveWaitMs,
    wait_truncated: policy.waitTruncated,
  };
}

function isScheduleReturnableStatus(status: RunTaskStatus): boolean {
  return isTerminalRunStatus(status) || status === "input_required";
}

function isTerminalRunStatus(status: RunTaskStatus): boolean {
  return TERMINAL_RUN_STATUS_SET.has(status);
}

function isReturnableRunView(view: RunTaskView): boolean {
  if (!isScheduleReturnableStatus(view.status)) {
    return false;
  }
  const state = tasks.get(view.run_id);
  if (state && isTerminalRunStatus(view.status) && !state.terminalSnapshotStarted) {
    return false;
  }
  return true;
}

async function waitForReturnableRun(started: RunTaskView, waitMs: number): Promise<RunTaskView> {
  if (isReturnableRunView(started) || waitMs === 0) {
    return started;
  }
  const deadline = Date.now() + waitMs;
  let latest = started;
  while (Date.now() < deadline) {
    latest = await getRunTask(started.run_id);
    if (isReturnableRunView(latest)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
  return getRunTask(started.run_id);
}

export async function scheduleRunTask(
  request: RunSubagentRequest & { wait_ms?: number },
  options: {
    runsDir?: string;
    heartbeat?: HeartbeatNotify;
    heartbeatIntervalMs?: number;
    lineage?: RunTaskLineage;
  } = {},
): Promise<RunTaskView> {
  const waitMs = scheduleWaitMs(request.wait_ms);
  const waitPolicy = scheduleWaitPolicy(waitMs);
  const runRequest = { ...request };
  delete runRequest.wait_ms;
  const started = await startRunTask(runRequest, { ...options, failureLogTool: "schedule_run" });
  return withScheduleWaitMetadata(
    await waitForReturnableRun(started, waitPolicy.effectiveWaitMs),
    waitPolicy,
  );
}

export async function startSessionRunTask(
  request: RunSubagentSessionRequest,
  options: {
    sessionsDir?: string;
    heartbeat?: HeartbeatNotify;
    heartbeatIntervalMs?: number;
    failureLogTool?: Extract<FailureLogTool, "start_session_run" | "run_subagent_session">;
    lineage?: RunTaskLineage;
  } = {},
): Promise<RunTaskView> {
  const failureLogTool = options.failureLogTool ?? "start_session_run";
  await validateRunSubagentSessionRequestPreflight(request, failureLogTool, {
    sessionsDir: options.sessionsDir,
  });

  const state = createRunTaskState(
    "session",
    typeof request.session_key === "string" ? request.session_key : undefined,
    options.lineage,
  );
  state.failureLogTool = failureLogTool;
  const childLease = await registerRunTaskStateWithChildLease(state, request);
  try {
    await prepareChildRun(state);
  } catch (error) {
    state.error = error as Error;
    await logBackgroundHandlerError(failureLogTool, request, error);
    await finalizeRegisteredRunTask(state, childLease, durableTaskCloseReason(state));
    return getRunTask(state.runId);
  }

  state.promise = containBackgroundRunFailure(state, (async () => {
    try {
      state.result = await runSubagentSession(request, {
        sessionsDir: options.sessionsDir,
        mailboxRoot: state.mailboxRoot,
        childRunId: state.runId,
        taskId: state.runId,
        failureLogTool,
        ...taskRecursiveRuntimeOptions(state),
        ...taskChildRuntimeOptions(state, options),
        ...taskInputControlOptions(state),
      });
    } catch (error) {
      state.error = error as Error;
      await logBackgroundHandlerError(failureLogTool, request, error);
    } finally {
      await finalizeRegisteredRunTask(state, childLease, durableTaskCloseReason(state));
    }
  })());

  return getRunTask(state.runId);
}

export async function runSubagentSessionTaskAndWait(
  request: RunSubagentSessionRequest,
  options: {
    sessionsDir?: string;
    heartbeat?: HeartbeatNotify;
    heartbeatIntervalMs?: number;
  } = {},
): Promise<RunTaskView> {
  const started = await startSessionRunTask(request, { ...options, failureLogTool: "run_subagent_session" });
  const state = tasks.get(started.run_id);
  await state?.promise;
  if (state?.error) {
    throw state.error;
  }
  return getRunTask(started.run_id);
}

function runSubagentResultWithConcreteTimeoutRecoveryHint(
  result: RunSubagentResult,
  runId: string,
): RunSubagentResult {
  const timeoutRecoveryHint = result.timed_out === true && result.timeout_recovery_hint === undefined
    ? RUN_SUBAGENT_TIMEOUT_RECOVERY_HINT
    : result.timeout_recovery_hint;
  if (!timeoutRecoveryHint) {
    return result;
  }
  return {
    ...result,
    timeout_recovery_hint: `${timeoutRecoveryHint} Inspect this run with get_run using run_id ${runId}.`,
  };
}

async function runSubagentPromotedTask(
  request: RunSubagentRequest,
  incompatibility: RunSubagentOneShotIncompatibility,
  skillFilePath: string | undefined,
  options: {
    runsDir?: string;
    heartbeat?: HeartbeatNotify;
    heartbeatIntervalMs?: number;
  },
): Promise<RunTaskView> {
  await assertDiskReserveAvailable(options.runsDir);
  const promotion: RunSubagentPromotion = {
    auto_promoted_from: "run_subagent",
    promotion_reason_code: incompatibility.reason_code,
    promotion_reason: incompatibility.message,
    poll_with: "get_run",
    cancel_with: "cancel_run",
  };
  const state = createRunTaskState("run");
  state.promotion = promotion;
  const childLease = await registerRunTaskStateWithChildLease(state, request);
  try {
    await appendStatusEvent(state, {
      kind: "task",
      event: "auto_promoted",
      text: "[auto_promoted] run_subagent -> durable_run",
      occurred_at: new Date().toISOString(),
      metadata: { ...promotion },
    }, "run_subagent auto-promoted to durable run");
    await writeTaskSnapshot(await getRunTask(state.runId));
  } catch (error) {
    state.error = error instanceof Error ? error : new Error(String(error));
    await finalizeRegisteredRunTask(state, childLease, durableTaskCloseReason(state));
    throw error;
  }

  state.promise = containBackgroundRunFailure(state, (async () => {
    try {
      await prepareChildRun(state);
      const result = await runSubagentCore(request, {
        runId: state.runId,
        mailboxRoot: state.mailboxRoot,
        runsDir: options.runsDir,
        allowTimeout: true,
        skillFilePath,
        ...taskRecursiveRuntimeOptions(state),
        ...taskChildRuntimeOptions(state, options),
        ...taskInputControlOptions(state),
      });
      state.result = {
        ...runSubagentResultWithConcreteTimeoutRecoveryHint(result, state.runId),
        ...promotion,
      };
    } catch (error) {
      state.error = error as Error;
      await logBackgroundHandlerError("run_subagent", request, error);
    } finally {
      await finalizeRegisteredRunTask(state, childLease, durableTaskCloseReason(state));
    }
  })());

  return waitForReturnableRun(await getRunTask(state.runId), PROMOTED_RUN_WAIT_MS);
}

export async function runSubagentOneShotTask(
  request: RunSubagentRequest,
  options: {
    runsDir?: string;
    heartbeat?: HeartbeatNotify;
    heartbeatIntervalMs?: number;
  } = {},
): Promise<RunTaskView> {
  if (request.timeout_ms !== undefined) {
    throw new ValidationError(
      "timeout_ms is not supported by run_subagent; use schedule_run or start_run for timed work",
      "run_subagent_timeout_unsupported",
    );
  }
  const config = await loadConfig();
  const resolved = await validateAndResolveRequest(request, config);
  const snapshotPreflight = await assertSkillSnapshotBinding(resolved);
  const skillFilePath = snapshotPreflight?.receipt.resolved_skill_path ?? resolveSkillFilePathForRequest(resolved);
  await assertExpectedSkillBinding(resolved, skillFilePath);
  const incompatibility = runSubagentOneShotIncompatibility(request, resolved);
  if (incompatibility) {
    return runSubagentPromotedTask(request, incompatibility, skillFilePath, options);
  }
  await assertModelClassUsableForOneShot(resolved.modelClass);
  const childEntrypoint = await assertPiChildEntrypointAvailable();
  await expectedBoundedActivationToolBindings({
    resolved,
    snapshotActivation: snapshotPreflight,
    childEntrypoint,
  });
  await assertDiskReserveAvailable(options.runsDir);

  const state = createRunTaskState("run");
  const childLease = await registerRunTaskStateWithChildLease(state, request);

  state.promise = containBackgroundRunFailure(state, (async () => {
    try {
      await prepareChildRun(state);
      state.result = await runSubagentCore(request, {
        runId: state.runId,
        mailboxRoot: state.mailboxRoot,
        runsDir: options.runsDir,
        skillFilePath,
        ...taskRecursiveRuntimeOptions(state),
        ...taskChildRuntimeOptions(state, options),
        ...taskInputControlOptions(state),
      });
    } catch (error) {
      state.error = error as Error;
      await logBackgroundHandlerError("run_subagent", request, error);
    } finally {
      await finalizeRegisteredRunTask(state, childLease, "run reached a terminal state");
    }
  })());

  await state.promise;
  const view = await getRunTask(state.runId);
  if (view.timed_out === true || view.timeout_recovery_hint) {
    const withConcreteHint: RunTaskView = runSubagentResultWithConcreteTimeoutRecoveryHint(
      view as RunSubagentResult,
      state.runId,
    ) as RunTaskView;
    await writeTaskSnapshot(withConcreteHint);
    if (state.result) {
      state.result = { ...state.result, timeout_recovery_hint: withConcreteHint.timeout_recovery_hint };
    }
    return withConcreteHint;
  }
  return view;
}

export async function cancelRunTask(runId: string): Promise<RunTaskView> {
  const state = tasks.get(runId);
  if (!state) {
    const snapshot = await readTaskSnapshot(runId);
    if (snapshot && isTerminalRunStatus(snapshot.status)) {
      return getRunTask(runId);
    }
    throw taskNotFound(runId);
  }
  return serializeInputMutation(state, async () => {
    if (!state.result && !state.error && !state.terminalizing) {
      state.cancelRequested = true;
      setTaskPhase(state, "cancelling");
      rejectPendingInputDeliveries(
        state,
        new ValidationError(`input request is already closed: ${runId}`, "input_request_already_closed"),
      );
      await appendStatusEvent(state, {
        kind: "terminal",
        event: "cancellation_requested",
        text: "[cancellation_requested] cancellation requested",
        occurred_at: new Date().toISOString(),
      }, "cancellation requested");
      const closed = await closePendingInputRequestsForRun({
        mailboxRoot: state.mailboxRoot,
        runId,
        reason: "run cancelled",
      });
      await appendClosedInputEvents(state, closed);
      state.abortController.abort();
    }
    const view = await getRunTask(runId);
    await writeTaskSnapshot(view);
    return view;
  });
}

export interface RunOperationContext {
  runId: string;
  taskKind?: "run" | "session";
  sessionKey?: string;
  cwd?: string;
  snapshot?: RunTaskView;
}

function cwdFromRunStartedEvent(events: RunPublicEvent[]): string | undefined {
  for (const event of events) {
    if (event.event === "run_started" && typeof event.metadata?.cwd === "string") {
      return event.metadata.cwd;
    }
  }
  return undefined;
}

export async function resolveRunOperationContext(runId: string): Promise<RunOperationContext> {
  const state = tasks.get(runId);
  if (state) {
    const startedEvent = state.recentEvents.find((event) => event.event === "run_started");
    return {
      runId,
      taskKind: state.taskKind,
      ...(state.sessionKey ? { sessionKey: state.sessionKey } : {}),
      ...(state.cwd
        ? { cwd: state.cwd }
        : typeof startedEvent?.metadata?.cwd === "string"
          ? { cwd: startedEvent.metadata.cwd }
          : {}),
    };
  }
  const snapshot = await readTaskSnapshot(runId);
  if (!snapshot) {
    return { runId };
  }
  const events = await readRunPublicEvents(defaultRunTasksDir(), runId);
  const cwd = cwdFromRunStartedEvent(events.length > 0 ? events : snapshot.recent_events ?? []);
  return {
    runId,
    ...(snapshot.task_kind ? { taskKind: snapshot.task_kind } : {}),
    ...(snapshot.session_key ? { sessionKey: snapshot.session_key } : {}),
    ...(cwd ? { cwd } : {}),
    snapshot,
  };
}

export interface AnswerRunTaskInputResult {
  view: RunTaskView;
  responseId: string;
  receipt: string;
  outcome: "accepted" | "replayed";
}

async function recordAnsweredInput(
  state: RunTaskState,
  requestId: string,
  responseId: string,
): Promise<RunTaskView> {
  const occurredAt = new Date().toISOString();
  const remainingPending = await listInputRequests({
    mailboxRoot: state.mailboxRoot,
    runId: state.runId,
    status: "pending",
  });
  setTaskPhase(state, remainingPending.length > 0 ? "input_required" : "running", occurredAt);
  await appendStatusEvent(state, {
    kind: "input",
    event: "input_answered",
    text: `[input_answered] ${requestId}`,
    occurred_at: occurredAt,
    metadata: {
      request_id: requestId,
      response_id: responseId,
      status: "answered",
    },
  }, "input answered");
  const view = await getRunTask(state.runId);
  await writeTaskSnapshot(view);
  return view;
}

function settleChildAcceptedInputResponse(
  state: RunTaskState,
  response: { requestId: string; responseId: string },
): void {
  void serializeInputMutation(state, async () => {
    const delivery = state.pendingInputDeliveries.get(response.requestId);
    if (!delivery || delivery.responseId !== response.responseId) {
      return;
    }
    if (state.cancelRequested || state.terminalizing) {
      state.pendingInputDeliveries.delete(response.requestId);
      delivery.reject(new ValidationError(`run is not accepting input: ${state.runId}`, "run_not_accepting_input"));
      return;
    }
    try {
      await settleInputResponse({
        mailboxRoot: state.mailboxRoot,
        requestId: response.requestId,
        responseId: response.responseId,
        receipt: delivery.receipt,
      });
      state.pendingInputDeliveries.delete(response.requestId);
      state.acceptedInputResponses.set(response.requestId, {
        responseId: response.responseId,
        answerSha256: inputAnswerSha256(delivery.answer),
        receipt: delivery.receipt,
      });
      delivery.resolve({
        view: await recordAnsweredInput(state, response.requestId, response.responseId),
        responseId: response.responseId,
        receipt: delivery.receipt,
        outcome: "accepted",
      });
    } catch (error) {
      state.pendingInputDeliveries.delete(response.requestId);
      delivery.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }).catch((error) => {
    const delivery = state.pendingInputDeliveries.get(response.requestId);
    if (delivery?.responseId === response.responseId) {
      state.pendingInputDeliveries.delete(response.requestId);
      delivery.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function answerRunTaskInput(options: {
  runId: string;
  requestId: string;
  answer: string;
  responseId: string;
}): Promise<AnswerRunTaskInputResult> {
  const responseId = options.responseId.trim();
  if (!responseId) {
    throw new ValidationError("response_id must be a nonempty string", "unknown_validation_error");
  }
  const state = tasks.get(options.runId);
  if (!state) {
    throw taskNotFound(options.runId);
  }
  const prepared = await serializeInputMutation(state, async (): Promise<
    { result: AnswerRunTaskInputResult } | { delivery: PendingInputDelivery }
  > => {
    const accepted = state.acceptedInputResponses.get(options.requestId);
    if (accepted) {
      if (accepted.responseId !== responseId) {
        throw new ValidationError(
          `input request is already answered: ${options.requestId}`,
          "input_request_already_answered",
        );
      }
      if (accepted.answerSha256 !== inputAnswerSha256(options.answer)) {
        throw new ValidationError(
          `response_id conflicts with its prior input: ${responseId}`,
          "input_response_id_conflict",
        );
      }
      return {
        result: {
          view: await getRunTask(options.runId),
          responseId,
          receipt: accepted.receipt,
          outcome: "replayed",
        },
      };
    }
    const existingDelivery = state.pendingInputDeliveries.get(options.requestId);
    if (existingDelivery) {
      if (existingDelivery.responseId === responseId && existingDelivery.answer === options.answer) {
        return { delivery: existingDelivery };
      }
      if (existingDelivery.responseId === responseId) {
        throw new ValidationError(
          `response_id conflicts with its prior input: ${responseId}`,
          "input_response_id_conflict",
        );
      }
      throw new ValidationError(
        `input request is already answered: ${options.requestId}`,
        "input_request_already_answered",
      );
    }
    const requests = state.terminalInputRequests ?? await listInputRequests({
      mailboxRoot: state.mailboxRoot,
      runId: state.runId,
    });
    const request = requests.find((entry) => entry.request_id === options.requestId);
    if (!request) {
      throw new ValidationError(
        `input request is not part of run ${options.runId}: ${options.requestId}`,
        "input_request_not_part_of_run",
      );
    }
    if (request.status !== "pending") {
      if (request.status === "closed") {
        throw new ValidationError(`input request is already closed: ${options.requestId}`, "input_request_already_closed");
      }
      if (request.status === "timed_out") {
        throw new ValidationError(`input request is already timed out: ${options.requestId}`, "input_request_already_timed_out");
      }
      throw new ValidationError(`input request is already answered: ${options.requestId}`, "input_request_already_answered");
    }
    if (state.cancelRequested || state.terminalizing || state.result || state.error) {
      throw new ValidationError(`run is not accepting input: ${options.runId}`, "run_not_accepting_input");
    }
    validateInputResponse(request, options.answer);
    if (!state.childControlSend) {
      throw new ValidationError(`run is not accepting input: ${options.runId}`, "run_not_accepting_input");
    }
    const receipt = `input-${randomBytes(12).toString("hex")}`;
    const sent = state.childControlSend(`${JSON.stringify({
      type: "subagent007.input_response",
      request_id: options.requestId,
      response_id: responseId,
      answer: options.answer,
    })}\n`);
    if (!sent) {
      throw new ValidationError(`run is not accepting input: ${options.runId}`, "run_not_accepting_input");
    }
    let resolve!: (result: AnswerRunTaskInputResult) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<AnswerRunTaskInputResult>((resolveCompletion, rejectCompletion) => {
      resolve = resolveCompletion;
      reject = rejectCompletion;
    });
    const delivery: PendingInputDelivery = {
      responseId,
      answer: options.answer,
      receipt,
      completion,
      resolve,
      reject,
    };
    state.pendingInputDeliveries.set(options.requestId, delivery);
    return { delivery };
  });
  return "result" in prepared ? prepared.result : prepared.delivery.completion;
}
