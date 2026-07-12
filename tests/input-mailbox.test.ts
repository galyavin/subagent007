import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  closePendingInputRequestsForRun,
  createInputRequest,
  listInputRequests,
  newRunId,
  removeTerminalInputRequestsForRun,
  settleInputResponse,
  validateInputResponse,
} from "../src/inputMailbox.js";

const TIMESTAMPED_RANDOM_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{9}Z-[0-9a-f]{12}$/;

test("newRunId uses the timestamped safe-id shape", () => {
  assert.match(newRunId(), TIMESTAMPED_RANDOM_ID_PATTERN);
});

test("mailbox records have one canonical safe request and settlement representation", async () => {
  const mailboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-mailbox-"));
  const created = await createInputRequest({
    mailboxRoot,
    runId: "run-one",
    sessionId: "thread-one",
    question: "Choose a token",
    choices: ["Alpha", "Beta"],
    optionIds: ["alpha", "beta"],
    freeform: false,
    maxAnswerChars: 64,
  });

  assert.equal(created.schema_version, 2);
  assert.deepEqual(created.option_ids, ["alpha", "beta"]);
  assert.throws(() => validateInputResponse(created, "Alpha"), /option id/);
  validateInputResponse(created, "alpha");

  const requestPath = path.join(mailboxRoot, created.run_id, `${created.request_id}.json`);
  assert.equal((await fs.stat(requestPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(requestPath))).mode & 0o777, 0o700);

  const receipt = "receipt-001";
  const settled = await settleInputResponse({
    mailboxRoot,
    requestId: created.request_id,
    responseId: "response-001",
    receipt,
  });
  assert.equal(settled.status, "answered");
  assert.equal(settled.response_id, "response-001");
  assert.equal(settled.receipt, receipt);
  assert.equal("answer" in settled, false);

  const terminalText = await fs.readFile(
    path.join(mailboxRoot, created.run_id, `${created.request_id}.terminal.json`),
    "utf8",
  );
  assert.equal(terminalText.includes("alpha"), false);
  assert.equal(terminalText.includes("SECRET_ANSWER"), false);
});

test("mailbox closure records one terminal result and rejects late settlement", async () => {
  const mailboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-mailbox-closed-"));
  const first = await createInputRequest({ mailboxRoot, runId: "run-close", question: "Close me" });
  const second = await createInputRequest({ mailboxRoot, runId: "run-close", question: "Close me too" });

  const closed = await closePendingInputRequestsForRun({
    mailboxRoot,
    runId: "run-close",
    reason: "test terminal run",
  });
  assert.equal(closed.length, 2);
  assert.deepEqual(
    (await listInputRequests({ mailboxRoot, runId: "run-close", status: "closed" }))
      .map((request) => request.request_id)
      .sort(),
    [first.request_id, second.request_id].sort(),
  );
  await assert.rejects(
    settleInputResponse({
      mailboxRoot,
      requestId: first.request_id,
      responseId: "late-response",
      receipt: "late-receipt",
    }),
    /already closed/,
  );
});

test("legacy answer sidecars are not interpreted as request records", async () => {
  const mailboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-mailbox-legacy-"));
  const request = await createInputRequest({ mailboxRoot, runId: "run-legacy", question: "Current request" });
  await fs.writeFile(
    path.join(mailboxRoot, request.run_id, `${request.request_id}.answer.json`),
    `${JSON.stringify({ answer: "legacy secret" })}\n`,
  );
  const requests = await listInputRequests({ mailboxRoot, runId: request.run_id });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, "pending");
});

test("terminal mailbox compaction refuses pending input and removes settled run state", async () => {
  const mailboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-mailbox-compact-"));
  const runId = newRunId();
  await createInputRequest({
    mailboxRoot,
    runId,
    question: "May this mailbox be compacted?",
  });

  await assert.rejects(
    removeTerminalInputRequestsForRun({ mailboxRoot, runId }),
    /cannot compact input requests while run has pending input/,
  );
  assert.equal((await listInputRequests({ mailboxRoot, runId })).length, 1);

  await closePendingInputRequestsForRun({ mailboxRoot, runId });
  await removeTerminalInputRequestsForRun({ mailboxRoot, runId });
  await assert.rejects(fs.stat(path.join(mailboxRoot, runId)), /ENOENT/);
  assert.equal((await listInputRequests({ mailboxRoot, runId })).length, 0);
});
