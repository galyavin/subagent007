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
  type InputTerminalRecord,
  type InputRequestView,
} from "./inputMailbox.js";
import {
  assertPiChildEntrypointAvailable,
  assertExpectedSkillBinding,
  assertSkillSnapshotBinding,
  expectedBoundedActivationToolBindings,
  runSubagentCore,
  resolveSkillFilePathForRequest,
  resolveSystemSkillSourceForRequest,
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
  canonicalRunPublicEvent,
  publicOutputExcerptProjection,
  recentEventsProjection,
  terminalEventsProjection,
  type CanonicalRunPublicEvent,
} from "./runEvents.js";
import { publicOutputLineFromProcessLine } from "./transcript.js";
import {
  terminalRunTaskEventDetails,
  terminalRunTaskStatus,
  type RunTaskActivePhase,
  type RunTaskTerminalStatus,
} from "./runLifecycle.js";
import type {
  ModelClass,
  RecursiveEdgePromptWitness,
  RecursiveDelegationReceipt,
  RunPublicEvent,
  RunPublicEventName,
  RunSubagentRequest,
  RunSubagentResult,
  RunSubagentSessionRequest,
  RunSubagentSessionResult,
  StartRunTaskRequest,
  SystemSkillActivationReceipt,
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
import { validateAndResolveRequest } from "./validate.js";
import { validatedSystemSkillActivationReceipt } from "./systemSkill.js";
import {
  assertPendingTerminalOutputs,
  cleanupPendingTerminalOutputs,
  decodeRunOutputReference,
  defaultSubagentStatePath,
  readValidatedRunOutput,
  recoverStreamingRunTranscript,
  terminalReferencesOwnPendingOutputs,
  type PendingTerminalOutputs,
} from "./output.js";
import {
  terminalProjectionIsValid,
  type TerminalActivationClass,
} from "./terminalProjection.js";
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
import { withRunClaimLock } from "./runClaimLock.js";
import {
  canonicalClientStartRequestSha256,
  canonicalJson,
  clientStartAdmissionOwnerLiveness,
  claimClientStartAdmission,
  findClientStartAdmission,
  resolveClientStartAdmissionBinding,
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
  "child_spawned" | "child_bridge_started" | "child_session_established" | "activation_confirmed" | "skill_snapshot_activation_confirmed" | "recursive_delegation_confirmed" | "system_skill_activation_confirmed" | "child_prompt_submitted"
>;
type StandardChildLifecycleEventName = Exclude<ChildLifecycleEventName, "activation_confirmed" | "skill_snapshot_activation_confirmed" | "recursive_delegation_confirmed" | "system_skill_activation_confirmed">;
const CHILD_LIFECYCLE_GENERATION = {
  child_spawned: {
    sequence: 0,
    progressMessage: "child process running; waiting for first public output",
  },
  child_bridge_started: {
    sequence: 1,
    progressMessage: "child bridge started; waiting for first public output",
  },
  recursive_delegation_confirmed: {
    sequence: 2,
    progressMessage: "recursive delegation authority confirmed before prompt",
  },
  child_session_established: {
    sequence: 3,
    progressMessage: "Pi session established; waiting for first public output",
  },
  activation_confirmed: {
    sequence: 4,
    progressMessage: "constrained activation confirmed before prompt",
  },
  skill_snapshot_activation_confirmed: {
    sequence: 5,
    progressMessage: "immutable runtime snapshot confirmed before prompt",
  },
  system_skill_activation_confirmed: {
    sequence: 6,
    progressMessage: "governing system skill placement confirmed before prompt",
  },
  child_prompt_submitted: {
    sequence: 7,
    progressMessage: "prompt submitted; waiting for first public output",
  },
} as const satisfies Record<
  ChildLifecycleEventName,
  { sequence: number; progressMessage: string }
>;
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
  requested_recursive_edge_witness?: RunSubagentRequest["recursive_edge_witness"];
  recursive_edge_prompt_witness?: RecursiveEdgePromptWitness;
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
  recursiveEdgePromptWitness?: RecursiveEdgePromptWitness;
}

export type RecursiveCallerLineage = Required<
  Pick<RunTaskLineage, "parentRunId" | "rootRunId" | "recursionDepth">
>;

interface RunTaskState {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  mailboxRoot: string;
  inputRequestsDir: string;
  inputRequests: InputRequestView[];
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
  parentRunId?: string;
  requestedRecursiveEdgeWitness?: RunSubagentRequest["recursive_edge_witness"];
  recursiveEdgePromptWitness?: RecursiveEdgePromptWitness;
  rootRunId: string;
  recursionDepth: number;
  childRunIds: string[];
  descendantRunIds: string[];
  descendantTerminalStatuses: Record<string, RunTaskTerminalStatus>;
  childControlSend?: (message: string) => boolean;
  acceptedInputResponses: Map<string, AcceptedInputResponse>;
  pendingInputDeliveries: Map<string, PendingInputDelivery>;
  terminalizing: boolean;
  partialOutputPath?: string;
  pendingTerminalOutputs?: PendingTerminalOutputs;
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
  requestedSystemSkill?: string;
  /** Private root-resolved class for a live governed recursive lineage. */
  governingModelClass?: ModelClass;
  systemSkillActivationReceipt?: SystemSkillActivationReceipt;
  systemSkillActivationObservation: {
    promise: Promise<SystemSkillActivationReceipt | undefined>;
    resolve: (receipt: SystemSkillActivationReceipt | undefined) => void;
  };
  expectedSkillSha256?: string;
  claimDeclarations?: OwnerRequestDeclarations;
  ownerLaunchObservation?: RunOwnerLaunchObservation;
}

type ChildLifecycleProjectionBaseline = Pick<
  RunTaskState,
  | "activePhase"
  | "lastPhaseAt"
  | "lastChildLifecycleEvent"
  | "lastChildLifecycleAt"
  | "lastProgressAt"
  | "lastProgressMessage"
  | "heartbeatCount"
  | "firstPublicOutputAt"
>;

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

interface RunTaskTerminalIntent {
  result?: RunTaskTerminalResult;
  error?: Error;
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
const residentTransitionChains = new Map<string, Promise<void>>();
const residentPublicationWaiters = new Map<string, Set<() => void>>();
const pendingResidentPublications = new Set<string>();
const DEFAULT_SCHEDULE_WAIT_MS = 1_000;
const DEFAULT_SCHEDULE_MAX_WAIT_MS = 30_000;
const SCHEDULE_MAX_WAIT_ENV = "SUBAGENT007_SCHEDULE_RUN_MAX_WAIT_MS";

function defaultRunTasksDir(): string {
  return defaultSubagentStatePath("SUBAGENT007_RUN_TASKS_DIR", "run-tasks");
}

function taskRecordPath(runId: string): string {
  return path.join(defaultRunTasksDir(), `${runId}.json`);
}

const RUN_OWNER_RECORD_NAME = "subagent007.current_run_claim" as const;
const RUN_OWNER_RECORD_VERSION = 1 as const;
const RUN_OWNER_RECORD_SCOPE_DOMAIN = "subagent007.run_owner_record.effect_scope.v1\n";
const LIVE_INPUT_RESPONSE_DOMAIN = "subagent007.live_input_response.v1\n";

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
    system_skill_name?: string;
    system_skill_path?: string;
  };
}

interface CurrentRunClaimV1 extends RunTaskView {
  record_name: typeof RUN_OWNER_RECORD_NAME;
  record_version: typeof RUN_OWNER_RECORD_VERSION;
  declarations: OwnerRequestDeclarations;
  launch_observation?: RunOwnerLaunchObservation;
  pending_terminal_outputs?: PendingTerminalOutputs;
}

function currentRunClaimView(claim: CurrentRunClaimV1): RunTaskView {
  const {
    record_name: _recordName,
    record_version: _recordVersion,
    declarations: _declarations,
    launch_observation: _launch,
    pending_terminal_outputs: _pendingTerminalOutputs,
    ...view
  } = claim;
  if (isTerminalRunStatus(view.status) && view.recent_events?.length && !view.last_public_output_excerpt) {
    view.last_public_output_excerpt = publicOutputExcerptProjection(view.recent_events);
  }
  return view;
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
    ...(request.system_skill_name ? { systemSkillName: request.system_skill_name } : {}),
    ...(request.expected_skill_sha256 ? { expectedSkillSha256: request.expected_skill_sha256 } : {}),
    ...(request.skill_snapshot_binding ? { skillSnapshotBinding: request.skill_snapshot_binding } : {}),
    requestedRecursiveDelegation: request.recursive_delegation ?? null,
    ...(request.recursive_edge_witness
      ? { requestedRecursiveEdgeWitness: request.recursive_edge_witness }
      : {}),
  };
}

function ensureClaimDeclarations(
  state: RunTaskState,
  request: RunSubagentRequest | RunSubagentSessionRequest,
): void {
  const declarations = ownerRequestDeclarationsFromRequest(request);
  if (state.claimDeclarations && !sameCanonicalOwnerJson(state.claimDeclarations, declarations)) {
    throw new ValidationError("run claim declarations changed after capture", "client_start_id_conflict");
  }
  state.claimDeclarations = declarations;
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
    systemSkillName?: string;
    systemSkillPath?: string;
    governingModelClass?: ModelClass;
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
      ...(observation.systemSkillName && observation.systemSkillPath ? {
        system_skill_name: observation.systemSkillName,
        system_skill_path: observation.systemSkillPath,
      } : {}),
    },
  };
}

function ownerLaunchObservationTransition(
  existing: RunOwnerLaunchObservation,
  next: RunOwnerLaunchObservation,
): RunOwnerLaunchObservation {
  if (!sameCanonicalOwnerJson(existing, next)) {
    invalidOwnerRecord("run claim launch grant changed after capture");
  }
  return existing;
}

function assertRunOwnerRecord(record: CurrentRunClaimV1): void {
  if (record.record_name !== RUN_OWNER_RECORD_NAME || record.record_version !== RUN_OWNER_RECORD_VERSION) {
    invalidOwnerRecord("run claim has an invalid representation");
  }
  const view = currentRunClaimView(record);
  if (record.pending_terminal_outputs !== undefined) {
    try {
      assertPendingTerminalOutputs(record.pending_terminal_outputs, view.run_id);
    } catch {
      invalidOwnerRecord("run claim pending terminal output ownership is invalid");
    }
  }
  const declarations = record.declarations;
  if (!isRecord(declarations) || !isNonemptyString(view.run_id) || view.task_id !== view.run_id ||
    (view.task_kind !== "run" && view.task_kind !== "session") ||
    !sameCanonicalOwnerJson(ownerRequestDeclarations(view), declarations)) {
    invalidOwnerRecord("run claim declarations do not match current truth");
  }
  if (record.launch_observation !== undefined) {
    const launch = record.launch_observation;
    if (!exactRecordKeys(launch as unknown as Record<string, unknown>, [
      "effect_scope_binding_bytes", "effect_scope_binding_sha256", "activation_expectation",
    ].filter((key) => (launch as unknown as Record<string, unknown>)[key] !== undefined)) ||
      !isRecord(launch.activation_expectation)) {
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
      const receipt = view.activation_receipt;
      const receiptScope = receipt && "effect_scope_binding" in receipt
        ? receipt.effect_scope_binding
        : undefined;
      if (receiptScope !== undefined && !sameCanonicalOwnerJson(receiptScope, expectedScope)) {
        invalidOwnerRecord("run owner record activation receipt does not match captured effect scope");
      }
    }
    const expectation = launch.activation_expectation as Record<string, unknown>;
    const expectedChildRecursiveDelegation = view.task_kind === "session"
      ? "disabled"
      : declarations.requestedRecursiveDelegation;
    if (!exactRecordKeys(expectation, [
      "requested_effect_profile", "expected_skill_sha256", "skill_binding", "tool_bindings",
      "skill_snapshot_binding", "skill_snapshot_activation_receipt",
      "requested_recursive_delegation", "resolved_recursive_delegation",
      ...(declarations.systemSkillName ? ["system_skill_name", "system_skill_path"] : []),
    ]) ||
      expectation.requested_effect_profile !== (declarations.effectProfile ?? null) ||
      expectation.system_skill_name !== declarations.systemSkillName ||
      (declarations.systemSkillName !== undefined && !isNonemptyString(expectation.system_skill_path)) ||
      expectation.expected_skill_sha256 !== (declarations.expectedSkillSha256 ?? null) ||
      !sameCanonicalOwnerJson(expectation.skill_snapshot_binding, declarations.skillSnapshotBinding ?? null) ||
      expectation.requested_recursive_delegation !== expectedChildRecursiveDelegation ||
      !Array.isArray(expectation.tool_bindings) ||
      !["disabled", "enabled"].includes(String(expectation.resolved_recursive_delegation)) ||
      (view.task_kind === "session" && expectation.resolved_recursive_delegation !== "disabled")) {
      invalidOwnerRecord("run owner record activation expectation does not match immutable admission");
    }
    const retainedChildSpawnedEvents = (view.recent_events ?? []).filter((event) =>
      event.kind === "child" && event.event === "child_spawned"
    );
    const expectedChildSpawnedEvents = view.child_started === true ? 1 : 0;
    if (retainedChildSpawnedEvents.length !== expectedChildSpawnedEvents) {
      invalidOwnerRecord("run claim grant does not match retained child_spawned event");
    }
    const expectedScope = launch.effect_scope_binding_bytes
      ? JSON.parse(launch.effect_scope_binding_bytes)
      : undefined;
    const promptSubmitted = childPromptWasSubmitted(view);
    if (promptSubmitted) {
      const receipt = view.activation_receipt;
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
        (!view.skill_snapshot_activation_receipt ||
          validatedSkillSnapshotActivationReceipt({
            value: view.skill_snapshot_activation_receipt,
            binding: expectation.skill_snapshot_binding as import("./types.js").SkillSnapshotLaunchBinding,
          }) === undefined)) {
        invalidOwnerRecord("run owner record snapshot receipt does not match retained launch expectations");
      }
      if (!view.recursive_delegation_receipt ||
        view.resolved_recursive_delegation !== expectation.resolved_recursive_delegation ||
        validatedRecursiveDelegationReceipt({
          value: view.recursive_delegation_receipt,
          requestedRecursiveDelegation: expectation.requested_recursive_delegation as "disabled" | "enabled" | null,
          resolvedRecursiveDelegation: expectation.resolved_recursive_delegation as "disabled" | "enabled",
        }) === undefined) {
        invalidOwnerRecord("run owner record recursive receipt does not match retained launch expectations");
      }
      if (declarations.systemSkillName && validatedSystemSkillActivationReceipt({
        value: view.system_skill_activation_receipt,
        expectedName: declarations.systemSkillName,
        expectedPath: expectation.system_skill_path as string,
      }) === undefined) {
        invalidOwnerRecord("run owner record system-skill receipt does not match retained launch expectations");
      }
    }
  } else if (view.child_started === true) {
    invalidOwnerRecord("child-started run claim is missing its launch observation");
  }
  assertCurrentRunTaskSnapshot(view);
}

function runClaimSnapshot(snapshot: RunTaskView): RunTaskView {
  const {
    elapsed_ms: _elapsed,
    last_progress_at: _lastProgressAt,
    last_progress_message: _lastProgressMessage,
    heartbeat_count: _heartbeatCount,
    last_child_lifecycle_event: _lastChildLifecycleEvent,
    last_child_lifecycle_at: _lastChildLifecycleAt,
    first_public_output_at: _firstPublicOutputAt,
    no_public_output_elapsed_ms: _noPublicOutputElapsed,
    last_public_output_excerpt: _lastPublicOutputExcerpt,
    queued_at: _queuedAt,
    child_started_at: _childStartedAt,
    queue_wait_ms: _queueWaitMs,
    ...claim
  } = snapshot;
  if (!isTerminalRunStatus(snapshot.status) && claim.recent_events) {
    claim.recent_events = claim.recent_events.filter((event) =>
      event.kind === "task" || event.kind === "user" || event.kind === "child" ||
      event.kind === "input" || event.kind === "packet" || event.kind === "terminal"
    );
  }
  return claim;
}

interface RunClaimPersistenceEvidence {
  declarations: NonNullable<RunTaskState["claimDeclarations"]>;
  launchObservation?: NonNullable<RunTaskState["ownerLaunchObservation"]>;
  pendingTerminalOutputs?: PendingTerminalOutputs;
}

function runClaimPersistenceEvidence(state: RunTaskState): RunClaimPersistenceEvidence {
  if (!state.claimDeclarations) invalidOwnerRecord("current v3 run has no claim declarations");
  return {
    declarations: state.claimDeclarations,
    ...(state.ownerLaunchObservation ? { launchObservation: state.ownerLaunchObservation } : {}),
    ...(state.pendingTerminalOutputs ? { pendingTerminalOutputs: state.pendingTerminalOutputs } : {}),
  };
}

function ownerRecordForSnapshot(
  snapshot: RunTaskView,
  existing: CurrentRunClaimV1 | undefined,
  evidence: RunClaimPersistenceEvidence,
): CurrentRunClaimV1 {
  const declarations = existing?.declarations ?? evidence.declarations;
  if (!sameCanonicalOwnerJson(declarations, evidence.declarations)) {
    invalidOwnerRecord("run claim declarations changed during persistence");
  }
  const launch = evidence.launchObservation && existing?.launch_observation
    ? ownerLaunchObservationTransition(existing.launch_observation, evidence.launchObservation)
    : evidence.launchObservation ?? existing?.launch_observation;
  return {
    ...runClaimSnapshot(snapshot),
    record_name: RUN_OWNER_RECORD_NAME,
    record_version: RUN_OWNER_RECORD_VERSION,
    declarations,
    ...(launch ? { launch_observation: launch } : {}),
    ...(evidence.pendingTerminalOutputs
      ? { pending_terminal_outputs: evidence.pendingTerminalOutputs }
      : {}),
  };
}

function ownerRecordFromValue(value: unknown): CurrentRunClaimV1 | undefined {
  if (!isRecord(value) || value.record_name !== RUN_OWNER_RECORD_NAME) return undefined;
  const record = value as unknown as CurrentRunClaimV1;
  assertRunOwnerRecord(record);
  return record;
}

async function readRunOwnerRecordFile(filePath: string): Promise<CurrentRunClaimV1 | undefined> {
  return ownerRecordFromValue(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
}

async function readPersistedRunView(filePath: string): Promise<RunTaskView> {
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  const record = ownerRecordFromValue(value);
  if (record) return currentRunClaimView(record);
  invalidOwnerRecord("run snapshot is missing its current run claim");
}

async function withRunOwner<T>(runId: string, operation: () => Promise<T>): Promise<T> {
  const previous = residentTransitionChains.get(runId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  residentTransitionChains.set(runId, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (residentTransitionChains.get(runId) === queued) residentTransitionChains.delete(runId);
    if (pendingResidentPublications.delete(runId)) notifyResidentRunTaskPublication(runId);
  }
}

function assertOwnerViewTransition(existing: RunTaskView | undefined, next: RunTaskView): void {
  if (!existing) return;
  if (existing.run_id !== next.run_id || existing.task_id !== next.task_id) {
    invalidOwnerRecord("run owner identity changed across revisions");
  }
  if (existing.child_started === true && next.child_started !== true) {
    invalidOwnerRecord("run owner child-started claim regressed");
  }
  const nextEvents = next.recent_events ?? [];
  for (const event of existing.recent_events ?? []) {
    if (
      (event.event === "child_spawned" ||
        event.event === "cancellation_requested" ||
        event.kind === "terminal") &&
      !nextEvents.some((candidate) => sameCanonicalOwnerJson(candidate, event))
    ) {
      invalidOwnerRecord("run owner stable event claim regressed");
    }
  }
  for (const field of [
    "activation_receipt",
    "skill_snapshot_activation_receipt",
    "recursive_delegation_receipt",
    "requested_recursive_edge_witness",
    "recursive_edge_prompt_witness",
  ] as const) {
    if (
      existing[field] !== undefined &&
      !sameCanonicalOwnerJson(existing[field], next[field])
    ) {
      invalidOwnerRecord(`run owner ${field} claim regressed`);
    }
  }
  for (const childRunId of existing.child_run_ids ?? []) {
    if (!(next.child_run_ids ?? []).includes(childRunId)) {
      invalidOwnerRecord("run owner direct-child claim regressed");
    }
  }
  for (const descendantRunId of existing.descendant_run_ids ?? []) {
    if (!(next.descendant_run_ids ?? []).includes(descendantRunId)) {
      invalidOwnerRecord("run owner descendant claim regressed");
    }
  }
  for (const inputRequest of existing.input_requests) {
    if (
      inputRequest.status !== "pending" &&
      !(next.input_requests ?? []).some((candidate) =>
        candidate.request_id === inputRequest.request_id &&
        sameCanonicalOwnerJson(candidate, inputRequest)
      )
    ) {
      invalidOwnerRecord("run owner accepted input claim regressed");
    }
  }
  if (isTerminalRunStatus(existing.status)) {
    const {
      timeout_recovery_hint: existingHint,
      ...existingWithoutHint
    } = existing;
    const {
      timeout_recovery_hint: nextHint,
      ...nextWithoutHint
    } = next;
    const concreteHintSuffix = ` Inspect this run with get_run using run_id ${existing.run_id}.`;
    const timeoutEnrichment =
      sameCanonicalOwnerJson(existingWithoutHint, nextWithoutHint) &&
      (nextHint === existingHint ||
        ((existing.timed_out === true || existing.error_class === "timeout") &&
          typeof nextHint === "string" &&
          (existingHint === undefined
            ? nextHint === `${RUN_SUBAGENT_TIMEOUT_RECOVERY_HINT}${concreteHintSuffix}`
            : nextHint === `${existingHint}${concreteHintSuffix}`)));
    if (!timeoutEnrichment) {
      invalidOwnerRecord("terminal run owner record cannot be replaced");
    }
  }
}

async function withRunClaimOwner<T>(
  state: RunTaskState,
  operation: () => Promise<T>,
): Promise<T> {
  return withRunOwner(state.runId, () =>
    withRunClaimLock(defaultRunTasksDir(), state.runId, operation)
  );
}

// The caller already holds the operation's exclusive semantic-authority owner.
// The view and immutable claim evidence are derived only after that ownership is held.
async function writeRunClaimOwned(
  view: RunTaskView,
  evidence: RunClaimPersistenceEvidence,
): Promise<RunTaskView> {
  const recordPath = taskRecordPath(view.run_id);
  const existingRecord = await readRunOwnerRecordFile(recordPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const existing = existingRecord ? runClaimSnapshot(currentRunClaimView(existingRecord)) : undefined;
  if (
    existing &&
    isRestartDriftSnapshot(existing) &&
    isTerminalRunStatus(view.status) &&
    !isRestartDriftSnapshot(view)
  ) return existing;
  const terminal = isTerminalRunStatus(view.status);
  let snapshot = view;
  if (terminal) {
    const canonicalEvents = terminalEventsProjection(
      (view.recent_events ?? []).filter(
        (event) => view.child_started !== false || event.kind !== "child"
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
  assertOwnerViewTransition(existing, runClaimSnapshot(snapshot));
  const record = ownerRecordForSnapshot(snapshot, existingRecord, evidence);
  assertRunOwnerRecord(record);
  const runTasksDir = defaultRunTasksDir();
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
  return snapshot;
}

async function cleanupTerminalRunStaging(snapshot: RunTaskView): Promise<void> {
  const cleanupResults = await Promise.allSettled([
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
  ensureClaimDeclarations(state, request);
  await fs.mkdir(defaultRunTasksDir(), { recursive: true });
  await reconcilePreparedClientStartCandidates(state.clientStartBinding.client_start_id);
  const candidatePath = preparedClientStartCandidatePath(state.clientStartBinding, process.pid);
  const handle = await fs.open(candidatePath, "wx", 0o600);
  try {
    const record = ownerRecordForSnapshot(
      activeRunTaskView(state, []),
      undefined,
      runClaimPersistenceEvidence(state),
    );
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

function assertCurrentRunTaskSnapshotAdmission(view: RunTaskView, admission: ClientStartAdmission): void {
  validateClientStartSnapshotBinding(view, admission);
  if (view.started_at !== admission.admitted_at) {
    invalidCurrentRunTaskSnapshot(view, "client_start_id run snapshot start identity does not match admission");
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
  const outputReferences = view.output_references;
  const references = Array.isArray(outputReferences)
    ? outputReferences.map((candidate) => decodeRunOutputReference(candidate))
    : [];
  const validReferences = references.length >= 1 &&
    references.every((reference) => reference !== undefined);
  const decodedReferences = validReferences
    ? references as NonNullable<(typeof references)[number]>[]
    : [];
  const primary = decodedReferences.find((reference) => reference.name === "primary");
  const activationClass = terminalActivationClass(view);
  return !hasOwnDefined(view, "output_path") && validReferences && primary !== undefined &&
    activationClass !== undefined &&
    terminalProjectionIsValid({
      requestedEffectProfile: view.requested_effect_profile,
      activationClass,
      status: view.status as RunTaskTerminalStatus,
      outputReferences: decodedReferences,
      controllerTerminalReceipt: view.controller_terminal_receipt,
    }) &&
    primary.size_bytes === view.size_bytes && primary.output_mode === view.written_output_mode &&
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
  "controller_terminal_receipt",
] as const;

const RETIRED_CURRENT_RUN_FIELDS = [
  "auto_promoted_from",
  "promotion_reason_code",
  "promotion_reason",
  "poll_with",
  "cancel_with",
  "skill",
  "tool_profile",
] as const;

const OWNER_VALIDATION_REASON_CODES = new Set<FailureReasonCode>([
  "child_entrypoint_missing", "child_entrypoint_not_file", "config_missing_default_model_class",
  "cancelled_before_first_output", "cwd_inaccessible", "cwd_not_absolute", "cwd_not_directory",
  "disk_reserve_exhausted", "client_start_id_conflict", "invalid_output_mode", "invalid_packet_policy",
  "invalid_model", "invalid_model_class", "model_class_unhealthy", "invalid_resume_mode",
  "invalid_session_id", "invalid_session_key", "invalid_skill", "invalid_thinking_level",
  "invalid_effect_profile", "authoring_effect_scope_invalid",
  "authoring_effect_scope_drift", "invalid_expected_skill_sha256", "effect_profile_unsupported",
  "skill_binding_unsupported", "effect_profile_activation_failed", "skill_content_mismatch",
  "invalid_skill_snapshot_binding", "skill_snapshot_not_found", "skill_snapshot_altered",
  "skill_snapshot_reference_mismatch", "skill_snapshot_reference_closed", "skill_snapshot_activation_failed",
  "invalid_timeout_ms", "invalid_wait_ms", "local_capacity_exhausted", "local_queue_exhausted",
  "missing_session_id", "missing_final_output",
  "nonzero_exit", "packet_required_invalid", "packet_required_missing", "packet_required_not_ready",
  "prompt_missing", "raw_session_id_unsupported", "recursive_control_invalid", "recursive_depth_exceeded",
  "run_not_accepting_input", "run_liveness_unknown", "run_not_found", "run_subagent_timeout_unsupported",
  "input_request_already_answered", "input_request_already_closed",
  "input_request_already_timed_out", "input_request_not_found", "input_request_not_part_of_run",
  "input_response_id_conflict", "session_already_exists", "session_already_running", "session_cwd_mismatch",
  "session_does_not_exist", "session_ledger_invalid", "session_commit_invalid", "session_manifest_invalid",
  "session_skill_mismatch", "spawn_error", "timeout", "usage_limit_reached", "process_signal_terminated",
  "recursive_delegation_reauthorization_required", "recursive_delegation_effect_conflict",
  "recursive_delegation_activation_failed", "recursive_delegation_unsupported",
  "system_skill_activation_failed", "unknown_error",
  "unknown_validation_error",
]);

function hasOwnDefined(view: RunTaskView, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(view, field) &&
    (view as unknown as Record<string, unknown>)[field] !== undefined;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
  systemSkillName?: string;
  expectedSkillSha256?: string;
  skillSnapshotBinding?: NonNullable<RunSubagentRequest["skill_snapshot_binding"]>;
  requestedRecursiveDelegation: "disabled" | "enabled" | null;
  requestedRecursiveEdgeWitness?: NonNullable<RunSubagentRequest["recursive_edge_witness"]>;
}

function ownerRequestDeclarations(view: RunTaskView): OwnerRequestDeclarations | null {
  const effectProfile = hasOwnDefined(view, "requested_effect_profile")
    ? view.requested_effect_profile
    : undefined;
  const expectedSkillSha256 = hasOwnDefined(view, "expected_skill_sha256")
    ? view.expected_skill_sha256
    : undefined;
  const systemSkillName = hasOwnDefined(view, "requested_system_skill")
    ? view.requested_system_skill
    : undefined;
  const rawSnapshotBinding = hasOwnDefined(view, "skill_snapshot_binding")
    ? view.skill_snapshot_binding
    : undefined;
  const hasRequestedRecursiveDelegation = hasOwnDefined(view, "requested_recursive_delegation");
  const rawRequestedRecursiveDelegation = hasRequestedRecursiveDelegation
    ? view.requested_recursive_delegation
    : undefined;
  const requestedRecursiveDelegation = rawRequestedRecursiveDelegation ?? null;
  const requestedRecursiveEdgeWitness = hasOwnDefined(view, "requested_recursive_edge_witness")
    ? view.requested_recursive_edge_witness
    : undefined;
  if (
    (effectProfile !== undefined && !EFFECT_PROFILE_SET.has(effectProfile)) ||
    (systemSkillName !== undefined && (typeof systemSkillName !== "string" || systemSkillName.length === 0)) ||
    (expectedSkillSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedSkillSha256)) ||
    (rawSnapshotBinding !== undefined && !validatedSkillSnapshotLaunchBinding(rawSnapshotBinding)) ||
    (isBoundedEffectProfile(effectProfile) && rawSnapshotBinding === undefined) ||
    (hasRequestedRecursiveDelegation &&
      (rawRequestedRecursiveDelegation === undefined || !RECURSIVE_DELEGATION_SET.has(rawRequestedRecursiveDelegation))) ||
    (requestedRecursiveEdgeWitness !== undefined && requestedRecursiveEdgeWitness !== "prompt_sha256_v1") ||
    (requestedRecursiveEdgeWitness !== undefined && requestedRecursiveDelegation !== "enabled") ||
    (expectedSkillSha256 !== undefined && rawSnapshotBinding !== undefined) ||
    (effectProfile !== undefined && requestedRecursiveDelegation === "enabled")
  ) return null;
  return {
    ...(effectProfile ? { effectProfile } : {}),
    ...(systemSkillName ? { systemSkillName } : {}),
    ...(expectedSkillSha256 ? { expectedSkillSha256 } : {}),
    ...(rawSnapshotBinding ? { skillSnapshotBinding: rawSnapshotBinding } : {}),
    requestedRecursiveDelegation,
    ...(requestedRecursiveEdgeWitness ? { requestedRecursiveEdgeWitness } : {}),
  };
}

function terminalActivationClass(view: RunTaskView): TerminalActivationClass | undefined {
  const declarations = ownerRequestDeclarations(view);
  if (!declarations) return undefined;
  const triggered =
    declarations.effectProfile !== undefined ||
    declarations.expectedSkillSha256 !== undefined;
  const hasReceipt = hasOwnDefined(view, "activation_receipt");
  const hasResolvedProfile = hasOwnDefined(view, "resolved_effect_profile");
  if (!hasReceipt) {
    return hasResolvedProfile ? undefined : "other";
  }
  if (!triggered || !view.activation_receipt) return undefined;
  const receipt = validatedProjectedActivationReceipt({
    value: view.activation_receipt,
    requestedEffectProfile: declarations.effectProfile,
    expectedSkillSha256: declarations.expectedSkillSha256,
  });
  if (!receipt) return undefined;
  if (receipt.resolved_effect_profile === null) {
    if (hasResolvedProfile) return undefined;
  } else if (view.resolved_effect_profile !== receipt.resolved_effect_profile) {
    return undefined;
  }
  if (declarations.effectProfile !== "researcher_bounded_v1") return "other";
  if (receipt.schema_version === 3) return "researcher_v3_legacy";
  if (receipt.schema_version === 4) return "researcher_v4_strict";
  return undefined;
}

function hasChildLifecycleEvent(view: RunTaskView): boolean {
  return Array.isArray(view.recent_events) && view.recent_events.some((event) =>
    event.kind === "child" && [
      "child_spawned", "child_bridge_started", "child_session_established", "activation_confirmed",
      "skill_snapshot_activation_confirmed", "recursive_delegation_confirmed", "system_skill_activation_confirmed", "child_prompt_submitted",
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

function projectedSystemSkillActivationIsExact(
  view: RunTaskView,
  declarations: OwnerRequestDeclarations,
  promptSubmitted: boolean,
): boolean {
  const hasReceipt = hasOwnDefined(view, "system_skill_activation_receipt");
  if (!hasReceipt) return !(promptSubmitted && declarations.systemSkillName !== undefined);
  if (!declarations.systemSkillName || !view.system_skill_activation_receipt) return false;
  return validatedSystemSkillActivationReceipt({
    value: view.system_skill_activation_receipt,
    expectedName: declarations.systemSkillName,
    expectedPath: view.system_skill_activation_receipt.resolved_skill_path,
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
      hasOwnDefined(view, "resolved_recursive_delegation") || hasOwnDefined(view, "recursive_delegation_receipt") ||
      hasOwnDefined(view, "system_skill_activation_receipt")
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
    !projectedSystemSkillActivationIsExact(view, declarations, promptSubmitted) ||
    !activationFamiliesJoinExactly(view)
  ) return null;
  return {
    observation: { tag: "observed", child_prompt_submitted: promptSubmitted },
    settlement: { tag: "settled", expected_event: expectedEvent },
  };
}

function ownerOutputClosureIsExact(view: RunTaskView, restartDrift: boolean): boolean {
  const outputReferences = view.output_references;
  if (!Array.isArray(outputReferences) || hasOwnDefined(view, "output_path")) return false;
  if (!restartDrift || view.partial_output_available === false) {
    return view.partial_output_available === false && outputReferences.length === 0;
  }
  if (outputReferences.length !== 1) return false;
  const reference = decodeRunOutputReference(outputReferences[0]);
  return reference?.name === "primary" && reference.output_mode === "transcript";
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
    JSON.stringify(record.output_reference) === JSON.stringify(view.output_references?.[0]) &&
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

function hasValidRecursiveEdgePromptWitness(value: unknown): value is RecursiveEdgePromptWitness {
  if (!isRecord(value) || !exactRecordKeys(value, [
    "schema_version",
    "encoding",
    "size_bytes",
    "content_sha256",
    "observation_scope",
  ])) return false;
  return value.schema_version === 1 &&
    value.encoding === "utf-8" &&
    Number.isSafeInteger(value.size_bytes) && Number(value.size_bytes) >= 0 &&
    typeof value.content_sha256 === "string" && /^[0-9a-f]{64}$/.test(value.content_sha256) &&
    value.observation_scope === "raw_recursive_delegate_prompt_received_before_host_normalization_or_child_prompt_composition";
}

function hasCurrentSnapshotStructure(view: RunTaskView): boolean {
  const hasParent = view.parent_run_id !== undefined;
  const edgeWitnessMode = view.requested_recursive_edge_witness;
  const edgePromptWitness = view.recursive_edge_prompt_witness;
  const edgeWitnessExact = edgeWitnessMode === undefined
    ? edgePromptWitness === undefined
    : edgeWitnessMode === "prompt_sha256_v1" &&
      view.requested_recursive_delegation === "enabled" &&
      (hasParent ? hasValidRecursiveEdgePromptWitness(edgePromptWitness) : edgePromptWitness === undefined);
  return view.contract_name === DURABLE_RUN_CONTRACT_NAME &&
    view.contract_version === DURABLE_RUN_CONTRACT_VERSION &&
    isNonemptyString(view.run_id) &&
    view.task_id === view.run_id &&
    (view.task_kind === "run" || view.task_kind === "session") &&
    (!hasParent || isNonemptyString(view.parent_run_id)) &&
    edgeWitnessExact &&
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
    assertCurrentRunTaskSnapshotAdmission(view, admission);
  }
  if (hasAnyOwnField(view, RETIRED_CURRENT_RUN_FIELDS)) {
    invalidCurrentRunTaskSnapshot(view, "current durable run snapshot contains retired public fields");
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
    return await readPersistedRunView(taskRecordPath(runId));
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
  let resolveSystemSkillActivation!: (receipt: SystemSkillActivationReceipt | undefined) => void;
  const systemSkillActivationPromise = new Promise<SystemSkillActivationReceipt | undefined>((resolve) => {
    resolveSystemSkillActivation = resolve;
  });
  const state: RunTaskState = {
    runId,
    startedAt,
    mailboxRoot,
    inputRequestsDir: path.join(mailboxRoot, runId),
    inputRequests: [],
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
    systemSkillActivationObservation: {
      promise: systemSkillActivationPromise,
      resolve: resolveSystemSkillActivation,
    },
    ...(sessionKey ? { sessionKey } : {}),
    ...(lineage.parentRunId ? { parentRunId: lineage.parentRunId } : {}),
    ...(lineage.recursiveEdgePromptWitness
      ? { recursiveEdgePromptWitness: lineage.recursiveEdgePromptWitness }
      : {}),
    rootRunId: lineage.rootRunId ?? runId,
    recursionDepth: lineage.recursionDepth ?? 0,
    childRunIds: [],
    descendantRunIds: [],
    descendantTerminalStatuses: {},
    acceptedInputResponses: new Map(),
    pendingInputDeliveries: new Map(),
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
> {
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
  "parent_run_id" | "recursive_edge_prompt_witness" | "root_run_id" | "recursion_depth" | "child_run_ids" | "descendant_run_ids" | "descendant_terminal_statuses"
> {
  return {
    ...(state.parentRunId ? { parent_run_id: state.parentRunId } : {}),
    ...(state.recursiveEdgePromptWitness
      ? { recursive_edge_prompt_witness: state.recursiveEdgePromptWitness }
      : {}),
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
  "requested_effect_profile" | "resolved_effect_profile" | "expected_skill_sha256" | "activation_receipt" | "skill_snapshot_binding" | "skill_snapshot_activation_receipt" | "requested_recursive_delegation" | "resolved_recursive_delegation" | "recursive_delegation_receipt" | "requested_recursive_edge_witness" | "requested_system_skill" | "system_skill_activation_receipt"
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
    ...(state.requestedRecursiveEdgeWitness
      ? { requested_recursive_edge_witness: state.requestedRecursiveEdgeWitness }
      : {}),
    ...(state.requestedSystemSkill ? { requested_system_skill: state.requestedSystemSkill } : {}),
    ...(state.systemSkillActivationReceipt
      ? { system_skill_activation_receipt: state.systemSkillActivationReceipt }
      : {}),
  };
}

function activeRunTaskView(state: RunTaskState, inputRequests: InputRequestView[]): RunTaskView {
  const hasPendingInput = inputRequests.some((request) => request.status === "pending");
  return {
    ...contractFields(),
    run_id: state.runId,
    task_id: state.runId,
    task_kind: state.taskKind,
    ...lineageView(state),
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

function cloneRunTaskTransitionState(state: RunTaskState): RunTaskState {
  return {
    ...state,
    recentEvents: [...state.recentEvents],
    childRunIds: [...state.childRunIds],
    descendantRunIds: [...state.descendantRunIds],
    descendantTerminalStatuses: { ...state.descendantTerminalStatuses },
    acceptedInputResponses: new Map(state.acceptedInputResponses),
    pendingInputDeliveries: new Map(state.pendingInputDeliveries),
    inputRequests: state.inputRequests.map((request) => ({ ...request })),
  };
}

function notifyResidentRunTaskPublication(runId: string): void {
  const waiters = residentPublicationWaiters.get(runId);
  if (!waiters) return;
  for (const waiter of [...waiters]) waiter();
}

function publishRunTaskTransitionState(state: RunTaskState, draft: RunTaskState): void {
  state.finishedAt = draft.finishedAt;
  state.inputRequests = draft.inputRequests;
  state.result = draft.result;
  state.error = draft.error;
  state.cancelRequested = draft.cancelRequested;
  state.heartbeatCount = draft.heartbeatCount;
  state.lastProgressAt = draft.lastProgressAt;
  state.lastProgressMessage = draft.lastProgressMessage;
  state.activePhase = draft.activePhase;
  state.lastPhaseAt = draft.lastPhaseAt;
  state.lastChildLifecycleEvent = draft.lastChildLifecycleEvent;
  state.lastChildLifecycleAt = draft.lastChildLifecycleAt;
  state.firstPublicOutputAt = draft.firstPublicOutputAt;
  state.recentEvents = draft.recentEvents;
  state.lastPublicOutputExcerpt = draft.lastPublicOutputExcerpt;
  state.terminalSnapshotStarted = draft.terminalSnapshotStarted;
  state.cwd = draft.cwd;
  state.failureLogTool = draft.failureLogTool;
  state.sessionKey = draft.sessionKey;
  state.parentRunId = draft.parentRunId;
  state.requestedRecursiveEdgeWitness = draft.requestedRecursiveEdgeWitness;
  state.recursiveEdgePromptWitness = draft.recursiveEdgePromptWitness;
  state.rootRunId = draft.rootRunId;
  state.recursionDepth = draft.recursionDepth;
  state.childRunIds = draft.childRunIds;
  state.descendantRunIds = draft.descendantRunIds;
  state.descendantTerminalStatuses = draft.descendantTerminalStatuses;
  state.childControlSend = draft.childControlSend;
  state.acceptedInputResponses = draft.acceptedInputResponses;
  state.pendingInputDeliveries = draft.pendingInputDeliveries;
  state.terminalizing = draft.terminalizing;
  state.partialOutputPath = draft.partialOutputPath;
  state.pendingTerminalOutputs = draft.pendingTerminalOutputs;
  state.childStarted = draft.childStarted;
  state.queuedAt = draft.queuedAt;
  state.childStartedAt = draft.childStartedAt;
  state.capacityReleased = draft.capacityReleased;
  state.clientStartBinding = draft.clientStartBinding;
  state.requestedEffectProfile = draft.requestedEffectProfile;
  state.activationReceipt = draft.activationReceipt;
  state.skillSnapshotBinding = draft.skillSnapshotBinding;
  state.skillSnapshotActivationReceipt = draft.skillSnapshotActivationReceipt;
  state.recursiveDelegationReceipt = draft.recursiveDelegationReceipt;
  state.requestedRecursiveDelegation = draft.requestedRecursiveDelegation;
  state.requestedSystemSkill = draft.requestedSystemSkill;
  state.governingModelClass = draft.governingModelClass;
  state.systemSkillActivationReceipt = draft.systemSkillActivationReceipt;
  state.expectedSkillSha256 = draft.expectedSkillSha256;
  state.claimDeclarations = draft.claimDeclarations;
  state.ownerLaunchObservation = draft.ownerLaunchObservation;
  pendingResidentPublications.add(state.runId);
}

function runTaskViewFromState(
  state: RunTaskState,
  inputRequests: InputRequestView[],
  allowUnreleasedTerminal = false,
): RunTaskView {
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

async function commitActiveRunTransition(
  state: RunTaskState,
  apply: (
    draft: RunTaskState,
    stagedEvents: CanonicalRunPublicEvent[],
  ) => boolean | Promise<boolean>,
): Promise<RunTaskView> {
  return withRunOwner(state.runId, async () => {
    if (tasks.get(state.runId) !== state) {
      throw taskNotFound(state.runId);
    }
    if (state.terminalSnapshotStarted || state.result || state.error) {
      return runTaskViewFromState(
        state,
        state.inputRequests,
      );
    }
    const draft = cloneRunTaskTransitionState(state);
    const stagedEvents: CanonicalRunPublicEvent[] = [];
    const changed = await apply(draft, stagedEvents);
    const inputRequests = draft.inputRequests;
    if (!changed) {
      if (stagedEvents.length > 0) {
        invalidOwnerRecord("run transition produced staged events without an owner change");
      }
      return runTaskViewFromState(state, inputRequests);
    }
    const view = runTaskViewFromState(draft, inputRequests);
    publishRunTaskTransitionState(state, draft);
    return view;
  });
}

function setTaskProgress(
  state: RunTaskState,
  message: string,
  heartbeatCount = state.heartbeatCount,
  occurredAt = new Date().toISOString(),
): void {
  if (state.terminalSnapshotStarted) {
    return;
  }
  state.heartbeatCount = heartbeatCount;
  state.lastProgressAt = occurredAt;
  state.lastProgressMessage = message;
}

function projectStatusEvent(
  state: RunTaskState,
  event: RunPublicEvent,
  stagedEvents: CanonicalRunPublicEvent[],
  progressMessage = event.text,
): void {
  const written = projectPublicEvent(state, event, stagedEvents);
  setTaskProgress(state, progressMessage, state.heartbeatCount, written.occurred_at);
}

function childLifecycleProjectionBaseline(state: RunTaskState): ChildLifecycleProjectionBaseline {
  return {
    activePhase: state.activePhase,
    lastPhaseAt: state.lastPhaseAt,
    lastChildLifecycleEvent: state.lastChildLifecycleEvent,
    lastChildLifecycleAt: state.lastChildLifecycleAt,
    lastProgressAt: state.lastProgressAt,
    lastProgressMessage: state.lastProgressMessage,
    heartbeatCount: state.heartbeatCount,
    firstPublicOutputAt: state.firstPublicOutputAt,
  };
}

function sameChildLifecycleProjectionBaseline(
  state: RunTaskState,
  baseline: ChildLifecycleProjectionBaseline,
): boolean {
  return state.activePhase === baseline.activePhase &&
    state.lastPhaseAt === baseline.lastPhaseAt &&
    state.lastChildLifecycleEvent === baseline.lastChildLifecycleEvent &&
    state.lastChildLifecycleAt === baseline.lastChildLifecycleAt &&
    state.lastProgressAt === baseline.lastProgressAt &&
    state.lastProgressMessage === baseline.lastProgressMessage &&
    state.heartbeatCount === baseline.heartbeatCount &&
    state.firstPublicOutputAt === baseline.firstPublicOutputAt;
}

function childLifecycleGenerationPrecedes(
  current: ChildLifecycleEventName | undefined,
  incoming: ChildLifecycleEventName,
): boolean {
  return current === undefined ||
    CHILD_LIFECYCLE_GENERATION[current].sequence < CHILD_LIFECYCLE_GENERATION[incoming].sequence;
}

function hasCoherentChildLifecycleProjection(state: RunTaskState): boolean {
  return state.lastChildLifecycleEvent !== undefined &&
    state.lastChildLifecycleAt !== undefined &&
    state.activePhase === "running_silent" &&
    state.lastPhaseAt === state.lastChildLifecycleAt &&
    state.lastProgressAt === state.lastChildLifecycleAt &&
    state.lastProgressMessage === CHILD_LIFECYCLE_GENERATION[state.lastChildLifecycleEvent].progressMessage;
}

function canProjectWrittenChildLifecycleEvent(
  state: RunTaskState,
  event: ChildLifecycleEventName,
  baseline: ChildLifecycleProjectionBaseline,
): boolean {
  if (
    state.terminalizing ||
    state.result ||
    state.error ||
    state.cancelRequested ||
    (state.activePhase !== "starting" &&
      state.activePhase !== "awaiting_child_event" &&
      state.activePhase !== "running_silent") ||
    !childLifecycleGenerationPrecedes(baseline.lastChildLifecycleEvent, event)
  ) {
    return false;
  }
  if (sameChildLifecycleProjectionBaseline(state, baseline)) {
    return true;
  }
  return hasCoherentChildLifecycleProjection(state) &&
    state.heartbeatCount === baseline.heartbeatCount &&
    state.firstPublicOutputAt === baseline.firstPublicOutputAt &&
    childLifecycleGenerationPrecedes(state.lastChildLifecycleEvent, event);
}

function projectWrittenChildLifecycleEvent(
  state: RunTaskState,
  written: RunPublicEvent & { event: ChildLifecycleEventName },
  baseline: ChildLifecycleProjectionBaseline,
): void {
  if (state.terminalSnapshotStarted) {
    return;
  }
  const events = [...state.recentEvents, written];
  state.recentEvents = recentEventsProjection(events);
  state.lastPublicOutputExcerpt = publicOutputExcerptProjection(events);
  if (state.lastChildLifecycleAt && state.lastChildLifecycleAt.localeCompare(written.occurred_at) > 0) {
    return;
  }
  if (!canProjectWrittenChildLifecycleEvent(state, written.event, baseline)) {
    return;
  }
  state.activePhase = "running_silent";
  state.lastPhaseAt = written.occurred_at;
  state.lastChildLifecycleEvent = written.event;
  state.lastChildLifecycleAt = written.occurred_at;
  state.lastProgressAt = written.occurred_at;
  state.lastProgressMessage = CHILD_LIFECYCLE_GENERATION[written.event].progressMessage;
}

function projectChildLifecycleEvent(
  state: RunTaskState,
  event: ChildLifecycleEventName,
  text: string,
  stagedEvents: CanonicalRunPublicEvent[],
  options: { occurredAt?: string; metadata?: Record<string, unknown> } = {},
): void {
  const occurredAt = options.occurredAt ?? new Date().toISOString();
  const baseline = childLifecycleProjectionBaseline(state);
  const written = canonicalRunPublicEvent({
    kind: "child",
    event,
    text,
    occurred_at: occurredAt,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  }) as CanonicalRunPublicEvent & { event: ChildLifecycleEventName };
  stagedEvents.push(written);
  projectWrittenChildLifecycleEvent(
    state,
    written,
    baseline,
  );
}

function projectPublicEvent(
  state: RunTaskState,
  event: RunPublicEvent,
  stagedEvents: CanonicalRunPublicEvent[],
): CanonicalRunPublicEvent {
  const written = canonicalRunPublicEvent(event);
  stagedEvents.push(written);
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
  await commitActiveRunTransition(parent, (draft, stagedEvents) => {
    projectStatusEvent(draft, event, stagedEvents, progressMessage);
    return true;
  });
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

async function recordDescendantTerminalLineage(
  ancestor: RunTaskState,
  childRunId: string,
  status: RunTaskTerminalStatus,
): Promise<RunTaskView> {
  return withRunClaimOwner(ancestor, async () => {
    if (tasks.get(ancestor.runId) !== ancestor) throw taskNotFound(ancestor.runId);
    if (ancestor.terminalSnapshotStarted || ancestor.result || ancestor.error) {
      return runTaskViewFromState(ancestor, ancestor.inputRequests);
    }
    const draft = cloneRunTaskTransitionState(ancestor);
    if (draft.descendantTerminalStatuses[childRunId] === status) {
      return runTaskViewFromState(ancestor, ancestor.inputRequests);
    }
    draft.descendantTerminalStatuses = {
      ...draft.descendantTerminalStatuses,
      [childRunId]: status,
    };
    const committed = await writeRunClaimOwned(
      runTaskViewFromState(draft, draft.inputRequests),
      runClaimPersistenceEvidence(draft),
    );
    publishRunTaskTransitionState(ancestor, draft);
    return committed;
  });
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
    await recordDescendantTerminalLineage(ancestor, child.runId, status);
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
  let progressMessage = message ?? DEFAULT_HEARTBEAT_MESSAGE;
  await commitActiveRunTransition(state, (draft) => {
    const hasPublicOutput = draft.firstPublicOutputAt !== undefined;
    progressMessage = hasPublicOutput
      ? message ?? DEFAULT_HEARTBEAT_MESSAGE
      : "child alive; waiting for first public output";
    if (beat < draft.heartbeatCount) return false;
    if (beat === draft.heartbeatCount) {
      if (draft.lastProgressMessage === progressMessage) return false;
      invalidOwnerRecord("heartbeat identity conflicts with its prior progress");
    }
    if (!hasPublicOutput && (draft.activePhase === "awaiting_child_event" || draft.activePhase === "running_silent")) {
      setTaskPhase(draft, "running_silent");
    } else if (hasPublicOutput && (draft.activePhase === "awaiting_child_event" || draft.activePhase === "running_silent")) {
      setTaskPhase(draft, "running");
    }
    setTaskProgress(draft, progressMessage, beat);
    return true;
  });
  await notify?.(beat, progressMessage);
}

function appendRunStartedEvent(
  state: RunTaskState,
  request: RunSubagentRequest | RunSubagentSessionRequest,
  stagedEvents: CanonicalRunPublicEvent[],
): void {
  projectStatusEvent(state, {
    kind: "task",
    event: "run_started",
    text: `[run_started] ${state.taskKind} ${state.runId}`,
    occurred_at: state.startedAt,
    metadata: {
      task_kind: state.taskKind,
      cwd: typeof request.cwd === "string" ? request.cwd : undefined,
      tool: state.failureLogTool,
    },
  }, stagedEvents, DEFAULT_HEARTBEAT_MESSAGE);
  if (typeof request.prompt === "string" && request.prompt.trim() !== "") {
    projectPublicEvent(state, {
      kind: "user",
      event: "message",
      text: `[user]\n${PUBLIC_PROMPT_REDACTED_MARKER}`,
      occurred_at: state.startedAt,
    }, stagedEvents);
  }
  const skill = skillBindingForPublicMarker(request);
  if (skill) {
    projectPublicEvent(state, {
      kind: "task",
      event: "message",
      text: serverContractSkillMarker(skill),
      occurred_at: state.startedAt,
    }, stagedEvents);
  }
  if ("packet_policy" in request && request.packet_policy && request.packet_policy !== "none") {
    projectPublicEvent(state, {
      kind: "packet",
      event: "message",
      text: serverContractPacketMarker(request.packet_policy),
      occurred_at: state.startedAt,
    }, stagedEvents);
  }
}

async function prepareChildRun(state: RunTaskState): Promise<void> {
  await commitActiveRunTransition(state, (draft) => {
    const occurredAt = new Date().toISOString();
    setTaskPhase(draft, "starting", occurredAt);
    setTaskProgress(draft, "preparing child process");
    return true;
  });
}

function bindRequestToRunTaskState(
  state: RunTaskState,
  request: RunSubagentRequest | RunSubagentSessionRequest,
): void {
  state.cwd = typeof request.cwd === "string" ? request.cwd : undefined;
  if ("effect_profile" in request) state.requestedEffectProfile = request.effect_profile;
  if ("expected_skill_sha256" in request) state.expectedSkillSha256 = request.expected_skill_sha256;
  if ("skill_snapshot_binding" in request) state.skillSnapshotBinding = request.skill_snapshot_binding;
  if ("recursive_delegation" in request) state.requestedRecursiveDelegation = request.recursive_delegation;
  if ("recursive_edge_witness" in request) state.requestedRecursiveEdgeWitness = request.recursive_edge_witness;
  if ("system_skill_name" in request) state.requestedSystemSkill = request.system_skill_name;
}

async function registerRunTaskState(
  state: RunTaskState,
  request: RunSubagentRequest | RunSubagentSessionRequest,
): Promise<void> {
  ensureClaimDeclarations(state, request);
  bindRequestToRunTaskState(state, request);
  tasks.set(state.runId, state);
  await withRunClaimOwner(state, async () => {
    if (tasks.get(state.runId) !== state) throw taskNotFound(state.runId);
    const draft = cloneRunTaskTransitionState(state);
    const stagedEvents: CanonicalRunPublicEvent[] = [];
    appendRunStartedEvent(draft, request, stagedEvents);
    const nextView = runTaskViewFromState(draft, draft.inputRequests);
    const existingRecord = await readRunOwnerRecordFile(taskRecordPath(state.runId)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (existingRecord) {
      assertOwnerViewTransition(currentRunClaimView(existingRecord), runClaimSnapshot(nextView));
      assertRunOwnerRecord(ownerRecordForSnapshot(
        nextView,
        existingRecord,
        runClaimPersistenceEvidence(draft),
      ));
    } else {
      await writeRunClaimOwned(nextView, runClaimPersistenceEvidence(draft));
    }
    publishRunTaskTransitionState(state, draft);
  });
}

async function recordParentChildLineage(
  ancestor: RunTaskState,
  childRunId: string,
  directParent: boolean,
): Promise<void> {
  await withRunClaimOwner(ancestor, async () => {
    if (tasks.get(ancestor.runId) !== ancestor) throw taskNotFound(ancestor.runId);
    if (ancestor.terminalSnapshotStarted || ancestor.result || ancestor.error) return;
    const draft = cloneRunTaskTransitionState(ancestor);
    let changed = false;
    if (directParent && !draft.childRunIds.includes(childRunId)) {
      draft.childRunIds = [...draft.childRunIds, childRunId];
      changed = true;
    }
    if (!draft.descendantRunIds.includes(childRunId)) {
      draft.descendantRunIds = [...draft.descendantRunIds, childRunId];
      changed = true;
    }
    if (!changed) return;
    await writeRunClaimOwned(
      runTaskViewFromState(draft, draft.inputRequests),
      runClaimPersistenceEvidence(draft),
    );
    publishRunTaskTransitionState(ancestor, draft);
  });
}

async function recordParentChildRun(state: RunTaskState): Promise<void> {
  if (!state.parentRunId) {
    return;
  }
  const parent = tasks.get(state.parentRunId);
  if (!parent) {
    return;
  }
  let ancestor: RunTaskState | undefined = parent;
  while (ancestor) {
    await recordParentChildLineage(ancestor, state.runId, ancestor.runId === parent.runId);
    ancestor = ancestor.parentRunId ? tasks.get(ancestor.parentRunId) : undefined;
  }
  await appendParentRecursiveChildStartedEvent(state);
}

async function settleDescendantSubtreeBeforeTerminal(
  state: RunTaskState,
  terminal: RunTaskTerminalIntent,
): Promise<void> {
  let children: RunTaskState[] = [];
  let cancelRequested = false;
  await commitActiveRunTransition(state, (draft) => {
    children = draft.childRunIds
      .map((id) => tasks.get(id))
      .filter((child): child is RunTaskState => Boolean(child));
    cancelRequested = draft.cancelRequested;
    if (children.length === 0) return false;
    setTaskProgress(draft, "waiting for recursive descendants to settle");
    return true;
  });
  if (children.length === 0) return;
  const abnormal = cancelRequested || Boolean(terminal.error) ||
    (terminal.result !== undefined && !terminal.result.success);
  if (abnormal) {
    for (const child of children) {
      if (!child.terminalSnapshotStarted) child.abortController.abort();
    }
  }
  await Promise.allSettled(children.map((child) => child.promise));
}

function activeRecursiveCaller(caller: RecursiveCallerLineage): RunTaskState {
  const parent = tasks.get(caller.parentRunId);
  if (!parent || parent.terminalSnapshotStarted || parent.result || parent.error) {
    throw new ValidationError(
      `recursive caller parent run is not active: ${caller.parentRunId}`,
      "recursive_control_invalid",
    );
  }
  if (
    parent.rootRunId !== caller.rootRunId ||
    parent.recursionDepth !== caller.recursionDepth ||
    parent.requestedRecursiveDelegation !== "enabled"
  ) {
    throw new ValidationError(
      "recursive caller lineage does not match the active parent run",
      "recursive_control_invalid",
    );
  }
  return parent;
}

export function governingModelClassForRecursiveDelegate(
  caller: RecursiveCallerLineage,
): ModelClass | undefined {
  return activeRecursiveCaller(caller).governingModelClass;
}

export function lineageForRecursiveDelegate(
  caller: RecursiveCallerLineage,
  rawPrompt: unknown,
): RunTaskLineage & { requestedRecursiveEdgeWitness?: NonNullable<RunSubagentRequest["recursive_edge_witness"]> } {
  const parent = activeRecursiveCaller(caller);
  const requestedRecursiveEdgeWitness = parent.requestedRecursiveEdgeWitness;
  let recursiveEdgePromptWitness: RecursiveEdgePromptWitness | undefined;
  if (requestedRecursiveEdgeWitness) {
    if (typeof rawPrompt !== "string") {
      throw new ValidationError(
        "witnessed recursive delegate prompt must be a string",
        "recursive_control_invalid",
      );
    }
    const bytes = Buffer.from(rawPrompt, "utf8");
    recursiveEdgePromptWitness = {
      schema_version: 1,
      encoding: "utf-8",
      size_bytes: bytes.byteLength,
      content_sha256: createHash("sha256").update(bytes).digest("hex"),
      observation_scope: "raw_recursive_delegate_prompt_received_before_host_normalization_or_child_prompt_composition",
    };
  }
  return {
    parentRunId: parent.runId,
    rootRunId: parent.rootRunId,
    recursionDepth: parent.recursionDepth + 1,
    ...(requestedRecursiveEdgeWitness ? { requestedRecursiveEdgeWitness } : {}),
    ...(recursiveEdgePromptWitness ? { recursiveEdgePromptWitness } : {}),
  };
}

export type PrivateRecursiveRunTaskView = RunTaskView & Record<string, unknown> & {
  /** Complete public primary output, available only over recursive control. */
  primary_output?: string;
};

/**
 * Keeps the public durable view unchanged while making an authorized terminal
 * descendant's already-public primary artifact consumable by its Pi parent.
 */
export async function projectPrivateRecursiveRunResult(
  view: RunTaskView,
): Promise<PrivateRecursiveRunTaskView> {
  if (!isTerminalRunStatus(view.status)) return { ...view };
  const primary = view.output_references
    ?.map((reference) => decodeRunOutputReference(reference))
    .find((reference) => reference?.name === "primary");
  if (!primary) return { ...view };
  try {
    return {
      ...view,
      primary_output: await readValidatedRunOutput(primary),
    };
  } catch {
    throw new ValidationError(
      "recursive terminal primary output is unavailable",
      "recursive_control_invalid",
    );
  }
}

export async function rejoinRecursiveDescendantRun(
  caller: RecursiveCallerLineage,
  descendantRunId: string,
  waitMs: unknown,
): Promise<RunTaskView> {
  const parent = activeRecursiveCaller(caller);
  if (
    typeof descendantRunId !== "string" ||
    descendantRunId.trim() === "" ||
    !parent.descendantRunIds.includes(descendantRunId)
  ) {
    throw new ValidationError(
      "recursive rejoin run_id is not a descendant of the active caller",
      "recursive_control_invalid",
    );
  }
  // Authorization is complete before this reads any descendant state. The
  // existing owner-backed get_run wait preserves truthful active/terminal
  // views and the established terminal output-reference transport.
  return getRunTask(descendantRunId, false, waitMs);
}

export async function waitForObservedSkillSnapshotActivation(
  runId: string,
): Promise<RunSubagentResult["skill_snapshot_activation_receipt"] | undefined> {
  const state = tasks.get(runId);
  if (!state) return undefined;
  return state.skillSnapshotActivationReceipt ?? state.skillSnapshotActivationObservation.promise;
}

export async function waitForObservedSystemSkillActivation(
  runId: string,
): Promise<SystemSkillActivationReceipt | undefined> {
  const state = tasks.get(runId);
  if (!state) return undefined;
  return state.systemSkillActivationReceipt ?? state.systemSkillActivationObservation.promise;
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
    const terminalError = error instanceof Error ? error : new Error(String(error));
    await finalizeRegisteredRunTask(
      state,
      childLease,
      "run registration failed",
      { error: terminalError },
    );
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
      if (alreadyRegistered) {
        await commitActiveRunTransition(state, (draft) => {
          draft.queuedAt = admission.ticket.queuedAt;
          setTaskPhase(draft, "queued", admission.ticket.queuedAt);
          setTaskProgress(draft, "queued; waiting for local child capacity");
          return true;
        });
      } else {
        state.queuedAt = admission.ticket.queuedAt;
        setTaskPhase(state, "queued", admission.ticket.queuedAt);
        setTaskProgress(state, "queued; waiting for local child capacity");
      }
    }
    if (!alreadyRegistered) {
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

async function cleanupUncommittedTerminalOutputs(
  state: RunTaskState,
  terminal: RunTaskTerminalIntent,
): Promise<void> {
  const pending = state.pendingTerminalOutputs;
  if (!pending) return;
  if (
    terminal.result &&
    "output_references" in terminal.result &&
    terminalReferencesOwnPendingOutputs(terminal.result.output_references, pending)
  ) {
    return;
  }
  try {
    await cleanupPendingTerminalOutputs(pending);
    await clearPendingTerminalOutputs(state, pending);
  } catch (error) {
    console.error(
      `[subagent007 warning] pending terminal output cleanup failed for run ${state.runId}: ${String(error)}`,
    );
    // The exact ownership stays in the durable run claim for startup retry.
  }
}

async function finalizeRegisteredRunTask(
  state: RunTaskState,
  childLease: ActiveChildLease,
  closeReason: string,
  terminal: RunTaskTerminalIntent = {},
): Promise<void> {
  let terminalDurable = false;
  try {
    await settleDescendantSubtreeBeforeTerminal(state, terminal);
    await cleanupUncommittedTerminalOutputs(state, terminal);
    await settleRunClaim(state, closeReason, terminal);
    terminalDurable = true;
  } finally {
    terminalDurable ||= await hasDurableTerminalSnapshot(state.runId);
    if (terminalDurable) {
      const capacityReleased = await releaseChildLease(childLease);
      const capacityPublication = await withRunOwner(state.runId, async () => {
        if (tasks.get(state.runId) !== state) return false;
        state.capacityReleased = capacityReleased;
        return true;
      });
      if (capacityPublication) notifyResidentRunTaskPublication(state.runId);
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
    console.error(
      `[subagent007 background failure] run_id=${state.runId} ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

function planClosedInputRequests(
  inputRequests: InputRequestView[],
  settledAt: string,
  reason: string,
): { inputRequests: InputRequestView[]; closed: InputTerminalRecord[] } {
  const closed = inputRequests
    .filter((request) => request.status === "pending")
    .map((request): InputTerminalRecord => ({
      schema_version: 2,
      request_id: request.request_id,
      status: "closed",
      settled_at: settledAt,
      reason,
    }));
  const closedIds = new Set(closed.map((record) => record.request_id));
  return {
    inputRequests: inputRequests.map((request) =>
      closedIds.has(request.request_id)
        ? {
            ...request,
            status: "closed",
            settled_at: settledAt,
            closed_at: settledAt,
          }
        : request
    ),
    closed,
  };
}

function appendClosedInputEvents(
  state: RunTaskState,
  closed: Awaited<ReturnType<typeof closePendingInputRequestsForRun>>,
  stagedEvents: CanonicalRunPublicEvent[],
): void {
  for (const request of closed) {
    projectStatusEvent(state, {
      kind: "input",
      event: "input_closed",
      text: `[input_closed] ${request.request_id}`,
      occurred_at: request.settled_at,
      metadata: {
        request_id: request.request_id,
        status: "closed",
      },
    }, stagedEvents, "input request closed");
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

async function settleRunClaim(
  state: RunTaskState,
  closeReason: string,
  terminal: RunTaskTerminalIntent,
): Promise<void> {
  let preservedTerminal = false;
  let cleanup: { committed: RunTaskView; reason: string; settledAt: string } | undefined;
  await withRunClaimOwner(state, async () => {
    const existing = await readTaskSnapshot(state.runId);
    if (existing && isTerminalRunStatus(existing.status)) {
      const draft = cloneRunTaskTransitionState(state);
      draft.finishedAt = existing.finished_at ?? new Date().toISOString();
      draft.terminalSnapshotStarted = true;
      draft.terminalizing = true;
      publishRunTaskTransitionState(state, draft);
      preservedTerminal = true;
      return;
    }
    const draft = cloneRunTaskTransitionState(state);
    const stagedEvents: CanonicalRunPublicEvent[] = [];
    if (terminal.result && terminal.error) {
      invalidOwnerRecord("run terminal transition cannot contain both a result and an error");
    }
    draft.result = terminal.result;
    draft.error = terminal.error;
    if (
      draft.pendingTerminalOutputs &&
      terminal.result &&
      "output_references" in terminal.result &&
      terminalReferencesOwnPendingOutputs(
        terminal.result.output_references,
        draft.pendingTerminalOutputs,
      )
    ) {
      draft.pendingTerminalOutputs = undefined;
    }
    draft.terminalizing = true;
    draft.finishedAt = new Date().toISOString();
    normalizeAcceptedCancellation(draft);
    normalizeOwnerTerminalError(draft);
    draft.childControlSend = undefined;
    const effectiveCloseReason = draft.cancelRequested ? "run cancelled" : closeReason;
    const inputSettlement = planClosedInputRequests(
      draft.inputRequests,
      draft.finishedAt,
      effectiveCloseReason,
    );
    draft.inputRequests = inputSettlement.inputRequests;
    appendClosedInputEvents(draft, inputSettlement.closed, stagedEvents);
    appendTerminalEvent(draft, stagedEvents);
    draft.terminalSnapshotStarted = true;
    if (!draft.result && !draft.error) invalidOwnerRecord("terminal settlement lacks owner evidence");
    const committed = await writeRunClaimOwned(
      runTaskViewFromState(draft, draft.inputRequests, true),
      runClaimPersistenceEvidence(draft),
    );
    rejectPendingInputDeliveries(
      draft,
      new ValidationError(`run is not accepting input: ${draft.runId}`, "run_not_accepting_input"),
    );
    draft.recentEvents = [...(committed.recent_events ?? draft.recentEvents)];
    draft.lastPublicOutputExcerpt = committed.last_public_output_excerpt;
    publishRunTaskTransitionState(state, draft);
    cleanup = { committed, reason: effectiveCloseReason, settledAt: draft.finishedAt };
  });
  state.skillSnapshotActivationObservation.resolve(state.skillSnapshotActivationReceipt);
  if (preservedTerminal) return;
  if (cleanup) {
    await closePendingInputRequestsForRun({
      mailboxRoot: state.mailboxRoot,
      runId: state.runId,
      reason: cleanup.reason,
      settledAt: cleanup.settledAt,
    });
    await cleanupTerminalRunStaging(cleanup.committed);
  }
  await logTerminalRunTaskFailure(state);
  await appendParentRecursiveChildFinishedEvent(state);
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
    };
  }
  if (parsed.type === "subagent007.skill_snapshot_activation_confirmed") {
    return {
      event: "skill_snapshot_activation_confirmed",
      text: "[skill_snapshot_activation_confirmed] immutable runtime snapshot confirmed",
    };
  }
  if (parsed.type === "subagent007.recursive_delegation_confirmed") {
    return {
      event: "recursive_delegation_confirmed",
      text: "[recursive_delegation_confirmed] recursive delegation authority confirmed",
    };
  }
  if (parsed.type === "subagent007.system_skill_activation_confirmed") {
    return {
      event: "system_skill_activation_confirmed",
      text: "[system_skill_activation_confirmed] governing system skill placement confirmed",
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
      };
    case "child_prompt_submitted":
      return {
        event,
        text: "[child_prompt_submitted] prompt submitted to Pi session",
      };
    case "child_session_established":
      return {
        event,
        text: "[child_session_established] Pi session established",
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
    state.recursiveDelegationReceipt !== undefined &&
    (state.requestedSystemSkill === undefined || state.systemSkillActivationReceipt !== undefined);
}

function appendTerminalEvent(
  state: RunTaskState,
  stagedEvents: CanonicalRunPublicEvent[],
): void {
  const result = state.result;
  const occurredAt = state.finishedAt ?? new Date().toISOString();
  if (result) {
    const packetEvent = packetTerminalEvent(result, occurredAt);
    if (packetEvent) {
      projectStatusEvent(state, {
        ...packetEvent,
      }, stagedEvents, packetEvent.event === "packet_accepted" ? "packet accepted" : "packet rejected");
    }
    const terminalEvent = terminalRunTaskEventDetails(result);
    projectStatusEvent(state, {
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
    }, stagedEvents, terminalEvent.progressMessage);
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
    projectStatusEvent(
      state,
      terminalEvent,
      stagedEvents,
      state.cancelRequested ? "run cancelled" : state.error.message,
    );
    setTaskPhase(state, state.cancelRequested ? "cancelled" : "failed", occurredAt);
  }
}

async function observeOutputLine(state: RunTaskState, line: string): Promise<void> {
  const lifecycle = childLifecycleFromProcessLine(line);
  const publicLine = lifecycle ? null : publicOutputLineFromProcessLine(line);
  await commitActiveRunTransition(state, async (draft, stagedEvents) => {
    if (lifecycle) {
      if (lifecycle.event === "activation_confirmed" && !draft.activationReceipt) return false;
      if (lifecycle.event === "skill_snapshot_activation_confirmed" && !draft.skillSnapshotActivationReceipt) {
        return false;
      }
      if (lifecycle.event === "recursive_delegation_confirmed" && !draft.recursiveDelegationReceipt) {
        return false;
      }
      if (lifecycle.event === "system_skill_activation_confirmed" && !draft.systemSkillActivationReceipt) {
        return false;
      }
      if (lifecycle.event === "child_prompt_submitted" && !hasCompletePrePromptOwnerObservations(draft)) {
        return false;
      }
      projectChildLifecycleEvent(
        draft,
        lifecycle.event,
        lifecycle.text,
        stagedEvents,
        {
          occurredAt: new Date().toISOString(),
          ...(lifecycle.event === "activation_confirmed" && draft.activationReceipt
            ? { metadata: { receipt: draft.activationReceipt } }
            : lifecycle.event === "skill_snapshot_activation_confirmed" && draft.skillSnapshotActivationReceipt
              ? { metadata: { receipt: draft.skillSnapshotActivationReceipt } }
            : lifecycle.event === "recursive_delegation_confirmed" && draft.recursiveDelegationReceipt
              ? { metadata: { receipt: draft.recursiveDelegationReceipt } }
            : lifecycle.event === "system_skill_activation_confirmed" && draft.systemSkillActivationReceipt
              ? { metadata: { receipt: draft.systemSkillActivationReceipt } }
            : lifecycle.metadata
              ? { metadata: lifecycle.metadata }
              : {}),
        },
      );
      return true;
    }
    if (!publicLine) {
      if (line.trim() === "" || isProcessControlMarkerLine(line) || eventObjectFromJsonLine(line)) {
        return false;
      }
      const occurredAt = new Date().toISOString();
      noteFirstPublicOutput(draft, occurredAt);
      if (draft.activePhase === "awaiting_child_event" || draft.activePhase === "running_silent") {
        setTaskPhase(draft, "running", occurredAt);
      }
      setTaskProgress(draft, "child output received");
      return true;
    }
    if (publicLine.kind === "user") return false;
    const occurredAt = new Date().toISOString();
    if (
      publicLine.event === "input_required" ||
      publicLine.event === "input_timed_out" ||
      publicLine.event === "input_closed"
    ) {
      draft.inputRequests = await listInputRequests({
        mailboxRoot: draft.mailboxRoot,
        runId: draft.runId,
      });
    }
    noteFirstPublicOutput(draft, occurredAt);
    if (publicLine.event === "input_required") {
      setTaskPhase(draft, "input_required", occurredAt);
    } else if (publicLine.kind === "assistant" || publicLine.kind === "warning" || publicLine.kind === "error") {
      setTaskPhase(draft, "running", occurredAt);
    } else if (publicLine.event === "input_timed_out" || publicLine.event === "input_closed") {
      setTaskPhase(draft, "running", occurredAt);
    }
    projectPublicEvent(draft, {
      kind: publicLine.kind,
      event: publicLine.event ?? "message",
      text: publicLine.text,
      occurred_at: occurredAt,
    }, stagedEvents);
    if (publicLine.event === "input_required") {
      setTaskProgress(draft, "input required");
    } else if (publicLine.event === "input_timed_out") {
      setTaskProgress(draft, "input timed out");
    } else if (publicLine.event === "input_closed") {
      setTaskProgress(draft, "input request closed");
    }
    return true;
  });
}

async function commitChildSpawnTransition(state: RunTaskState, occurredAt: string): Promise<void> {
  await withRunClaimOwner(state, async () => {
    if (tasks.get(state.runId) !== state) throw taskNotFound(state.runId);
    const draft = cloneRunTaskTransitionState(state);
    const childSpawnedEvent = canonicalRunPublicEvent({
      kind: "child",
      event: "child_spawned",
      text: "[child_spawned] Pi child process started",
      occurred_at: occurredAt,
    }) as CanonicalRunPublicEvent & { event: "child_spawned" };
    if (draft.childStarted) {
      const existingSpawn = draft.recentEvents.find((event) =>
        event.kind === "child" && event.event === "child_spawned"
      );
      if (existingSpawn && sameCanonicalOwnerJson(existingSpawn, childSpawnedEvent)) return;
      invalidOwnerRecord("child spawn identity conflicts with its committed observation");
    }
    if (!draft.ownerLaunchObservation) invalidOwnerRecord("child spawn has no execution grant");
    draft.childStarted = true;
    if (draft.queuedAt) draft.childStartedAt = occurredAt;
    projectWrittenChildLifecycleEvent(
      draft,
      childSpawnedEvent,
      childLifecycleProjectionBaseline(draft),
    );
    draft.inputRequests = await listInputRequests({
      mailboxRoot: draft.mailboxRoot,
      runId: draft.runId,
    });
    await writeRunClaimOwned(
      runTaskViewFromState(draft, draft.inputRequests),
      runClaimPersistenceEvidence(draft),
    );
    publishRunTaskTransitionState(state, draft);
  });
}

async function acceptActivationReceipt(
  state: RunTaskState,
  receipt: NonNullable<RunSubagentResult["activation_receipt"]>,
): Promise<void> {
  await withRunClaimOwner(state, async () => {
    if (tasks.get(state.runId) !== state) throw taskNotFound(state.runId);
    if (state.terminalSnapshotStarted || state.result || state.error) return;
    const draft = cloneRunTaskTransitionState(state);
    if (draft.activationReceipt) {
      if (sameCanonicalOwnerJson(draft.activationReceipt, receipt)) return;
      invalidOwnerRecord("activation receipt conflicts with its prior bytes");
    }
    draft.activationReceipt = receipt;
    await writeRunClaimOwned(
      runTaskViewFromState(draft, draft.inputRequests),
      runClaimPersistenceEvidence(draft),
    );
    publishRunTaskTransitionState(state, draft);
  });
}

async function acceptSkillSnapshotActivationReceipt(
  state: RunTaskState,
  receipt: NonNullable<RunSubagentResult["skill_snapshot_activation_receipt"]>,
): Promise<void> {
  await withRunClaimOwner(state, async () => {
    if (tasks.get(state.runId) !== state) throw taskNotFound(state.runId);
    if (state.terminalSnapshotStarted || state.result || state.error) return;
    const draft = cloneRunTaskTransitionState(state);
    if (draft.skillSnapshotActivationReceipt) {
      if (sameCanonicalOwnerJson(draft.skillSnapshotActivationReceipt, receipt)) return;
      invalidOwnerRecord("skill snapshot receipt conflicts with its prior bytes");
    }
    draft.skillSnapshotActivationReceipt = receipt;
    await writeRunClaimOwned(
      runTaskViewFromState(draft, draft.inputRequests),
      runClaimPersistenceEvidence(draft),
    );
    publishRunTaskTransitionState(state, draft);
  });
  state.skillSnapshotActivationObservation.resolve(state.skillSnapshotActivationReceipt);
}

async function acceptSystemSkillActivationReceipt(
  state: RunTaskState,
  receipt: SystemSkillActivationReceipt,
): Promise<void> {
  await withRunClaimOwner(state, async () => {
    if (tasks.get(state.runId) !== state) throw taskNotFound(state.runId);
    if (state.terminalSnapshotStarted || state.result || state.error) return;
    const draft = cloneRunTaskTransitionState(state);
    if (draft.systemSkillActivationReceipt) {
      if (sameCanonicalOwnerJson(draft.systemSkillActivationReceipt, receipt)) return;
      invalidOwnerRecord("system skill receipt conflicts with its prior bytes");
    }
    draft.systemSkillActivationReceipt = receipt;
    await writeRunClaimOwned(
      runTaskViewFromState(draft, draft.inputRequests),
      runClaimPersistenceEvidence(draft),
    );
    publishRunTaskTransitionState(state, draft);
  });
  state.systemSkillActivationObservation.resolve(state.systemSkillActivationReceipt);
}

async function acceptRecursiveDelegationReceipt(
  state: RunTaskState,
  receipt: RecursiveDelegationReceipt,
): Promise<void> {
  await withRunClaimOwner(state, async () => {
    if (tasks.get(state.runId) !== state) throw taskNotFound(state.runId);
    if (state.terminalSnapshotStarted || state.result || state.error) return;
    const draft = cloneRunTaskTransitionState(state);
    if (draft.recursiveDelegationReceipt) {
      if (sameCanonicalOwnerJson(draft.recursiveDelegationReceipt, receipt)) return;
      invalidOwnerRecord("recursive delegation receipt conflicts with its prior bytes");
    }
    draft.recursiveDelegationReceipt = receipt;
    await writeRunClaimOwned(
      runTaskViewFromState(draft, draft.inputRequests),
      runClaimPersistenceEvidence(draft),
    );
    publishRunTaskTransitionState(state, draft);
  });
}

async function grantRunClaimFromLaunchObservation(state: RunTaskState, observation: unknown): Promise<void> {
  await withRunClaimOwner(state, async () => {
    if (tasks.get(state.runId) !== state) throw taskNotFound(state.runId);
    if (state.terminalSnapshotStarted || state.result || state.error) return;
    const typedObservation = observation as Parameters<typeof recordOwnerLaunchObservation>[1];
    if (
      typedObservation.governingModelClass !== undefined &&
      (!typedObservation.systemSkillName || !MODEL_CLASS_SET.has(typedObservation.governingModelClass))
    ) {
      invalidOwnerRecord("governed model class is not bound to a governing system skill");
    }
    const draft = cloneRunTaskTransitionState(state);
    if (typedObservation.governingModelClass !== undefined) {
      if (draft.governingModelClass && draft.governingModelClass !== typedObservation.governingModelClass) {
        invalidOwnerRecord("governed model class changed after launch observation");
      }
      draft.governingModelClass = typedObservation.governingModelClass;
    }
    recordOwnerLaunchObservation(
      draft,
      typedObservation,
    );
    if (!draft.ownerLaunchObservation) invalidOwnerRecord("execution grant lacks launch evidence");
    await writeRunClaimOwned(
      runTaskViewFromState(draft, draft.inputRequests),
      runClaimPersistenceEvidence(draft),
    );
    publishRunTaskTransitionState(state, draft);
  });
}

async function acceptPendingTerminalOutputs(
  state: RunTaskState,
  ownership: PendingTerminalOutputs,
): Promise<void> {
  assertPendingTerminalOutputs(ownership, state.runId);
  await withRunClaimOwner(state, async () => {
    if (tasks.get(state.runId) !== state) throw taskNotFound(state.runId);
    if (state.terminalSnapshotStarted || state.result || state.error) {
      invalidOwnerRecord("terminal output ownership arrived after terminalization");
    }
    const draft = cloneRunTaskTransitionState(state);
    if (draft.pendingTerminalOutputs) {
      if (sameCanonicalOwnerJson(draft.pendingTerminalOutputs, ownership)) return;
      invalidOwnerRecord("pending terminal output ownership conflicts with its prior bytes");
    }
    draft.pendingTerminalOutputs = ownership;
    await writeRunClaimOwned(
      runTaskViewFromState(draft, draft.inputRequests),
      runClaimPersistenceEvidence(draft),
    );
    publishRunTaskTransitionState(state, draft);
  });
}

async function clearPendingTerminalOutputs(
  state: RunTaskState,
  ownership: PendingTerminalOutputs,
): Promise<void> {
  assertPendingTerminalOutputs(ownership, state.runId);
  await withRunClaimOwner(state, async () => {
    if (tasks.get(state.runId) !== state) throw taskNotFound(state.runId);
    if (!state.pendingTerminalOutputs) return;
    if (!sameCanonicalOwnerJson(state.pendingTerminalOutputs, ownership)) {
      invalidOwnerRecord("pending terminal output cleanup identity changed");
    }
    const draft = cloneRunTaskTransitionState(state);
    draft.pendingTerminalOutputs = undefined;
    await writeRunClaimOwned(
      runTaskViewFromState(draft, draft.inputRequests),
      runClaimPersistenceEvidence(draft),
    );
    publishRunTaskTransitionState(state, draft);
  });
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
  onTerminalOutputsPrepared: (ownership: PendingTerminalOutputs) => Promise<void>;
  onChildSpawned: (occurredAt: string) => Promise<void>;
  onActivationConfirmed: (receipt: NonNullable<RunSubagentResult["activation_receipt"]>) => Promise<void>;
  onSkillSnapshotActivationConfirmed: (receipt: NonNullable<RunSubagentResult["skill_snapshot_activation_receipt"]>) => Promise<void>;
  onRecursiveDelegationConfirmed: (receipt: RecursiveDelegationReceipt) => Promise<void>;
  onSystemSkillActivationConfirmed: (receipt: SystemSkillActivationReceipt) => Promise<void>;
  onOwnerLaunchObservation: (observation: unknown) => Promise<void>;
} {
  return {
    heartbeat: (beat, message) => handleTaskHeartbeat(state, beat, message, options.heartbeat),
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    abortSignal: state.abortController.signal,
    onOutputLine: (line) => observeOutputLine(state, line),
    onActivationConfirmed: (receipt) => acceptActivationReceipt(state, receipt),
    onSkillSnapshotActivationConfirmed: (receipt) =>
      acceptSkillSnapshotActivationReceipt(state, receipt),
    onRecursiveDelegationConfirmed: (receipt) =>
      acceptRecursiveDelegationReceipt(state, receipt),
    onSystemSkillActivationConfirmed: (receipt) =>
      acceptSystemSkillActivationReceipt(state, receipt),
    // This durable grant is deliberately before writeChildRequestFile/runChildProcess.
    onOwnerLaunchObservation: (observation) => grantRunClaimFromLaunchObservation(state, observation),
    onTerminalOutputsPrepared: (ownership) => acceptPendingTerminalOutputs(state, ownership),
    onTranscriptStaged: async (stagingPath) => {
      await commitActiveRunTransition(state, (draft) => {
        if (draft.partialOutputPath === stagingPath) return false;
        draft.partialOutputPath = stagingPath;
        return true;
      });
    },
    onChildSpawned: async (occurredAt) => {
      await commitChildSpawnTransition(state, occurredAt);
    },
  };
}

function taskInputControlOptions(state: RunTaskState): {
  onChildControlReady: (send: (message: string) => boolean) => void;
  onInputResponseAccepted: (response: { requestId: string; responseId: string }) => void;
} {
  return {
    onChildControlReady: (send) => {
      void withRunOwner(state.runId, async () => {
        if (
          tasks.get(state.runId) === state &&
          !state.terminalSnapshotStarted &&
          !state.terminalizing
        ) {
          state.childControlSend = send;
        }
      }).catch((error) => {
        console.error(
          `[subagent007 warning] child control registration failed for run ${state.runId}: ${String(error)}`,
        );
      });
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

interface RestartDriftEvidence {
  finishedAt: string;
  recoveredOutput?: Awaited<ReturnType<typeof recoverStreamingRunTranscript>>;
}

function settleRunOwnerLossSnapshot(
  snapshot: RunTaskView,
  evidence: RestartDriftEvidence,
): RunTaskView {
  const sessionEvents = snapshot.recent_events ?? [];
  const sessionId = snapshot.session_id ?? sessionIdFromEvents(sessionEvents);
  const outputReferences = evidence.recoveredOutput ? [evidence.recoveredOutput] : [];
  const failureEnvelope = syntheticTerminalFailureEnvelope({
    startedAt: snapshot.started_at,
    finishedAt: evidence.finishedAt,
    errorClass: "restart_drift",
    reasonCode: "server_restarted_active_run",
    sessionId,
    sessionEstablished: snapshot.session_established ?? sessionId !== null,
    outputReferences,
    partialOutputAvailable: evidence.recoveredOutput !== undefined,
  });
  const closeReason = "MCP server restarted while run was active";
  const inputSettlement = planClosedInputRequests(snapshot.input_requests, evidence.finishedAt, closeReason);
  const terminalEvent = canonicalRunPublicEvent({
    kind: "terminal",
    event: "failed",
    text: "[failed] run is not active after MCP server restart",
    occurred_at: evidence.finishedAt,
    metadata: syntheticTerminalFailureEventMetadata(failureEnvelope),
  });
  const restartEvents = terminalEventsProjection(
    [...(snapshot.recent_events ?? []), terminalEvent]
      .filter((event) => snapshot.child_started !== false || event.kind !== "child"),
  );
  return {
    ...normalizeHistoricalSnapshotForRepublication(snapshot),
    recent_events: restartEvents,
    ...(restartEvents.length > 0
      ? { last_public_output_excerpt: publicOutputExcerptProjection(restartEvents) }
      : {}),
    status: "failed",
    finished_at: snapshot.finished_at ?? evidence.finishedAt,
    active_phase: "failed",
    last_phase_at: evidence.finishedAt,
    input_requests: inputSettlement.inputRequests,
    ...failureEnvelope,
    partial_output_path: undefined,
    error: "run is not active in this MCP server process; the server may have restarted",
  };
}

async function logRestartDriftFailure(
  snapshot: RunTaskView,
  staleView: RunTaskView,
): Promise<void> {
  const sessionEvents = snapshot.recent_events ?? [];
  await logFailure({
    tool: failureLogToolFromRunEvents(sessionEvents, snapshot.task_kind),
    failure_class: "restart_drift",
    reason_code: "server_restarted_active_run",
    cwd: cwdFromRunStartedEvent(sessionEvents),
    run_id: snapshot.run_id,
    task_kind: snapshot.task_kind,
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

function persistedOwnerView(snapshot: RunTaskView): RunTaskView {
  return {
    ...contractFields(),
    ...snapshot,
  };
}

async function persistedRunLiveness(
  snapshot: RunTaskView,
): Promise<"live" | "gone"> {
  const clientStartOwnerLiveness = await clientStartSnapshotOwnerLiveness(snapshot);
  if (clientStartOwnerLiveness === "live") return "live";
  if (clientStartOwnerLiveness === "unknown") {
    throw new ValidationError(
      "run liveness is unknown because its client_start_id owner binding cannot be verified",
      "run_liveness_unknown",
    );
  }
  if (clientStartOwnerLiveness === null) {
    const leaseLiveness = await activeChildLeaseLiveness(snapshot.run_id);
    if (leaseLiveness === "live" || await hasLiveQueuedRunTicket(snapshot.run_id)) {
      return "live";
    }
    if (leaseLiveness === "unknown") {
      throw new ValidationError(
        "run liveness is unknown because a legacy active-child lease is unreadable",
        "run_liveness_unknown",
      );
    }
  }
  return "gone";
}

async function getPersistedRunTask(runId: string): Promise<RunTaskView> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const phaseOne = await withRunOwner(runId, async (): Promise<
      | { kind: "return"; view: RunTaskView }
      | {
          kind: "inspect";
          descendantRunIds: string[];
          pendingTerminalOutputs?: PendingTerminalOutputs;
        }
    > => {
      let snapshot = await readTaskSnapshot(runId);
      if (!snapshot) {
        await reconcilePreparedClientStartCandidates();
        snapshot = await readTaskSnapshot(runId);
      }
      if (!snapshot) throw taskNotFound(runId);
      if (snapshot.status !== "working" && snapshot.status !== "input_required") {
        return { kind: "return", view: persistedOwnerView(snapshot) };
      }
      if (await persistedRunLiveness(snapshot) === "live") {
        return { kind: "return", view: persistedOwnerView(snapshot) };
      }
      const currentRecord = await readRunOwnerRecordFile(taskRecordPath(runId));
      if (!currentRecord) throw taskNotFound(runId);
      return {
        kind: "inspect",
        descendantRunIds: [...(snapshot.descendant_run_ids ?? [])],
        ...(currentRecord.pending_terminal_outputs
          ? { pendingTerminalOutputs: currentRecord.pending_terminal_outputs }
          : {}),
      };
    });
    if (phaseOne.kind === "return") return phaseOne.view;

    // No parent owner is held while descendant owners are entered.
    const descendantStatuses = new Map<string, RunTaskTerminalStatus | null>();
    for (const descendantRunId of phaseOne.descendantRunIds) {
      const descendant = await getRunTask(descendantRunId);
      descendantStatuses.set(
        descendantRunId,
        isTerminalRunStatus(descendant.status) ? descendant.status as RunTaskTerminalStatus : null,
      );
    }
    let pendingTerminalOutputsCleaned = false;
    if (phaseOne.pendingTerminalOutputs) {
      try {
        await cleanupPendingTerminalOutputs(phaseOne.pendingTerminalOutputs);
        pendingTerminalOutputsCleaned = true;
      } catch (error) {
        console.error(
          `[subagent007 warning] restart terminal-output cleanup failed for run ${runId}: ${String(error)}`,
        );
      }
    }

    let failureLog: { snapshot: RunTaskView; view: RunTaskView; settledAt: string } | undefined;
    const phaseTwo = await withRunOwner(runId, () =>
      withRunClaimLock(defaultRunTasksDir(), runId, async (): Promise<
        | { kind: "retry" }
        | { kind: "return"; view: RunTaskView }
      > => {
        const currentRecord = await readRunOwnerRecordFile(taskRecordPath(runId));
        if (!currentRecord) throw taskNotFound(runId);
        const snapshot = currentRunClaimView(currentRecord);
        if (!sameCanonicalOwnerJson(
          currentRecord.pending_terminal_outputs ?? null,
          phaseOne.pendingTerminalOutputs ?? null,
        )) {
          return { kind: "retry" };
        }
        if (snapshot.status !== "working" && snapshot.status !== "input_required") {
          return { kind: "return", view: persistedOwnerView(snapshot) };
        }
        if (await persistedRunLiveness(snapshot) === "live") {
          return { kind: "return", view: persistedOwnerView(snapshot) };
        }
        const freshDescendantRunIds = [...(snapshot.descendant_run_ids ?? [])];
        if (
          freshDescendantRunIds.length !== phaseOne.descendantRunIds.length ||
          freshDescendantRunIds.some((descendantRunId, index) =>
            descendantRunId !== phaseOne.descendantRunIds[index] || !descendantStatuses.has(descendantRunId)
          )
        ) {
          return { kind: "retry" };
        }
        if (freshDescendantRunIds.some((descendantRunId) => descendantStatuses.get(descendantRunId) === null)) {
          return { kind: "return", view: persistedOwnerView(snapshot) };
        }
        const descendantTerminalStatuses = { ...(snapshot.descendant_terminal_statuses ?? {}) };
        for (const descendantRunId of freshDescendantRunIds) {
          descendantTerminalStatuses[descendantRunId] = descendantStatuses.get(descendantRunId)!;
        }
        const freshSnapshot = {
          ...snapshot,
          descendant_terminal_statuses: descendantTerminalStatuses,
        };
        const recoveredOutput = !snapshot.partial_output_path
          ? undefined
          : await recoverStreamingRunTranscript(snapshot.partial_output_path, snapshot.run_id);
        const ownerLossEvidence: RestartDriftEvidence = {
          finishedAt: new Date().toISOString(),
          ...(recoveredOutput ? { recoveredOutput } : {}),
        };
        const staleView = settleRunOwnerLossSnapshot(
          { ...contractFields(), ...freshSnapshot },
          ownerLossEvidence,
        );
        if (!isRestartDriftSnapshot(staleView)) invalidOwnerRecord("owner-loss settlement is not restart drift");
        const view = await writeRunClaimOwned(staleView, {
          declarations: currentRecord.declarations,
          ...(currentRecord.launch_observation
            ? { launchObservation: currentRecord.launch_observation }
            : {}),
          ...(!pendingTerminalOutputsCleaned && currentRecord.pending_terminal_outputs
            ? { pendingTerminalOutputs: currentRecord.pending_terminal_outputs }
            : {}),
        });
        failureLog = { snapshot: freshSnapshot, view, settledAt: ownerLossEvidence.finishedAt };
        return { kind: "return", view };
      })
    );
    if (phaseTwo.kind === "retry") continue;
    if (failureLog) {
      const closeReason = "MCP server restarted while run was active";
      await closePendingInputRequestsForRun({
        mailboxRoot: path.dirname(failureLog.snapshot.input_requests_dir),
        runId,
        reason: closeReason,
        settledAt: failureLog.settledAt,
      });
      await cleanupTerminalRunStaging(failureLog.view);
      await logRestartDriftFailure(failureLog.snapshot, failureLog.view);
    }
    return phaseTwo.view;
  }
  throw new ValidationError(
    `run restart reconciliation could not stabilize descendant membership: ${runId}`,
    "run_liveness_unknown",
  );
}

function getRunWaitMs(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new ValidationError("wait_ms must be a nonnegative integer when provided", "invalid_wait_ms");
  }
  return Math.min(value, maxScheduleWaitMs());
}

function waitForResidentReturnableRun(
  state: RunTaskState,
  waitMs: number,
  allowUnreleasedTerminal = false,
): Promise<RunTaskView> {
  const current = runTaskViewFromState(state, state.inputRequests, allowUnreleasedTerminal);
  if (isReturnableRunView(current) || waitMs === 0) return Promise.resolve(current);

  return new Promise<RunTaskView>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const waiters = residentPublicationWaiters.get(state.runId) ?? new Set<() => void>();
    residentPublicationWaiters.set(state.runId, waiters);

    const releaseWaiter = (): boolean => {
      if (settled) return false;
      settled = true;
      if (timeout) clearTimeout(timeout);
      waiters.delete(observePublication);
      if (waiters.size === 0 && residentPublicationWaiters.get(state.runId) === waiters) {
        residentPublicationWaiters.delete(state.runId);
      }
      return true;
    };
    const finish = (view: RunTaskView): void => {
      if (releaseWaiter()) resolve(view);
    };
    const fail = (error: unknown): void => {
      if (releaseWaiter()) reject(error);
    };
    const observePublication = (): void => {
      if (tasks.get(state.runId) !== state) return;
      const view = runTaskViewFromState(state, state.inputRequests, allowUnreleasedTerminal);
      if (isReturnableRunView(view)) finish(view);
    };

    waiters.add(observePublication);
    timeout = setTimeout(() => {
      if (tasks.get(state.runId) === state) {
        finish(runTaskViewFromState(state, state.inputRequests, allowUnreleasedTerminal));
        return;
      }
      void getPersistedRunTask(state.runId).then(finish, fail);
    }, waitMs);
    observePublication();
  });
}

export async function getRunTask(
  runId: string,
  allowUnreleasedTerminal = false,
  waitMs: unknown = 0,
): Promise<RunTaskView> {
  const effectiveWaitMs = getRunWaitMs(waitMs);
  const state = tasks.get(runId);
  // This process has no authoritative owner-record event stream for a
  // nonresident run. Read its current persisted truth once and return it;
  // filesystem polling would invent an observation guarantee we do not own.
  if (!state) return getPersistedRunTask(runId);
  // Draft mutations are private and publication is synchronous after the
  // owner record commits, so a lock-free active read can only observe the
  // previous or current committed live state, never a partial transition.
  return waitForResidentReturnableRun(state, effectiveWaitMs, allowUnreleasedTerminal);
}

async function reconcileTerminalOutputCleanupOwners(): Promise<number> {
  const runTasksDir = defaultRunTasksDir();
  const entries = await fs.readdir(runTasksDir).catch(() => []);
  let reconciled = 0;
  for (const entry of entries) {
    if (entry.startsWith(".") || !entry.endsWith(".json")) continue;
    const runId = entry.slice(0, -".json".length);
    const pending = await withRunOwner(runId, async () => {
      const record = await readRunOwnerRecordFile(path.join(runTasksDir, entry)).catch(() => undefined);
      const snapshot = record ? currentRunClaimView(record) : undefined;
      return snapshot && isTerminalRunStatus(snapshot.status)
        ? record?.pending_terminal_outputs
        : undefined;
    });
    if (!pending) continue;
    try {
      await cleanupPendingTerminalOutputs(pending);
    } catch (error) {
      console.error(
        `[subagent007 warning] retained terminal-output cleanup failed for run ${runId}: ${String(error)}`,
      );
      continue;
    }
    const cleared = await withRunOwner(runId, () =>
      withRunClaimLock(runTasksDir, runId, async () => {
        const record = await readRunOwnerRecordFile(path.join(runTasksDir, entry));
        if (!record || !record.pending_terminal_outputs) return false;
        if (!sameCanonicalOwnerJson(record.pending_terminal_outputs, pending)) return false;
        const snapshot = currentRunClaimView(record);
        if (!isTerminalRunStatus(snapshot.status)) return false;
        await writeRunClaimOwned(snapshot, {
          declarations: record.declarations,
          ...(record.launch_observation
            ? { launchObservation: record.launch_observation }
            : {}),
        });
        return true;
      })
    );
    if (cleared) reconciled += 1;
  }
  return reconciled;
}

export async function reconcilePersistedActiveRunTasks(): Promise<number> {
  await reconcileRunTaskSnapshotTemps();
  let reconciled = await reconcileTerminalOutputCleanupOwners();
  const runTasksDir = defaultRunTasksDir();
  const entries = await fs.readdir(runTasksDir).catch(() => []);
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

  const terminalError = error instanceof Error ? error : new Error(String(error));
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
  await finalizeRegisteredRunTask(
    state,
    childLease,
    "client start admission failed",
    { error: terminalError },
  );
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
  const snapshotPreflight = await assertSkillSnapshotBinding(resolved);
  await resolveSystemSkillSourceForRequest(resolved);
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
      const terminal: RunTaskTerminalIntent = {};
      try {
        childLease = await queuedAdmission.ticket.waitForLease(state.abortController.signal);
        if (state.cancelRequested) {
          throw new ValidationError("run cancelled before child launch", "local_capacity_exhausted");
        }
        await assertPiChildEntrypointAvailable();
        await assertDiskReserveAvailable(options.runsDir);
        await prepareChildRun(state);
        terminal.result = await executeRunTask(state, request, skillFilePath, options);
      } catch (error) {
        terminal.error = error instanceof Error ? error : new Error(String(error));
        await logBackgroundHandlerError(failureLogTool, request, error);
      } finally {
        await releaseQueueTicket(queuedAdmission.ticket);
        await finalizeRegisteredRunTask(
          state,
          childLease,
          durableTaskCloseReason(state),
          terminal,
        );
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
    const terminalError = error instanceof Error ? error : new Error(String(error));
    await logBackgroundHandlerError(failureLogTool, request, error);
    await finalizeRegisteredRunTask(
      state,
      childLease,
      durableTaskCloseReason(state),
      { error: terminalError },
    );
    return getRunTask(state.runId);
  }

  state.promise = containBackgroundRunFailure(state, (async () => {
    const terminal: RunTaskTerminalIntent = {};
    try {
      terminal.result = await executeRunTask(state, request, skillFilePath, options);
    } catch (error) {
      terminal.error = error instanceof Error ? error : new Error(String(error));
      await logBackgroundHandlerError(failureLogTool, request, error);
    } finally {
      await finalizeRegisteredRunTask(
        state,
        childLease,
        durableTaskCloseReason(state),
        terminal,
      );
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
  if (isReturnableRunView(started) || waitMs === 0) return started;
  const state = tasks.get(started.run_id);
  // A nonresident view has no owner-record publication stream in this
  // process, so it retains immediate snapshot semantics.
  if (!state) return started;
  return waitForResidentReturnableRun(state, waitMs);
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
  await validateRunSubagentSessionRequestPreflight(request, {
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
    const terminalError = error instanceof Error ? error : new Error(String(error));
    await logBackgroundHandlerError(failureLogTool, request, error);
    await finalizeRegisteredRunTask(
      state,
      childLease,
      durableTaskCloseReason(state),
      { error: terminalError },
    );
    return getRunTask(state.runId);
  }

  state.promise = containBackgroundRunFailure(state, (async () => {
    const terminal: RunTaskTerminalIntent = {};
    try {
      terminal.result = await runSubagentSession(request, {
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
      terminal.error = error instanceof Error ? error : new Error(String(error));
      await logBackgroundHandlerError(failureLogTool, request, error);
    } finally {
      await finalizeRegisteredRunTask(
        state,
        childLease,
        durableTaskCloseReason(state),
        terminal,
      );
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
  await resolveSystemSkillSourceForRequest(resolved);
  const skillFilePath = snapshotPreflight?.receipt.resolved_skill_path ?? resolveSkillFilePathForRequest(resolved);
  await assertExpectedSkillBinding(resolved, skillFilePath);
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
    const terminal: RunTaskTerminalIntent = {};
    try {
      await prepareChildRun(state);
      terminal.result = await runSubagentCore(request, {
        runId: state.runId,
        mailboxRoot: state.mailboxRoot,
        runsDir: options.runsDir,
        skillFilePath,
        ...taskRecursiveRuntimeOptions(state),
        ...taskChildRuntimeOptions(state, options),
        ...taskInputControlOptions(state),
      });
    } catch (error) {
      terminal.error = error instanceof Error ? error : new Error(String(error));
      await logBackgroundHandlerError("run_subagent", request, error);
    } finally {
      await finalizeRegisteredRunTask(
        state,
        childLease,
        "run reached a terminal state",
        terminal,
      );
    }
  })());

  await state.promise;
  const view = await getRunTask(state.runId);
  if (view.timed_out === true || view.timeout_recovery_hint) {
    return withRunClaimOwner(state, async () => {
      const currentRecord = await readRunOwnerRecordFile(taskRecordPath(state.runId));
      if (!currentRecord) throw taskNotFound(state.runId);
      const current = currentRunClaimView(currentRecord);
      const withConcreteHint = runSubagentResultWithConcreteTimeoutRecoveryHint(
        current as RunSubagentResult,
        state.runId,
      ) as RunTaskView;
      if (sameCanonicalOwnerJson(current, withConcreteHint)) return current;
      const draft = cloneRunTaskTransitionState(state);
      if (!draft.result) return current;
      draft.result = {
        ...draft.result,
        timeout_recovery_hint: withConcreteHint.timeout_recovery_hint,
      };
      const committed = await writeRunClaimOwned(
        withConcreteHint,
        runClaimPersistenceEvidence(draft),
      );
      publishRunTaskTransitionState(state, draft);
      return committed;
    });
  }
  return view;
}

async function acceptRunCancellation(
  state: RunTaskState,
): Promise<{ view: RunTaskView; cancellationAt?: string }> {
  return withRunOwner(state.runId, async () => {
    if (tasks.get(state.runId) !== state) throw taskNotFound(state.runId);
    if (state.terminalSnapshotStarted || state.result || state.error || state.cancelRequested) {
      return { view: runTaskViewFromState(state, state.inputRequests) };
    }
    const draft = cloneRunTaskTransitionState(state);
    const stagedEvents: CanonicalRunPublicEvent[] = [];
    const cancellationAt = new Date().toISOString();
    draft.cancelRequested = true;
    setTaskPhase(draft, "cancelling", cancellationAt);
    projectStatusEvent(draft, {
      kind: "terminal",
      event: "cancellation_requested",
      text: "[cancellation_requested] cancellation requested",
      occurred_at: cancellationAt,
    }, stagedEvents, "cancellation requested");
    const inputSettlement = planClosedInputRequests(draft.inputRequests, cancellationAt, "run cancelled");
    draft.inputRequests = inputSettlement.inputRequests;
    appendClosedInputEvents(draft, inputSettlement.closed, stagedEvents);
    const committed = await writeRunClaimOwned(
      runTaskViewFromState(draft, draft.inputRequests),
      runClaimPersistenceEvidence(draft),
    );
    rejectPendingInputDeliveries(
      draft,
      new ValidationError(`input request is already closed: ${state.runId}`, "input_request_already_closed"),
    );
    publishRunTaskTransitionState(state, draft);
    return { view: committed, cancellationAt };
  });
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
  try {
    const { view, cancellationAt } = await acceptRunCancellation(state);
    if (cancellationAt) {
      await closePendingInputRequestsForRun({
        mailboxRoot: state.mailboxRoot,
        runId,
        reason: "run cancelled",
        settledAt: cancellationAt,
      });
      state.abortController.abort();
    }
    return view;
  } catch (error) {
    if (state.cancelRequested) state.abortController.abort();
    throw error;
  }
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
  const cwd = cwdFromRunStartedEvent(snapshot.recent_events ?? []);
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

function recordAnsweredInput(
  state: RunTaskState,
  requestId: string,
  responseId: string,
  stagedEvents: CanonicalRunPublicEvent[],
  occurredAt: string,
): void {
  state.inputRequests = state.inputRequests.map((request) =>
    request.request_id === requestId
      ? {
          ...request,
          status: "answered",
          settled_at: occurredAt,
          answered_at: occurredAt,
        }
      : request
  );
  const remainingPending = state.inputRequests.filter((request) => request.status === "pending");
  setTaskPhase(state, remainingPending.length > 0 ? "input_required" : "running", occurredAt);
  projectStatusEvent(state, {
    kind: "input",
    event: "input_answered",
    text: `[input_answered] ${requestId}`,
    occurred_at: occurredAt,
    metadata: {
      request_id: requestId,
      response_id: responseId,
      status: "answered",
    },
  }, stagedEvents, "input answered");
}

function settleChildAcceptedInputResponse(
  state: RunTaskState,
  response: { requestId: string; responseId: string },
): void {
  void withRunOwner(state.runId, async () => {
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
      const stagedEvents: CanonicalRunPublicEvent[] = [];
      const occurredAt = new Date().toISOString();
      const draft = cloneRunTaskTransitionState(state);
      draft.pendingInputDeliveries.delete(response.requestId);
      draft.acceptedInputResponses.set(response.requestId, {
        responseId: response.responseId,
        answerSha256: inputAnswerSha256(delivery.answer),
        receipt: delivery.receipt,
      });
      recordAnsweredInput(
        draft,
        response.requestId,
        response.responseId,
        stagedEvents,
        occurredAt,
      );
      await settleInputResponse({
        mailboxRoot: state.mailboxRoot,
        requestId: response.requestId,
        responseId: response.responseId,
        receipt: delivery.receipt,
        settledAt: occurredAt,
      });
      const committed = await writeRunClaimOwned(
        runTaskViewFromState(draft, draft.inputRequests),
        runClaimPersistenceEvidence(draft),
      );
      publishRunTaskTransitionState(state, draft);
      delivery.resolve({
        view: committed,
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
  const prepared = await withRunOwner(state.runId, async (): Promise<
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
          view: runTaskViewFromState(state, state.inputRequests),
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
    const requests = state.inputRequests;
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
    const sent = state.childControlSend(`${JSON.stringify({
      type: "subagent007.input_response",
      request_id: options.requestId,
      response_id: responseId,
      answer: options.answer,
    })}\n`);
    if (!sent) {
      state.pendingInputDeliveries.delete(options.requestId);
      throw new ValidationError(`run is not accepting input: ${options.runId}`, "run_not_accepting_input");
    }
    return { delivery };
  });
  return "result" in prepared ? prepared.result : prepared.delivery.completion;
}
