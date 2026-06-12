import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultSubagentStatePath, timestampedRandomId } from "./output.js";
import { ValidationError } from "./types.js";

export const INPUT_REQUEST_STATUSES = ["pending", "answered", "timed_out", "closed"] as const;
export type InputRequestStatus = (typeof INPUT_REQUEST_STATUSES)[number];
export type InputRequestSettlementOutcome = Exclude<InputRequestStatus, "pending">;

export interface InputRequestRecord {
  schema_version: 1;
  request_id: string;
  run_id: string;
  session_id: string | null;
  created_at: string;
  question: string;
  options: string[];
  freeform: boolean;
}

export interface InputAnswerRecord {
  schema_version: 1;
  request_id: string;
  answer: string;
  answered_at: string;
}

export interface InputTimeoutRecord {
  schema_version: 1;
  request_id: string;
  timed_out_at: string;
}

export interface InputTerminalRecord {
  schema_version: 1;
  request_id: string;
  status: InputRequestSettlementOutcome;
  settled_at: string;
  answer?: string;
  reason?: string;
}

export interface InputRequestView extends InputRequestRecord {
  status: InputRequestStatus;
  settled_at?: string;
  answered_at?: string;
  timed_out_at?: string;
  closed_at?: string;
}

type InputRequestStatusView = Pick<
  InputRequestView,
  "status" | "settled_at" | "answered_at" | "timed_out_at" | "closed_at"
>;

export function defaultInputRequestsDir(): string {
  return defaultSubagentStatePath("SUBAGENT007_INPUT_REQUESTS_DIR", "input-requests");
}

export function newRunId(): string {
  return timestampedRandomId();
}

function assertSafeId(value: string, key: string): void {
  if (!/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new ValidationError(`${key} must contain only letters, digits, underscores, hyphens, dots, or colons`);
  }
}

function requestPath(mailboxRoot: string, runId: string, requestId: string): string {
  return path.join(mailboxRoot, runId, `${requestId}.json`);
}

function sidecarPathFor(recordPath: string, suffix: string): string {
  return recordPath.replace(/\.json$/, suffix);
}

function answerPathFor(recordPath: string): string {
  return sidecarPathFor(recordPath, ".answer.json");
}

function timeoutPathFor(recordPath: string): string {
  return sidecarPathFor(recordPath, ".timed_out.json");
}

function terminalPathFor(recordPath: string): string {
  return sidecarPathFor(recordPath, ".terminal.json");
}

function isRequestRecordFile(file: import("node:fs").Dirent): boolean {
  return file.isFile() &&
    file.name.endsWith(".json") &&
    !file.name.endsWith(".answer.json") &&
    !file.name.endsWith(".timed_out.json") &&
    !file.name.endsWith(".terminal.json") &&
    !file.name.includes(".tmp-");
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeAtomicCreate(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await fs.link(tmpPath, filePath);
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}

export async function createInputRequest(options: {
  mailboxRoot: string;
  runId: string;
  sessionId?: string | null;
  question: string;
  choices?: string[];
  freeform?: boolean;
}): Promise<InputRequestRecord> {
  const runId = options.runId.trim();
  assertSafeId(runId, "run_id");
  const question = options.question.trim();
  if (question === "") {
    throw new ValidationError("question must be a nonempty string");
  }
  const requestId = `${runId}-${randomBytes(6).toString("hex")}`;
  const record: InputRequestRecord = {
    schema_version: 1,
    request_id: requestId,
    run_id: runId,
    session_id: options.sessionId ?? null,
    created_at: new Date().toISOString(),
    question,
    options: options.choices ?? [],
    freeform: options.freeform ?? true,
  };
  const runDir = path.join(options.mailboxRoot, runId);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(requestPath(options.mailboxRoot, runId, requestId), `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return record;
}

function answerRecordFromTerminal(record: InputTerminalRecord): InputAnswerRecord | null {
  if (record.status !== "answered" || typeof record.answer !== "string") {
    return null;
  }
  return {
    schema_version: 1,
    request_id: record.request_id,
    answer: record.answer,
    answered_at: record.settled_at,
  };
}

async function readSettledAnswer(recordPath: string): Promise<InputAnswerRecord | null> {
  const terminal = await readJson<InputTerminalRecord>(terminalPathFor(recordPath));
  if (terminal) {
    return answerRecordFromTerminal(terminal);
  }
  return readJson<InputAnswerRecord>(answerPathFor(recordPath));
}

function settlementStatusView(status: unknown, settledAt: string): InputRequestStatusView | null {
  if (status === "answered") {
    return {
      status: "answered",
      settled_at: settledAt,
      answered_at: settledAt,
    };
  }
  if (status === "timed_out") {
    return {
      status: "timed_out",
      settled_at: settledAt,
      timed_out_at: settledAt,
    };
  }
  if (status === "closed") {
    return {
      status: "closed",
      settled_at: settledAt,
      closed_at: settledAt,
    };
  }
  return null;
}

function terminalStatusView(record: InputTerminalRecord): InputRequestStatusView | null {
  return settlementStatusView(record.status, record.settled_at);
}

async function requestStatus(recordPath: string): Promise<{
  status: InputRequestStatus;
  settled_at?: string;
  answered_at?: string;
  timed_out_at?: string;
  closed_at?: string;
}> {
  const terminal = await readJson<InputTerminalRecord>(terminalPathFor(recordPath));
  if (terminal) {
    const terminalView = terminalStatusView(terminal);
    if (terminalView) {
      return terminalView;
    }
  }
  const answer = await readJson<InputAnswerRecord>(answerPathFor(recordPath));
  if (answer) {
    const answerView = settlementStatusView("answered", answer.answered_at);
    if (answerView) {
      return answerView;
    }
  }
  const timeout = await readJson<InputTimeoutRecord>(timeoutPathFor(recordPath));
  if (timeout) {
    const timeoutView = settlementStatusView("timed_out", timeout.timed_out_at);
    if (timeoutView) {
      return timeoutView;
    }
  }
  return { status: "pending" };
}

async function findRequestPath(mailboxRoot: string, requestId: string): Promise<string> {
  assertSafeId(requestId, "request_id");
  const match = /^(?<runId>.+)-[a-f0-9]{12}$/.exec(requestId);
  if (!match?.groups?.runId) {
    throw new ValidationError(`input request not found: ${requestId}`);
  }
  const candidate = requestPath(mailboxRoot, match.groups.runId, requestId);
  try {
    await fs.stat(candidate);
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    throw new ValidationError(`input request not found: ${requestId}`);
  }
}

export async function listInputRequests(options: {
  mailboxRoot?: string;
  runId?: string;
  status?: InputRequestStatus;
} = {}): Promise<InputRequestView[]> {
  const mailboxRoot = options.mailboxRoot ?? defaultInputRequestsDir();
  if (options.runId) {
    assertSafeId(options.runId, "run_id");
  }
  const views: InputRequestView[] = [];
  let runEntries: import("node:fs").Dirent[];
  try {
    runEntries = await fs.readdir(mailboxRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  for (const runEntry of runEntries) {
    if (!runEntry.isDirectory() || (options.runId && runEntry.name !== options.runId)) {
      continue;
    }
    const runDir = path.join(mailboxRoot, runEntry.name);
    const requestFiles = await fs.readdir(runDir, { withFileTypes: true });
    for (const requestFile of requestFiles) {
      if (!isRequestRecordFile(requestFile)) {
        continue;
      }
      const filePath = path.join(runDir, requestFile.name);
      const record = await readJson<InputRequestRecord>(filePath);
      if (!record) {
        continue;
      }
      const status = await requestStatus(filePath);
      if (options.status && status.status !== options.status) {
        continue;
      }
      views.push({ ...record, ...status });
    }
  }

  return views.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function alreadySettledError(requestId: string, status: InputRequestStatus): ValidationError {
  if (status === "answered") {
    return new ValidationError(`input request is already answered: ${requestId}`);
  }
  if (status === "timed_out") {
    return new ValidationError(`input request is already timed out: ${requestId}`);
  }
  if (status === "closed") {
    return new ValidationError(`input request is already closed: ${requestId}`);
  }
  return new ValidationError(`input request is already settled: ${requestId}`);
}

async function settleInputRequestAtPath(options: {
  recordPath: string;
  requestId: string;
  outcome: InputRequestSettlementOutcome;
  answer?: string;
  reason?: string;
}): Promise<InputTerminalRecord> {
  if (options.outcome === "answered") {
    if (typeof options.answer !== "string" || options.answer.trim() === "") {
      throw new ValidationError("answer must be a nonempty string");
    }
  } else if (options.answer !== undefined) {
    throw new ValidationError(`${options.outcome} input request settlement cannot include an answer`);
  }

  const currentStatus = await requestStatus(options.recordPath);
  if (currentStatus.status !== "pending") {
    throw alreadySettledError(options.requestId, currentStatus.status);
  }

  const settledAt = new Date().toISOString();
  const terminal: InputTerminalRecord = {
    schema_version: 1,
    request_id: options.requestId,
    status: options.outcome,
    settled_at: settledAt,
    ...(options.outcome === "answered" ? { answer: options.answer } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
  };

  try {
    await writeAtomicCreate(terminalPathFor(options.recordPath), terminal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const settledStatus = await requestStatus(options.recordPath);
      throw alreadySettledError(options.requestId, settledStatus.status);
    }
    throw error;
  }
  return terminal;
}

export async function settleInputRequest(options: {
  mailboxRoot?: string;
  requestId: string;
  outcome: InputRequestSettlementOutcome;
  answer?: string;
  reason?: string;
}): Promise<InputTerminalRecord> {
  const mailboxRoot = options.mailboxRoot ?? defaultInputRequestsDir();
  const recordPath = await findRequestPath(mailboxRoot, options.requestId);
  return settleInputRequestAtPath({
    recordPath,
    requestId: options.requestId,
    outcome: options.outcome,
    answer: options.answer,
    reason: options.reason,
  });
}

export async function answerInputRequest(options: {
  mailboxRoot?: string;
  requestId: string;
  answer: string;
}): Promise<InputAnswerRecord> {
  const terminal = await settleInputRequest({
    mailboxRoot: options.mailboxRoot,
    requestId: options.requestId,
    outcome: "answered",
    answer: options.answer,
  });
  const answer = answerRecordFromTerminal(terminal);
  if (!answer) {
    throw new ValidationError(`input request was not answered: ${options.requestId}`);
  }
  return answer;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForInputAnswer(options: {
  mailboxRoot: string;
  runId: string;
  requestId: string;
  timeoutMs: number;
  pollIntervalMs?: number;
}): Promise<InputAnswerRecord> {
  const recordPath = requestPath(options.mailboxRoot, options.runId, options.requestId);
  const deadline = Date.now() + options.timeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? 200;

  while (Date.now() < deadline) {
    const status = await requestStatus(recordPath);
    if (status.status === "timed_out") {
      throw new Error(`input request timed out: ${options.requestId}`);
    }
    if (status.status === "closed") {
      throw new Error(`input request closed: ${options.requestId}`);
    }
    const answer = await readSettledAnswer(recordPath);
    if (answer) {
      return answer;
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }

  try {
    await settleInputRequestAtPath({
      recordPath,
      requestId: options.requestId,
      outcome: "timed_out",
      reason: "wait_for_input_answer timeout elapsed",
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      const answer = await readSettledAnswer(recordPath);
      if (answer) {
        return answer;
      }
      const status = await requestStatus(recordPath);
      if (status.status === "closed") {
        throw new Error(`input request closed: ${options.requestId}`);
      }
      if (status.status === "timed_out") {
        throw new Error(`input request timed out: ${options.requestId}`);
      }
    }
    throw error;
  }
  throw new Error(`input request timed out: ${options.requestId}`);
}

export async function closePendingInputRequestsForRun(options: {
  mailboxRoot?: string;
  runId: string;
  reason?: string;
}): Promise<InputTerminalRecord[]> {
  const mailboxRoot = options.mailboxRoot ?? defaultInputRequestsDir();
  const pending = await listInputRequests({ mailboxRoot, runId: options.runId, status: "pending" });
  const closed: InputTerminalRecord[] = [];
  for (const request of pending) {
    try {
      closed.push(
        await settleInputRequest({
          mailboxRoot,
          requestId: request.request_id,
          outcome: "closed",
          reason: options.reason ?? "run reached a terminal state",
        }),
      );
    } catch (error) {
      if (!(error instanceof ValidationError) || !/already (answered|timed out|closed)/.test(error.message)) {
        throw error;
      }
    }
  }
  return closed;
}
