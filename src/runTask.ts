import { randomBytes } from "node:crypto";
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
  runSubagentCore,
  resolveSkillFilePathForRequest,
  RUN_SUBAGENT_TIMEOUT_RECOVERY_HINT,
} from "./runSubagent.js";
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
  RunPublicEvent,
  RunPublicEventName,
  RunSubagentPromotion,
  RunSubagentRequest,
  RunSubagentResult,
  RunSubagentSessionRequest,
  RunSubagentSessionResult,
} from "./types.js";
import { ValidationError } from "./types.js";
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
  admitActiveChild,
  hasLiveActiveChildLease,
  hasLiveQueuedRunTicket,
  type ActiveChildAdmission,
  type ActiveChildLease,
} from "./activeChildLease.js";
import { assertDiskReserveAvailable } from "./diskReserve.js";
import { processIsDefinitelyGone } from "./processLiveness.js";

type RunTaskStatus = DurableRunStatus;
const TERMINAL_RUN_STATUS_SET = new Set<RunTaskStatus>(TERMINAL_RUN_STATUSES);

type RunTaskTerminalResult = RunSubagentResult | RunSubagentSessionResult;
type ChildLifecycleEventName = Extract<
  RunPublicEventName,
  "child_spawned" | "child_bridge_started" | "child_session_established" | "child_prompt_submitted"
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
  root_run_id: string;
  recursion_depth: number;
  child_run_ids: string[];
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
}

export interface RunTaskLineage {
  parentRunId?: string;
  rootRunId?: string;
  recursionDepth?: number;
}

export interface RecursiveCallerLineage {
  parentRunId: string;
  rootRunId: string;
  recursionDepth: number;
}

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
  childControlSend?: (message: string) => boolean;
  acceptedInputResponses: Map<string, { responseId: string; answer: string; receipt: string }>;
  pendingInputDeliveries: Map<string, PendingInputDelivery>;
  inputMutationQueue: Promise<void>;
  terminalizing: boolean;
  partialOutputPath?: string;
  childStarted: boolean;
  queuedAt?: string;
  childStartedAt?: string;
  capacityReleased: boolean;
}

interface PendingInputDelivery {
  responseId: string;
  answer: string;
  receipt: string;
  completion: Promise<AnswerRunTaskInputResult>;
  resolve: (result: AnswerRunTaskInputResult) => void;
  reject: (error: Error) => void;
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

async function writeTaskSnapshot(view: RunTaskView): Promise<void> {
  const existing = await readTaskSnapshot(view.run_id);
  if (
    existing &&
    isRestartDriftSnapshot(existing) &&
    isTerminalRunStatus(view.status) &&
    !isRestartDriftSnapshot(view)
  ) {
    return;
  }
  const runTasksDir = defaultRunTasksDir();
  const terminal = isTerminalRunStatus(view.status);
  let snapshot = view;
  if (terminal) {
    const persistedEvents = await readRunPublicEvents(runTasksDir, view.run_id);
    const existingEvents = existing?.recent_events ?? [];
    const viewEvents = view.recent_events ?? [];
    const canonicalEvents = terminalEventsProjection(
      [...existingEvents, ...persistedEvents, ...viewEvents].sort((left, right) =>
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
  await fs.mkdir(runTasksDir, { recursive: true });
  const recordPath = taskRecordPath(snapshot.run_id);
  const tmpPath = `${recordPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, recordPath);
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
}

async function readTaskSnapshot(runId: string): Promise<RunTaskView | null> {
  try {
    return JSON.parse(await fs.readFile(taskRecordPath(runId), "utf8")) as RunTaskView;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function reconcileRunTaskSnapshotTemps(): Promise<number> {
  const runTasksDir = defaultRunTasksDir();
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

  let reconciled = 0;
  for (const [runId, candidates] of candidatesByRun) {
    const recordPath = taskRecordPath(runId);
    const canonicalExists = await fs.stat(recordPath).then(() => true, () => false);
    if (!canonicalExists) {
      for (const candidate of candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)) {
        const valid = await fs.readFile(candidate.path, "utf8").then((text) => {
          const snapshot = JSON.parse(text) as { run_id?: unknown };
          return snapshot.run_id === runId;
        }, () => false).catch(() => false);
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
): RunTaskState {
  const runId = newRunId();
  const mailboxRoot = defaultInputRequestsDir();
  const startedAt = new Date().toISOString();
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
    ...(sessionKey ? { sessionKey } : {}),
    ...(lineage.parentRunId ? { parentRunId: lineage.parentRunId } : {}),
    rootRunId: lineage.rootRunId ?? runId,
    recursionDepth: lineage.recursionDepth ?? 0,
    childRunIds: [],
    acceptedInputResponses: new Map(),
    pendingInputDeliveries: new Map(),
    inputMutationQueue: Promise.resolve(),
    terminalizing: false,
    childStarted: false,
    capacityReleased: false,
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
  "child_started" | "queued_at" | "child_started_at" | "queue_wait_ms"
> {
  return {
    child_started: state.childStarted,
    ...(state.queuedAt ? { queued_at: state.queuedAt } : {}),
    ...(state.queuedAt && state.childStartedAt ? {
      child_started_at: state.childStartedAt,
      queue_wait_ms: Math.max(0, Date.parse(state.childStartedAt) - Date.parse(state.queuedAt)),
    } : {}),
  };
}

function lineageView(state: RunTaskState): Pick<
  RunTaskView,
  "parent_run_id" | "root_run_id" | "recursion_depth" | "child_run_ids"
> {
  return {
    ...(state.parentRunId ? { parent_run_id: state.parentRunId } : {}),
    root_run_id: state.rootRunId,
    recursion_depth: state.recursionDepth,
    child_run_ids: state.childRunIds,
  };
}

function activeProgressView(state: RunTaskState): RunTaskProgressView {
  return progressView(state, Math.max(0, Date.now() - Date.parse(state.startedAt)));
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

async function registerRunTaskState(
  state: RunTaskState,
  request: RunSubagentRequest | RunSubagentSessionRequest,
): Promise<void> {
  state.cwd = typeof request.cwd === "string" ? request.cwd : undefined;
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
  await writeTaskSnapshot(await getRunTask(parent.runId));
  await appendParentRecursiveChildStartedEvent(state);
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
    parent.recursionDepth !== caller.recursionDepth
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
): Promise<void> {
  try {
    if (admission.kind === "queued") {
      state.queuedAt = admission.ticket.queuedAt;
      setTaskPhase(state, "queued", admission.ticket.queuedAt);
      setTaskProgress(state, "queued; waiting for local child capacity");
    }
    await registerRunTaskState(state, request);
    await recordParentChildRun(state);
  } catch (error) {
    if (admission.kind === "active") {
      await releaseChildLease(admission.lease);
    } else {
      await releaseQueueTicket(admission.ticket);
    }
    tasks.delete(state.runId);
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
    output_mode: result.requested_output_mode,
  });
}

async function finalizeRunTask(state: RunTaskState, closeReason: string): Promise<void> {
  await serializeInputMutation(state, async () => {
    state.terminalizing = true;
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
    state.childControlSend = undefined;
    state.acceptedInputResponses.clear();
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
  if (!state.cancelRequested || !state.result || state.result.stop_reason === "cancelled") {
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

function isChildLifecycleEventName(value: unknown): value is ChildLifecycleEventName {
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
  if (parsed.type !== "subagent007.lifecycle") {
    return null;
  }
  const event = parsed.event ?? parsed.phase;
  if (!isChildLifecycleEventName(event)) {
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
    await appendStatusEvent(state, {
      kind: "terminal",
      event: state.cancelRequested ? "cancellation_settled" : "failed",
      text: state.cancelRequested ? "[cancellation_settled] run cancelled" : `[failed] ${state.error.message}`,
      occurred_at: occurredAt,
      metadata: {
        ...(cancelledBeforeLaunch ? {} : syntheticTerminalFailureEventMetadata(failureEnvelope)),
        ...(cancelledBeforeLaunch ? {} : { error: state.error.message }),
      },
    }, state.cancelRequested ? "run cancelled" : state.error.message);
    setTaskPhase(state, state.cancelRequested ? "cancelled" : "failed", occurredAt);
  }
}

async function observeOutputLine(state: RunTaskState, line: string): Promise<void> {
  const lifecycle = childLifecycleFromProcessLine(line);
  if (lifecycle) {
    const occurredAt = new Date().toISOString();
    if (state.activePhase === "awaiting_child_event" || state.activePhase === "running_silent") {
      setTaskPhase(state, "running_silent", occurredAt);
    }
    await appendChildLifecycleEvent(
      state,
      lifecycle.event,
      lifecycle.text,
      lifecycle.progressMessage,
      { occurredAt, ...(lifecycle.metadata ? { metadata: lifecycle.metadata } : {}) },
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
} {
  return {
    heartbeat: (beat, message) => handleTaskHeartbeat(state, beat, message, options.heartbeat),
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    abortSignal: state.abortController.signal,
    onOutputLine: (line) => observeOutputLine(state, line),
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
    partialOutputAvailable: recoveredOutput !== undefined,
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
  const events = await loadSnapshotEvents(snapshot);
  const staleView: RunTaskView = {
    ...contractFields(),
    ...snapshot,
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

export async function getRunTask(runId: string, allowUnreleasedTerminal = false): Promise<RunTaskView> {
  const state = tasks.get(runId);
  if (!state) {
    const snapshot = await readTaskSnapshot(runId);
    if (!snapshot) {
      throw taskNotFound(runId);
    }
    const mailboxRoot = path.dirname(snapshot.input_requests_dir);
    const inputRequests = await listInputRequests({ mailboxRoot, runId });
    const eventProjection = await loadSnapshotEvents(snapshot);
    if (snapshot.status === "working" || snapshot.status === "input_required") {
      if (await hasLiveActiveChildLease(runId) || await hasLiveQueuedRunTicket(runId)) {
        return {
          ...contractFields(),
          ...snapshot,
          ...eventProjection,
          input_requests: inputRequests,
        };
      }
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
    if (await hasLiveActiveChildLease(runId) || await hasLiveQueuedRunTicket(runId)) {
      continue;
    }
    await getRunTask(runId);
    reconciled += 1;
  }
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

export async function startRunTask(
  request: RunSubagentRequest,
  options: {
    runsDir?: string;
    heartbeat?: HeartbeatNotify;
    heartbeatIntervalMs?: number;
    failureLogTool?: Extract<FailureLogTool, "schedule_run" | "start_run">;
    lineage?: RunTaskLineage;
  } = {},
): Promise<RunTaskView> {
  const failureLogTool = options.failureLogTool ?? "start_run";
  const config = await loadConfig();
  const resolved = await validateAndResolveRequest(request, config);
  assertDeadlineRiskTimeoutBudget(request, resolved, failureLogTool);
  const skillFilePath = resolveSkillFilePathForRequest(resolved);
  await assertPiChildEntrypointAvailable();
  await assertDiskReserveAvailable(options.runsDir);

  const state = createRunTaskState("run", undefined, options.lineage);
  state.failureLogTool = failureLogTool;
  const admission = await admitActiveChild(state.runId, options.lineage?.parentRunId === undefined);
  await registerRunTaskStateWithAdmission(state, request, admission);

  if (admission.kind === "queued") {
    state.promise = containBackgroundRunFailure(state, (async () => {
      let childLease: ActiveChildLease = { release: async () => {} };
      try {
        childLease = await admission.ticket.waitForLease(state.abortController.signal);
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
        await releaseQueueTicket(admission.ticket);
        await finalizeRegisteredRunTask(state, childLease, durableTaskCloseReason(state));
      }
    })());
    return getRunTask(state.runId);
  }

  const childLease = admission.lease;
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
      state.result = await executeRunTask(state, request, skillFilePath, options);
    } catch (error) {
      state.error = error as Error;
      await logBackgroundHandlerError(failureLogTool, request, error);
    } finally {
      await finalizeRegisteredRunTask(state, childLease, durableTaskCloseReason(state));
    }
  })());

  return getRunTask(state.runId);
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
  const skillFilePath = resolveSkillFilePathForRequest(resolved);
  const incompatibility = runSubagentOneShotIncompatibility(request, resolved);
  if (incompatibility) {
    return runSubagentPromotedTask(request, incompatibility, skillFilePath, options);
  }
  await assertModelClassUsableForOneShot(resolved.modelClass);
  await assertPiChildEntrypointAvailable();
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
        answer: delivery.answer,
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
  const state = tasks.get(options.runId);
  if (!state) {
    throw taskNotFound(options.runId);
  }
  const responseId = options.responseId.trim();
  if (!responseId) {
    throw new ValidationError("response_id must be a nonempty string", "unknown_validation_error");
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
      if (accepted.answer !== options.answer) {
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
