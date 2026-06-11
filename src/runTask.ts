import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { logFailure } from "./failureLog.js";
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
  RUN_SUBAGENT_TIMEOUT_RECOVERY_HINT,
} from "./runSubagent.js";
import { DEFAULT_HEARTBEAT_MESSAGE, type HeartbeatNotify } from "./progress.js";
import type { RunSubagentRequest, RunSubagentResult } from "./types.js";
import { ValidationError } from "./types.js";
import { loadConfig } from "./config.js";
import { validateAndResolveRequest } from "./validate.js";
import { defaultSubagentStatePath } from "./output.js";
import { assertModelClassUsableForOneShot } from "./modelHealth.js";

export type RunTaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunTaskView extends Partial<RunSubagentResult> {
  run_id: string;
  task_id: string;
  status: RunTaskStatus;
  started_at: string;
  finished_at?: string;
  input_requests_dir: string;
  input_requests: InputRequestView[];
  elapsed_ms?: number;
  last_progress_at?: string;
  last_progress_message?: string;
  heartbeat_count?: number;
  error?: string;
}

interface RunTaskState {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  mailboxRoot: string;
  inputRequestsDir: string;
  abortController: AbortController;
  result?: RunSubagentResult;
  error?: Error;
  cancelRequested: boolean;
  heartbeatCount: number;
  lastProgressAt?: string;
  lastProgressMessage?: string;
  promise: Promise<void>;
  terminalSnapshotStarted: boolean;
}

const tasks = new Map<string, RunTaskState>();

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

function terminalStatus(result: RunSubagentResult): RunTaskStatus {
  if (result.status === "cancelled") {
    return "cancelled";
  }
  return result.success ? "completed" : "failed";
}

async function taskInputRequests(state: RunTaskState): Promise<InputRequestView[]> {
  return listInputRequests({ mailboxRoot: state.mailboxRoot, runId: state.runId });
}

function activeProgressView(state: RunTaskState): Pick<
  RunTaskView,
  "elapsed_ms" | "last_progress_at" | "last_progress_message" | "heartbeat_count"
> {
  return {
    elapsed_ms: Math.max(0, Date.now() - Date.parse(state.startedAt)),
    ...(state.lastProgressAt ? { last_progress_at: state.lastProgressAt } : {}),
    ...(state.lastProgressMessage ? { last_progress_message: state.lastProgressMessage } : {}),
    heartbeat_count: state.heartbeatCount,
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

export async function getRunTask(runId: string): Promise<RunTaskView> {
  const state = tasks.get(runId);
  if (!state) {
    const snapshot = await readTaskSnapshot(runId);
    if (!snapshot) {
      throw taskNotFound(runId);
    }
    const mailboxRoot = path.dirname(snapshot.input_requests_dir);
    const inputRequests = await listInputRequests({ mailboxRoot, runId });
    if (snapshot.status === "working" || snapshot.status === "input_required") {
      return {
        ...snapshot,
        status: "failed",
        finished_at: snapshot.finished_at ?? new Date().toISOString(),
        input_requests: inputRequests,
        success: false,
        error: "run is not active in this MCP server process; the server may have restarted",
      };
    }
    return { ...snapshot, input_requests: inputRequests };
  }
  const inputRequests = await taskInputRequests(state);
  if (state.result) {
    return {
      ...state.result,
      status: terminalStatus(state.result),
      started_at: state.startedAt,
      finished_at: state.finishedAt,
      input_requests: inputRequests,
    };
  }
  if (state.error) {
    return {
      run_id: state.runId,
      task_id: state.runId,
      status: state.cancelRequested ? "cancelled" : "failed",
      started_at: state.startedAt,
      finished_at: state.finishedAt,
      input_requests_dir: state.inputRequestsDir,
      input_requests: inputRequests,
      success: false,
      ...activeProgressView(state),
      error: state.error.message,
    };
  }
  return {
    run_id: state.runId,
    task_id: state.runId,
    status: state.cancelRequested
      ? "cancelled"
      : inputRequests.some((request) => request.status === "pending")
        ? "input_required"
        : "working",
    started_at: state.startedAt,
    input_requests_dir: state.inputRequestsDir,
    input_requests: inputRequests,
    ...activeProgressView(state),
  };
}

export async function startRunTask(
  request: RunSubagentRequest,
  options: {
    runsDir?: string;
    heartbeat?: HeartbeatNotify;
    heartbeatIntervalMs?: number;
  } = {},
): Promise<RunTaskView> {
  const config = await loadConfig();
  await validateAndResolveRequest(request, config);

  const runId = newRunId();
  const mailboxRoot = defaultInputRequestsDir();
  const abortController = new AbortController();
  const startedAt = new Date().toISOString();
  const inputRequestsDir = path.join(mailboxRoot, runId);

  const state: RunTaskState = {
    runId,
    startedAt,
    mailboxRoot,
    inputRequestsDir,
    abortController,
    cancelRequested: false,
    heartbeatCount: 0,
    terminalSnapshotStarted: false,
    promise: Promise.resolve(),
  };
  setTaskProgress(state, DEFAULT_HEARTBEAT_MESSAGE, 0);
  tasks.set(runId, state);
  await writeTaskSnapshot(await getRunTask(runId));

  state.promise = (async () => {
    try {
      state.result = await runSubagentCore(request, {
        runId,
        mailboxRoot,
        runsDir: options.runsDir,
        failureLogTool: "start_run",
        allowTimeout: true,
        heartbeat: async (beat, message) => {
          setTaskProgress(state, message ?? DEFAULT_HEARTBEAT_MESSAGE, beat);
          await writeTaskSnapshot(await getRunTask(runId));
          await options.heartbeat?.(beat, message);
        },
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        abortSignal: abortController.signal,
      });
    } catch (error) {
      state.error = error as Error;
      if (!(error instanceof ValidationError)) {
        await logFailure({
          tool: "start_run",
          failure_class: "unknown_error",
          reason_code: "handler_error",
          cwd: typeof request.cwd === "string" ? request.cwd : undefined,
          success: false,
        });
      }
    } finally {
      state.terminalSnapshotStarted = true;
      state.finishedAt = new Date().toISOString();
      await closePendingInputRequestsForRun({
        mailboxRoot: state.mailboxRoot,
        runId,
        reason: state.cancelRequested ? "run cancelled" : "run reached a terminal state",
      });
      await writeTaskSnapshot(await getRunTask(runId));
    }
  })();

  return getRunTask(runId);
}

export async function runSubagentOneShotTask(
  request: RunSubagentRequest,
  options: {
    runsDir?: string;
    heartbeat?: HeartbeatNotify;
    heartbeatIntervalMs?: number;
  } = {},
): Promise<RunTaskView> {
  const config = await loadConfig();
  const resolved = await validateAndResolveRequest(request, config);
  await assertModelClassUsableForOneShot(resolved.modelClass);

  const runId = newRunId();
  const mailboxRoot = defaultInputRequestsDir();
  const abortController = new AbortController();
  const startedAt = new Date().toISOString();
  const inputRequestsDir = path.join(mailboxRoot, runId);

  const state: RunTaskState = {
    runId,
    startedAt,
    mailboxRoot,
    inputRequestsDir,
    abortController,
    cancelRequested: false,
    heartbeatCount: 0,
    terminalSnapshotStarted: false,
    promise: Promise.resolve(),
  };
  setTaskProgress(state, DEFAULT_HEARTBEAT_MESSAGE, 0);
  tasks.set(runId, state);
  await writeTaskSnapshot(await getRunTask(runId));

  state.promise = (async () => {
    try {
      state.result = await runSubagentCore(request, {
        runId,
        mailboxRoot,
        runsDir: options.runsDir,
        failureLogTool: "run_subagent",
        heartbeat: async (beat, message) => {
          setTaskProgress(state, message ?? DEFAULT_HEARTBEAT_MESSAGE, beat);
          await writeTaskSnapshot(await getRunTask(runId));
          await options.heartbeat?.(beat, message);
        },
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        abortSignal: abortController.signal,
      });
    } catch (error) {
      state.error = error as Error;
      if (!(error instanceof ValidationError)) {
        await logFailure({
          tool: "run_subagent",
          failure_class: "unknown_error",
          reason_code: "handler_error",
          cwd: typeof request.cwd === "string" ? request.cwd : undefined,
          success: false,
        });
      }
    } finally {
      state.terminalSnapshotStarted = true;
      state.finishedAt = new Date().toISOString();
      await closePendingInputRequestsForRun({
        mailboxRoot: state.mailboxRoot,
        runId,
        reason: "run reached a terminal state",
      });
      await writeTaskSnapshot(await getRunTask(runId));
    }
  })();

  await state.promise;
  const view = await getRunTask(runId);
  if (
    view.timed_out === true &&
    view.timeout_recovery_hint === undefined
  ) {
    const withHint: RunTaskView = {
      ...view,
      timeout_recovery_hint: `${RUN_SUBAGENT_TIMEOUT_RECOVERY_HINT} Inspect this run with get_run using run_id ${runId}.`,
    };
    await writeTaskSnapshot(withHint);
    if (state.result) {
      state.result = { ...state.result, timeout_recovery_hint: withHint.timeout_recovery_hint };
    }
    return withHint;
  }
  if (view.timeout_recovery_hint) {
    const withConcreteHint: RunTaskView = {
      ...view,
      timeout_recovery_hint: `${view.timeout_recovery_hint} Inspect this run with get_run using run_id ${runId}.`,
    };
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
    setTaskProgress(state, "cancellation requested");
    state.abortController.abort();
    await closePendingInputRequestsForRun({
      mailboxRoot: state.mailboxRoot,
      runId,
      reason: "run cancelled",
    });
  }
  const view = await getRunTask(runId);
  await writeTaskSnapshot(view);
  return view;
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
  const view = await getRunTask(options.runId);
  await writeTaskSnapshot(view);
  return view;
}
