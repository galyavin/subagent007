import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultSubagentStatePath, timestampedRandomId } from "./output.js";
import { ValidationError, type FailureReasonCode } from "./types.js";

const INPUT_REQUEST_STATUSES = ["pending", "answered", "timed_out", "closed"] as const;
export type InputRequestStatus = (typeof INPUT_REQUEST_STATUSES)[number];
type InputRequestSettlementOutcome = Exclude<InputRequestStatus, "pending">;
const MAX_INPUT_ANSWER_CHARS = 16_384;

export interface InputRequestRecord {
  schema_version: 2;
  request_id: string;
  run_id: string;
  session_id: string | null;
  created_at: string;
  question: string;
  options: string[];
  option_ids: string[];
  freeform: boolean;
  max_answer_chars: number;
}

export interface InputTerminalRecord {
  schema_version: 2;
  request_id: string;
  status: InputRequestSettlementOutcome;
  settled_at: string;
  response_id?: string;
  receipt?: string;
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

function assertSafeId(value: string, key: string, reasonCode: FailureReasonCode = "unknown_validation_error"): void {
  if (!/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new ValidationError(`${key} must contain only letters, digits, underscores, hyphens, dots, or colons`, reasonCode);
  }
}

function requestPath(mailboxRoot: string, runId: string, requestId: string): string {
  return path.join(mailboxRoot, runId, `${requestId}.json`);
}

function terminalPathFor(recordPath: string): string {
  return recordPath.replace(/\.json$/, ".terminal.json");
}

function isRequestRecordFile(file: import("node:fs").Dirent): boolean {
  return file.isFile() && /-[a-f0-9]{12}\.json$/.test(file.name) && !file.name.includes(".tmp-");
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
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
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
  optionIds?: string[];
  freeform?: boolean;
  maxAnswerChars?: number;
}): Promise<InputRequestRecord> {
  const runId = options.runId.trim();
  assertSafeId(runId, "run_id");
  const question = options.question.trim();
  if (question === "") {
    throw new ValidationError("question must be a nonempty string", "unknown_validation_error");
  }
  const optionsList = options.choices ?? [];
  const optionIds = options.optionIds ?? optionsList.map((_, index) => `option_${index + 1}`);
  if (optionIds.length !== optionsList.length) {
    throw new ValidationError("option_ids must have one entry for each option", "unknown_validation_error");
  }
  const seenOptionIds = new Set<string>();
  for (const optionId of optionIds) {
    assertSafeId(optionId, "option_id");
    if (seenOptionIds.has(optionId)) {
      throw new ValidationError("option_ids must be unique", "unknown_validation_error");
    }
    seenOptionIds.add(optionId);
  }
  const maxAnswerChars = options.maxAnswerChars ?? MAX_INPUT_ANSWER_CHARS;
  if (!Number.isInteger(maxAnswerChars) || maxAnswerChars < 1 || maxAnswerChars > MAX_INPUT_ANSWER_CHARS) {
    throw new ValidationError(
      `max_answer_chars must be an integer from 1 to ${MAX_INPUT_ANSWER_CHARS}`,
      "unknown_validation_error",
    );
  }
  const requestId = `${runId}-${randomBytes(6).toString("hex")}`;
  const record: InputRequestRecord = {
    schema_version: 2,
    request_id: requestId,
    run_id: runId,
    session_id: options.sessionId ?? null,
    created_at: new Date().toISOString(),
    question,
    options: optionsList,
    option_ids: optionIds,
    freeform: options.freeform ?? true,
    max_answer_chars: maxAnswerChars,
  };
  const runDir = path.join(options.mailboxRoot, runId);
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  await fs.chmod(runDir, 0o700);
  await writeAtomicCreate(requestPath(options.mailboxRoot, runId, requestId), record);
  return record;
}

function settlementStatusView(status: unknown, settledAt: string): InputRequestStatusView | null {
  if (status === "answered") {
    return { status: "answered", settled_at: settledAt, answered_at: settledAt };
  }
  if (status === "timed_out") {
    return { status: "timed_out", settled_at: settledAt, timed_out_at: settledAt };
  }
  if (status === "closed") {
    return { status: "closed", settled_at: settledAt, closed_at: settledAt };
  }
  return null;
}

async function requestStatus(recordPath: string): Promise<InputRequestStatusView> {
  const terminal = await readJson<InputTerminalRecord>(terminalPathFor(recordPath));
  return terminal ? settlementStatusView(terminal.status, terminal.settled_at) ?? { status: "pending" } : { status: "pending" };
}

async function findRequestPath(mailboxRoot: string, requestId: string): Promise<string> {
  assertSafeId(requestId, "request_id", "input_request_not_found");
  const match = /^(?<runId>.+)-[a-f0-9]{12}$/.exec(requestId);
  if (!match?.groups?.runId) {
    throw new ValidationError(`input request not found: ${requestId}`, "input_request_not_found");
  }
  const candidate = requestPath(mailboxRoot, match.groups.runId, requestId);
  try {
    await fs.stat(candidate);
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    throw new ValidationError(`input request not found: ${requestId}`, "input_request_not_found");
  }
}

async function readRequiredInputRequest(recordPath: string, requestId: string): Promise<InputRequestRecord> {
  const request = await readJson<InputRequestRecord>(recordPath);
  if (!request || request.schema_version !== 2 || request.request_id !== requestId) {
    throw new ValidationError(`input request not found: ${requestId}`, "input_request_not_found");
  }
  return request;
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
  let runNames: string[];
  if (options.runId) {
    runNames = [options.runId];
  } else {
    try {
      const runEntries = await fs.readdir(mailboxRoot, { withFileTypes: true });
      runNames = runEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
  for (const runName of runNames) {
    const runDir = path.join(mailboxRoot, runName);
    let requestFiles: import("node:fs").Dirent[];
    try {
      requestFiles = await fs.readdir(runDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const requestFile of requestFiles) {
      if (!isRequestRecordFile(requestFile)) {
        continue;
      }
      const filePath = path.join(runDir, requestFile.name);
      const record = await readJson<InputRequestRecord>(filePath);
      if (!record || record.schema_version !== 2 || record.run_id !== runName) {
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
    return new ValidationError(`input request is already answered: ${requestId}`, "input_request_already_answered");
  }
  if (status === "timed_out") {
    return new ValidationError(`input request is already timed out: ${requestId}`, "input_request_already_timed_out");
  }
  if (status === "closed") {
    return new ValidationError(`input request is already closed: ${requestId}`, "input_request_already_closed");
  }
  return new ValidationError(`input request is already settled: ${requestId}`, "unknown_validation_error");
}

async function settleInputRequestAtPath(options: {
  recordPath: string;
  requestId: string;
  outcome: InputRequestSettlementOutcome;
  responseId?: string;
  receipt?: string;
  reason?: string;
}): Promise<InputTerminalRecord> {
  if (options.outcome === "answered") {
    if (typeof options.responseId !== "string" || options.responseId.trim() === "") {
      throw new ValidationError("response_id must be a nonempty string", "unknown_validation_error");
    }
    assertSafeId(options.responseId, "response_id");
    if (typeof options.receipt !== "string" || options.receipt.trim() === "") {
      throw new ValidationError("receipt must be a nonempty string", "unknown_validation_error");
    }
  } else if (options.responseId !== undefined || options.receipt !== undefined) {
    throw new ValidationError(`${options.outcome} input request settlement cannot include a response`, "unknown_validation_error");
  }
  const currentStatus = await requestStatus(options.recordPath);
  if (currentStatus.status !== "pending") {
    throw alreadySettledError(options.requestId, currentStatus.status);
  }
  const terminal: InputTerminalRecord = {
    schema_version: 2,
    request_id: options.requestId,
    status: options.outcome,
    settled_at: new Date().toISOString(),
    ...(options.outcome === "answered" ? { response_id: options.responseId, receipt: options.receipt } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
  };
  try {
    await writeAtomicCreate(terminalPathFor(options.recordPath), terminal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw alreadySettledError(options.requestId, (await requestStatus(options.recordPath)).status);
    }
    throw error;
  }
  return terminal;
}

export function validateInputResponse(request: InputRequestRecord, answer: string): void {
  if (typeof answer !== "string" || answer.trim() === "") {
    throw new ValidationError("answer must be a nonempty string", "unknown_validation_error");
  }
  if (answer.length > request.max_answer_chars) {
    throw new ValidationError("answer exceeds max_answer_chars", "unknown_validation_error");
  }
  if (/\u0000/.test(answer)) {
    throw new ValidationError("answer cannot contain NUL", "unknown_validation_error");
  }
  if (!request.freeform && !request.option_ids.includes(answer)) {
    throw new ValidationError("answer must be a declared option id", "unknown_validation_error");
  }
}

export async function settleInputResponse(options: {
  mailboxRoot?: string;
  requestId: string;
  responseId: string;
  receipt: string;
}): Promise<InputTerminalRecord> {
  const mailboxRoot = options.mailboxRoot ?? defaultInputRequestsDir();
  const recordPath = await findRequestPath(mailboxRoot, options.requestId);
  await readRequiredInputRequest(recordPath, options.requestId);
  return settleInputRequestAtPath({
    recordPath,
    requestId: options.requestId,
    outcome: "answered",
    responseId: options.responseId,
    receipt: options.receipt,
  });
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
      const recordPath = await findRequestPath(mailboxRoot, request.request_id);
      closed.push(await settleInputRequestAtPath({
        recordPath,
        requestId: request.request_id,
        outcome: "closed",
        reason: options.reason ?? "run reached a terminal state",
      }));
    } catch (error) {
      if (!(error instanceof ValidationError) || !/already (answered|timed out|closed)/.test(error.message)) {
        throw error;
      }
    }
  }
  return closed;
}

export async function removeTerminalInputRequestsForRun(options: {
  mailboxRoot?: string;
  runId: string;
}): Promise<void> {
  const mailboxRoot = options.mailboxRoot ?? defaultInputRequestsDir();
  assertSafeId(options.runId, "run_id");
  const pending = await listInputRequests({ mailboxRoot, runId: options.runId, status: "pending" });
  if (pending.length > 0) {
    throw new ValidationError(
      `cannot compact input requests while run has pending input: ${options.runId}`,
      "run_not_accepting_input",
    );
  }
  await fs.rm(path.join(mailboxRoot, options.runId), { recursive: true, force: true });
}
