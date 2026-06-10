import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultSubagentStatePath } from "./output.js";
import { ValidationError } from "./types.js";

export const INPUT_REQUEST_STATUSES = ["pending", "answered", "timed_out"] as const;
export type InputRequestStatus = (typeof INPUT_REQUEST_STATUSES)[number];

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

export interface InputRequestView extends InputRequestRecord {
  status: InputRequestStatus;
  answered_at?: string;
  timed_out_at?: string;
}

export function defaultInputRequestsDir(): string {
  return defaultSubagentStatePath("SUBAGENT007_INPUT_REQUESTS_DIR", "input-requests");
}

export function newRunId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "");
  const suffix = randomBytes(6).toString("hex");
  return `${timestamp}-${suffix}`;
}

function assertSafeId(value: string, key: string): void {
  if (!/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new ValidationError(`${key} must contain only letters, digits, underscores, hyphens, dots, or colons`);
  }
}

function requestPath(mailboxRoot: string, runId: string, requestId: string): string {
  return path.join(mailboxRoot, runId, `${requestId}.json`);
}

function answerPathFor(recordPath: string): string {
  return recordPath.replace(/\.json$/, ".answer.json");
}

function timeoutPathFor(recordPath: string): string {
  return recordPath.replace(/\.json$/, ".timed_out.json");
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

async function requestStatus(recordPath: string): Promise<{
  status: InputRequestStatus;
  answered_at?: string;
  timed_out_at?: string;
}> {
  const answer = await readJson<InputAnswerRecord>(answerPathFor(recordPath));
  if (answer) {
    return { status: "answered", answered_at: answer.answered_at };
  }
  const timeout = await readJson<InputTimeoutRecord>(timeoutPathFor(recordPath));
  if (timeout) {
    return { status: "timed_out", timed_out_at: timeout.timed_out_at };
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
      if (
        !requestFile.isFile() ||
        !requestFile.name.endsWith(".json") ||
        requestFile.name.endsWith(".answer.json") ||
        requestFile.name.endsWith(".timed_out.json") ||
        requestFile.name.includes(".tmp-")
      ) {
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

export async function answerInputRequest(options: {
  mailboxRoot?: string;
  requestId: string;
  answer: string;
}): Promise<InputAnswerRecord> {
  if (typeof options.answer !== "string" || options.answer.trim() === "") {
    throw new ValidationError("answer must be a nonempty string");
  }
  const mailboxRoot = options.mailboxRoot ?? defaultInputRequestsDir();
  const recordPath = await findRequestPath(mailboxRoot, options.requestId);
  const currentStatus = await requestStatus(recordPath);
  if (currentStatus.status === "answered") {
    throw new ValidationError(`input request is already answered: ${options.requestId}`);
  }
  if (currentStatus.status === "timed_out") {
    throw new ValidationError(`input request is already timed out: ${options.requestId}`);
  }
  const answer: InputAnswerRecord = {
    schema_version: 1,
    request_id: options.requestId,
    answer: options.answer,
    answered_at: new Date().toISOString(),
  };
  try {
    await writeAtomicCreate(answerPathFor(recordPath), answer);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ValidationError(`input request is already answered: ${options.requestId}`);
    }
    throw error;
  }
  return answer;
}

async function markTimedOut(recordPath: string, requestId: string): Promise<void> {
  const timeout: InputTimeoutRecord = {
    schema_version: 1,
    request_id: requestId,
    timed_out_at: new Date().toISOString(),
  };
  try {
    await writeAtomicCreate(timeoutPathFor(recordPath), timeout);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
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
    const answer = await readJson<InputAnswerRecord>(answerPathFor(recordPath));
    if (answer) {
      return answer;
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }

  await markTimedOut(recordPath, options.requestId);
  throw new Error(`input request timed out: ${options.requestId}`);
}
