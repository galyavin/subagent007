import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  failureClassForProcessResult,
  failureReasonCodeForError,
  logFailure,
  type FailureLogTool,
} from "./failureLog.js";
import {
  DURABLE_RUN_CONTRACT_NAME,
  DURABLE_RUN_CONTRACT_VERSION,
  TERMINAL_RUN_STATUSES,
  type DurableRunStatus,
} from "./durableRunContract.js";
import {
  answerInputRequest,
  closePendingInputRequestsForRun,
  defaultInputRequestsDir,
  listInputRequests,
  newRunId,
  type InputRequestView,
} from "./inputMailbox.js";
import {
  runSubagentCore,
  resolveSkillFilePathForRequest,
  RUN_SUBAGENT_TIMEOUT_RECOVERY_HINT,
} from "./runSubagent.js";
import {
  runSubagentSession,
  validateRunSubagentSessionRequestPreflight,
} from "./session.js";
import { DEFAULT_HEARTBEAT_MESSAGE, type HeartbeatNotify } from "./progress.js";
import { serverContractPacketMarker, serverContractSkillMarker } from "./prompt.js";
import {
  appendRunPublicEvent,
  publicOutputExcerptProjection,
  readRunPublicEvents,
  recentEventsProjection,
} from "./runEvents.js";
import { publicOutputLineFromProcessLine } from "./transcript.js";
import type {
  RunPublicEvent,
  RunSubagentPromotion,
  RunSubagentRequest,
  RunSubagentResult,
  RunSubagentSessionRequest,
  RunSubagentSessionResult,
} from "./types.js";
import { ValidationError } from "./types.js";
import { loadConfig } from "./config.js";
import {
  runSubagentOneShotIncompatibility,
  type RunSubagentOneShotIncompatibility,
  validateAndResolveRequest,
} from "./validate.js";
import { defaultSubagentStatePath } from "./output.js";
import { assertModelClassUsableForOneShot } from "./modelHealth.js";
import { safeIntegerFromEnv } from "./env.js";

type RunTaskStatus = DurableRunStatus;
const TERMINAL_RUN_STATUS_SET = new Set<RunTaskStatus>(TERMINAL_RUN_STATUSES);

type RunTaskActivePhase =
  | "starting"
  | "awaiting_child_event"
  | "running_silent"
  | "running"
  | "input_required"
  | "cancelling"
  | "timed_out"
  | "cancelled"
  | "completed"
  | "failed";

type RunTaskTerminalResult = RunSubagentResult | RunSubagentSessionResult;

export interface RunTaskView extends Partial<RunSubagentResult>, Partial<RunSubagentSessionResult> {
  run_id: string;
  task_id: string;
  contract_name: typeof DURABLE_RUN_CONTRACT_NAME;
  contract_version: typeof DURABLE_RUN_CONTRACT_VERSION;
  task_kind?: "run" | "session";
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
  recent_events?: RunPublicEvent[];
  last_public_output_excerpt?: string;
  requested_wait_ms?: number;
  effective_wait_ms?: number;
  wait_truncated?: boolean;
  error?: string;
  error_class?: string;
  reason_code?: string;
}

interface RunTaskState {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  mailboxRoot: string;
  inputRequestsDir: string;
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
  recentEvents: RunPublicEvent[];
  lastPublicOutputExcerpt?: string;
  promise: Promise<void>;
  terminalSnapshotStarted: boolean;
  cwd?: string;
  failureLogTool?: Extract<FailureLogTool, "run_subagent" | "schedule_run" | "start_run">;
  sessionKey?: string;
  promotion?: RunSubagentPromotion;
}

type RunTaskProgressView = Pick<
  RunTaskView,
  | "elapsed_ms"
  | "last_progress_at"
  | "last_progress_message"
  | "heartbeat_count"
  | "active_phase"
  | "last_phase_at"
  | "recent_events"
  | "last_public_output_excerpt"
>;

const tasks = new Map<string, RunTaskState>();
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
  await fs.mkdir(defaultRunTasksDir(), { recursive: true });
  const recordPath = taskRecordPath(view.run_id);
  const tmpPath = `${recordPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(view, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, recordPath);
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

function taskNotFound(runId: string): ValidationError {
  return new ValidationError(`run not found: ${runId}`);
}

function createRunTaskState(taskKind: "run" | "session", sessionKey?: string): RunTaskState {
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
  };
  setTaskProgress(state, DEFAULT_HEARTBEAT_MESSAGE, 0);
  return state;
}

function setTaskPhase(state: RunTaskState, phase: RunTaskActivePhase, occurredAt = new Date().toISOString()): void {
  if (state.terminalSnapshotStarted) {
    return;
  }
  state.activePhase = phase;
  state.lastPhaseAt = occurredAt;
}

function terminalStatus(result: RunTaskTerminalResult): RunTaskStatus {
  if (result.stop_reason === "cancelled" || ("status" in result && result.status === "cancelled")) {
    return "cancelled";
  }
  if (result.timed_out || result.stop_reason === "timeout" || ("status" in result && result.status === "timed_out")) {
    return "timed_out";
  }
  return result.success ? "completed" : "failed";
}

function contractFields(): Pick<RunTaskView, "contract_name" | "contract_version"> {
  return {
    contract_name: DURABLE_RUN_CONTRACT_NAME,
    contract_version: DURABLE_RUN_CONTRACT_VERSION,
  };
}

function errorTaxonomyForError(error: Error): { error_class: string; reason_code: string } {
  return {
    error_class: error instanceof ValidationError ? "validation_error" : "unknown_error",
    reason_code: failureReasonCodeForError(error),
  };
}

function progressView(state: RunTaskState, elapsedMs: number): RunTaskProgressView {
  return {
    elapsed_ms: elapsedMs,
    ...(state.lastProgressAt ? { last_progress_at: state.lastProgressAt } : {}),
    ...(state.lastProgressMessage ? { last_progress_message: state.lastProgressMessage } : {}),
    heartbeat_count: state.heartbeatCount,
    active_phase: state.activePhase,
    last_phase_at: state.lastPhaseAt,
    recent_events: state.recentEvents,
    ...(state.lastPublicOutputExcerpt ? { last_public_output_excerpt: state.lastPublicOutputExcerpt } : {}),
  };
}

function terminalProgressView(state: RunTaskState, result: RunTaskTerminalResult): RunTaskProgressView {
  const terminalEvent = terminalEventDetails(result);
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
    ...promotionView(state),
    ...(state.sessionKey ? { session_key: state.sessionKey } : {}),
    status: hasPendingInput
      ? "input_required"
      : "working",
    started_at: state.startedAt,
    input_requests_dir: state.inputRequestsDir,
    input_requests: inputRequests,
    ...activeProgressView(state),
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

async function appendPublicEvent(state: RunTaskState, event: RunPublicEvent): Promise<RunPublicEvent> {
  const written = await appendRunPublicEvent(defaultRunTasksDir(), state.runId, event);
  const events = [...state.recentEvents, written];
  state.recentEvents = recentEventsProjection(events);
  state.lastPublicOutputExcerpt = publicOutputExcerptProjection(events);
  return written;
}

async function handleTaskHeartbeat(
  state: RunTaskState,
  beat: number,
  message: string | undefined,
  notify: HeartbeatNotify | undefined,
): Promise<void> {
  if (state.activePhase === "awaiting_child_event" || state.activePhase === "running_silent") {
    setTaskPhase(state, "running");
  }
  setTaskProgress(state, message ?? DEFAULT_HEARTBEAT_MESSAGE, beat);
  await writeTaskSnapshot(await getRunTask(state.runId));
  await notify?.(beat, message);
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
    },
  }, DEFAULT_HEARTBEAT_MESSAGE);
  if (typeof request.prompt === "string" && request.prompt.trim() !== "") {
    await appendPublicEvent(state, {
      kind: "user",
      event: "message",
      text: `[user]\n${request.prompt}`,
      occurred_at: state.startedAt,
    });
  }
  const skill = typeof request.skill_name === "string" && request.skill_name.trim() !== ""
    ? request.skill_name.trim()
    : typeof request.skill === "string" && request.skill.trim() !== ""
      ? request.skill.trim()
      : undefined;
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
  setTaskPhase(state, "awaiting_child_event", occurredAt);
  await appendStatusEvent(state, {
    kind: "child",
    event: "child_spawned",
    text: "[child_spawned] Pi child process starting",
    occurred_at: occurredAt,
  }, "child process starting");
  if (state.activePhase === "awaiting_child_event") {
    setTaskPhase(state, "running_silent");
    setTaskProgress(state, "child process running; waiting for output");
  }
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

async function logTerminalRunTaskFailure(state: RunTaskState): Promise<void> {
  const result = state.result;
  if (!result || state.taskKind !== "run" || result.stop_reason === "cancelled" || result.success) {
    return;
  }
  const missingSessionId =
    !result.timed_out &&
    result.exit_code === 0 &&
    result.stop_reason === "completed" &&
    result.session_established === false;
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
    ...(state.promotion
      ? {
          auto_promoted_from: state.promotion.auto_promoted_from,
          promotion_reason_code: state.promotion.promotion_reason_code,
          promotion_reason: state.promotion.promotion_reason,
        }
      : {}),
    model_class: result.resolved_model_class,
    model: result.resolved_model,
    thinking_level: result.resolved_thinking_level,
    skill: result.requested_skill,
    output_mode: result.requested_output_mode,
    tool_profile: result.resolved_tool_profile,
  });
}

async function finalizeRunTask(state: RunTaskState, closeReason: string): Promise<void> {
  state.finishedAt = new Date().toISOString();
  const closed = await closePendingInputRequestsForRun({
    mailboxRoot: state.mailboxRoot,
    runId: state.runId,
    reason: closeReason,
  });
  await appendClosedInputEvents(state, closed);
  await appendTerminalEvent(state);
  state.terminalSnapshotStarted = true;
  await logTerminalRunTaskFailure(state);
  await writeTaskSnapshot(await getRunTask(state.runId));
}

function durableTaskCloseReason(state: RunTaskState): string {
  return state.cancelRequested ? "run cancelled" : "run reached a terminal state";
}

async function logBackgroundHandlerError(
  tool: Extract<FailureLogTool, "run_subagent" | "schedule_run" | "start_run" | "start_session_run">,
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

function terminalEventDetails(result: RunTaskTerminalResult): {
  phase: RunTaskActivePhase;
  event: "cancellation_settled" | "timeout" | "completed" | "failed";
  text: string;
  progressMessage: string;
} {
  if (result.stop_reason === "cancelled") {
    return {
      phase: "cancelled",
      event: "cancellation_settled",
      text: "[cancellation_settled] run cancelled",
      progressMessage: "run cancelled",
    };
  }
  if (result.stop_reason === "timeout") {
    return {
      phase: "timed_out",
      event: "timeout",
      text: "[timeout] run timed out",
      progressMessage: "run timed out",
    };
  }
  if (result.success) {
    return {
      phase: "completed",
      event: "completed",
      text: "[completed] run completed",
      progressMessage: "run completed",
    };
  }
  return {
    phase: "failed",
    event: "failed",
    text: "[failed] run failed",
    progressMessage: "run failed",
  };
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
    const terminalEvent = terminalEventDetails(result);
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
    await appendStatusEvent(state, {
      kind: "terminal",
      event: state.cancelRequested ? "cancellation_settled" : "failed",
      text: state.cancelRequested ? "[cancellation_settled] run cancelled" : `[failed] ${state.error.message}`,
      occurred_at: occurredAt,
      metadata: {
        success: false,
        error: state.error.message,
      },
    }, state.cancelRequested ? "run cancelled" : state.error.message);
    setTaskPhase(state, state.cancelRequested ? "cancelled" : "failed", occurredAt);
  }
}

async function observeOutputLine(state: RunTaskState, line: string): Promise<void> {
  const publicLine = publicOutputLineFromProcessLine(line);
  if (!publicLine) {
    return;
  }
  if (publicLine.kind === "user") {
    return;
  }
  if (publicLine.event === "input_required") {
    setTaskPhase(state, "input_required");
  } else if (publicLine.kind === "assistant" || publicLine.kind === "warning" || publicLine.kind === "error") {
    setTaskPhase(state, "running");
  } else if (publicLine.event === "input_timed_out" || publicLine.event === "input_closed") {
    setTaskPhase(state, "running");
  }
  await appendPublicEvent(state, {
    kind: publicLine.kind,
    event: publicLine.event ?? "message",
    text: publicLine.text,
    occurred_at: new Date().toISOString(),
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
} {
  return {
    heartbeat: (beat, message) => handleTaskHeartbeat(state, beat, message, options.heartbeat),
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    abortSignal: state.abortController.signal,
    onOutputLine: (line) => observeOutputLine(state, line),
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

async function persistRestartDriftSnapshot(
  snapshot: RunTaskView,
  eventProjection: Pick<RunTaskView, "recent_events" | "last_public_output_excerpt">,
): Promise<RunTaskView> {
  const finishedAt = new Date().toISOString();
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
    metadata: {
      success: false,
      error_class: "restart_drift",
      reason_code: "server_restarted_active_run",
    },
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
    success: false,
    error: "run is not active in this MCP server process; the server may have restarted",
    error_class: "restart_drift",
    reason_code: "server_restarted_active_run",
  };
  await writeTaskSnapshot(staleView);
  return staleView;
}

export async function getRunTask(runId: string): Promise<RunTaskView> {
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
      return persistRestartDriftSnapshot({ ...contractFields(), ...snapshot, input_requests: inputRequests }, eventProjection);
    }
    return { ...contractFields(), ...snapshot, ...eventProjection, input_requests: inputRequests };
  }
  const inputRequests = await listInputRequests({ mailboxRoot: state.mailboxRoot, runId: state.runId });
  if ((state.result || state.error) && !state.terminalSnapshotStarted) {
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
      status: terminalStatus(state.result),
      started_at: state.startedAt,
      finished_at: state.finishedAt,
      input_requests_dir: state.inputRequestsDir,
      input_requests: inputRequests,
      ...terminalProgressView(state, state.result),
    };
  }
  if (state.error) {
    return {
      ...contractFields(),
      run_id: state.runId,
      task_id: state.runId,
      task_kind: state.taskKind,
      ...promotionView(state),
      ...(state.sessionKey ? { session_key: state.sessionKey } : {}),
      status: state.cancelRequested ? "cancelled" : "failed",
      started_at: state.startedAt,
      finished_at: state.finishedAt,
      input_requests_dir: state.inputRequestsDir,
      input_requests: inputRequests,
      success: false,
      ...activeProgressView(state),
      error: state.error.message,
      ...errorTaxonomyForError(state.error),
    };
  }
  return activeRunTaskView(state, inputRequests);
}

export async function startRunTask(
  request: RunSubagentRequest,
  options: {
    runsDir?: string;
    heartbeat?: HeartbeatNotify;
    heartbeatIntervalMs?: number;
    failureLogTool?: Extract<FailureLogTool, "schedule_run" | "start_run">;
  } = {},
): Promise<RunTaskView> {
  const config = await loadConfig();
  const resolved = await validateAndResolveRequest(request, config);
  const skillFilePath = resolveSkillFilePathForRequest(resolved);

  const failureLogTool = options.failureLogTool ?? "start_run";
  const state = createRunTaskState("run");
  state.failureLogTool = failureLogTool;
  await registerRunTaskState(state, request);

  state.promise = (async () => {
    try {
      await prepareChildRun(state);
      state.result = await runSubagentCore(request, {
        runId: state.runId,
        mailboxRoot: state.mailboxRoot,
        runsDir: options.runsDir,
        allowTimeout: true,
        skillFilePath,
        ...taskChildRuntimeOptions(state, options),
      });
    } catch (error) {
      state.error = error as Error;
      await logBackgroundHandlerError(failureLogTool, request, error);
    } finally {
      await finalizeRunTask(state, durableTaskCloseReason(state));
    }
  })();

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
    throw new ValidationError("wait_ms must be a nonnegative integer when provided");
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
  } = {},
): Promise<RunTaskView> {
  await validateRunSubagentSessionRequestPreflight(request);

  const state = createRunTaskState(
    "session",
    typeof request.session_key === "string" ? request.session_key : undefined,
  );
  await registerRunTaskState(state, request);

  state.promise = (async () => {
    try {
      await prepareChildRun(state);
      state.result = await runSubagentSession(request, {
        sessionsDir: options.sessionsDir,
        mailboxRoot: state.mailboxRoot,
        childRunId: state.runId,
        taskId: state.runId,
        ...taskChildRuntimeOptions(state, options),
      });
    } catch (error) {
      state.error = error as Error;
      await logBackgroundHandlerError("start_session_run", request, error);
    } finally {
      await finalizeRunTask(state, durableTaskCloseReason(state));
    }
  })();

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
  const started = await startSessionRunTask(request, options);
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
  const promotion: RunSubagentPromotion = {
    auto_promoted_from: "run_subagent",
    promotion_reason_code: incompatibility.reason_code,
    promotion_reason: incompatibility.message,
    poll_with: "get_run",
    cancel_with: "cancel_run",
  };
  const state = createRunTaskState("run");
  state.promotion = promotion;
  await registerRunTaskState(state, request);
  await appendStatusEvent(state, {
    kind: "task",
    event: "auto_promoted",
    text: "[auto_promoted] run_subagent -> durable_run",
    occurred_at: new Date().toISOString(),
    metadata: { ...promotion },
  }, "run_subagent auto-promoted to durable run");
  await writeTaskSnapshot(await getRunTask(state.runId));

  state.promise = (async () => {
    try {
      await prepareChildRun(state);
      const result = await runSubagentCore(request, {
        runId: state.runId,
        mailboxRoot: state.mailboxRoot,
        runsDir: options.runsDir,
        allowTimeout: true,
        skillFilePath,
        ...taskChildRuntimeOptions(state, options),
      });
      state.result = {
        ...runSubagentResultWithConcreteTimeoutRecoveryHint(result, state.runId),
        ...promotion,
      };
    } catch (error) {
      state.error = error as Error;
      await logBackgroundHandlerError("run_subagent", request, error);
    } finally {
      await finalizeRunTask(state, durableTaskCloseReason(state));
    }
  })();

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
    throw new ValidationError("timeout_ms is not supported by run_subagent; use schedule_run or start_run for timed work");
  }
  const config = await loadConfig();
  const resolved = await validateAndResolveRequest(request, config);
  const skillFilePath = resolveSkillFilePathForRequest(resolved);
  const incompatibility = runSubagentOneShotIncompatibility(request, resolved);
  if (incompatibility) {
    return runSubagentPromotedTask(request, incompatibility, skillFilePath, options);
  }
  await assertModelClassUsableForOneShot(resolved.modelClass);

  const state = createRunTaskState("run");
  await registerRunTaskState(state, request);

  state.promise = (async () => {
    try {
      await prepareChildRun(state);
      state.result = await runSubagentCore(request, {
        runId: state.runId,
        mailboxRoot: state.mailboxRoot,
        runsDir: options.runsDir,
        skillFilePath,
        ...taskChildRuntimeOptions(state, options),
      });
    } catch (error) {
      state.error = error as Error;
      await logBackgroundHandlerError("run_subagent", request, error);
    } finally {
      await finalizeRunTask(state, "run reached a terminal state");
    }
  })();

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
    throw taskNotFound(runId);
  }
  if (!state.result && !state.error) {
    state.cancelRequested = true;
    setTaskPhase(state, "cancelling");
    await appendStatusEvent(state, {
      kind: "terminal",
      event: "cancellation_requested",
      text: "[cancellation_requested] cancellation requested",
      occurred_at: new Date().toISOString(),
    }, "cancellation requested");
    state.abortController.abort();
    const closed = await closePendingInputRequestsForRun({
      mailboxRoot: state.mailboxRoot,
      runId,
      reason: "run cancelled",
    });
    await appendClosedInputEvents(state, closed);
  }
  const view = await getRunTask(runId);
  await writeTaskSnapshot(view);
  return view;
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
      ...(typeof startedEvent?.metadata?.cwd === "string" ? { cwd: startedEvent.metadata.cwd } : {}),
    };
  }
  const snapshot = await readTaskSnapshot(runId);
  if (!snapshot) {
    return { runId };
  }
  const events = await readRunPublicEvents(defaultRunTasksDir(), runId);
  const cwd = cwdFromRunStartedEvent(events);
  return {
    runId,
    ...(snapshot.task_kind ? { taskKind: snapshot.task_kind } : {}),
    ...(snapshot.session_key ? { sessionKey: snapshot.session_key } : {}),
    ...(cwd ? { cwd } : {}),
    snapshot,
  };
}

export async function answerRunTaskInput(options: {
  runId: string;
  requestId: string;
  answer: string;
}): Promise<RunTaskView> {
  const state = tasks.get(options.runId);
  if (!state) {
    throw taskNotFound(options.runId);
  }
  if (state.cancelRequested || state.result || state.error) {
    throw new ValidationError(`run is not accepting input: ${options.runId}`);
  }
  const requests = await listInputRequests({
    mailboxRoot: state.mailboxRoot,
    runId: state.runId,
  });
  if (!requests.some((request) => request.request_id === options.requestId)) {
    throw new ValidationError(`input request is not part of run ${options.runId}: ${options.requestId}`);
  }
  await answerInputRequest({
    mailboxRoot: state.mailboxRoot,
    requestId: options.requestId,
    answer: options.answer,
  });
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
    text: `[input_answered] ${options.requestId}`,
    occurred_at: occurredAt,
    metadata: {
      request_id: options.requestId,
      status: "answered",
    },
  }, "input answered");
  const view = await getRunTask(options.runId);
  await writeTaskSnapshot(view);
  return view;
}
