import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  answerInputRequest,
  closePendingInputRequestsForRun,
  createInputRequest,
  listInputRequests,
  newRunId,
  settleInputRequest,
  waitForInputAnswer,
} from "../src/inputMailbox.js";

const TIMESTAMPED_RANDOM_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{9}Z-[0-9a-f]{12}$/;

test("newRunId uses the timestamped safe-id shape", () => {
  assert.match(newRunId(), TIMESTAMPED_RANDOM_ID_PATTERN);
});

test("mailbox records can be listed, answered once, and filtered by status", async () => {
  const mailboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-mailbox-"));
  const created = await createInputRequest({
    mailboxRoot,
    runId: "run-one",
    sessionId: "thread-one",
    question: "Choose a token",
    choices: ["alpha", "beta"],
    freeform: false,
  });

  const pending = await listInputRequests({ mailboxRoot, status: "pending" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].request_id, created.request_id);
  assert.equal(pending[0].status, "pending");
  assert.equal(pending[0].session_id, "thread-one");
  assert.deepEqual(pending[0].options, ["alpha", "beta"]);
  assert.equal(pending[0].freeform, false);

  const answer = await answerInputRequest({
    mailboxRoot,
    requestId: created.request_id,
    answer: "alpha",
  });
  assert.equal(answer.answer, "alpha");

  assert.equal((await listInputRequests({ mailboxRoot, status: "pending" })).length, 0);
  const answered = await listInputRequests({ mailboxRoot, status: "answered" });
  assert.equal(answered.length, 1);
  assert.equal(answered[0].request_id, created.request_id);
  assert.equal(typeof answered[0].answered_at, "string");

  await assert.rejects(
    answerInputRequest({ mailboxRoot, requestId: created.request_id, answer: "beta" }),
    /already answered/,
  );
  await assert.rejects(
    answerInputRequest({ mailboxRoot, requestId: "missing-request", answer: "beta" }),
    /not found/,
  );
});

test("mailbox wait marks unanswered requests as timed out", async () => {
  const mailboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-mailbox-timeout-"));
  const created = await createInputRequest({
    mailboxRoot,
    runId: "run-timeout",
    question: "Will time out",
  });

  await assert.rejects(
    waitForInputAnswer({
      mailboxRoot,
      runId: created.run_id,
      requestId: created.request_id,
      timeoutMs: 5,
      pollIntervalMs: 1,
    }),
    /timed out/,
  );

  const timedOut = await listInputRequests({ mailboxRoot, status: "timed_out" });
  assert.equal(timedOut.length, 1);
  assert.equal(timedOut[0].request_id, created.request_id);
  assert.equal(typeof timedOut[0].timed_out_at, "string");
  await assert.rejects(
    answerInputRequest({ mailboxRoot, requestId: created.request_id, answer: "late" }),
    /already timed out/,
  );
});

test("mailbox settlement records one terminal state and rejects duplicate answers", async () => {
  const mailboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-mailbox-settle-"));
  const created = await createInputRequest({
    mailboxRoot,
    runId: "run-settle",
    question: "Choose once",
  });

  const settled = await settleInputRequest({
    mailboxRoot,
    requestId: created.request_id,
    outcome: "answered",
    answer: "first",
  });
  assert.equal(settled.status, "answered");
  assert.equal(settled.answer, "first");

  await assert.rejects(
    answerInputRequest({ mailboxRoot, requestId: created.request_id, answer: "second" }),
    /already answered/,
  );

  const answered = await listInputRequests({ mailboxRoot, status: "answered" });
  assert.equal(answered.length, 1);
  assert.equal(answered[0].request_id, created.request_id);
  assert.equal(typeof answered[0].settled_at, "string");
});

test("closing pending run input requests rejects late answers and supports closed filtering", async () => {
  const mailboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-mailbox-closed-"));
  const first = await createInputRequest({
    mailboxRoot,
    runId: "run-close",
    question: "Close me",
  });
  const second = await createInputRequest({
    mailboxRoot,
    runId: "run-close",
    question: "Close me too",
  });

  const closedRecords = await closePendingInputRequestsForRun({
    mailboxRoot,
    runId: "run-close",
    reason: "test terminal run",
  });
  assert.equal(closedRecords.length, 2);

  const closed = await listInputRequests({ mailboxRoot, runId: "run-close", status: "closed" });
  assert.deepEqual(
    closed.map((request) => request.request_id).sort(),
    [first.request_id, second.request_id].sort(),
  );
  assert.equal(closed.every((request) => typeof request.closed_at === "string"), true);

  await assert.rejects(
    answerInputRequest({ mailboxRoot, requestId: first.request_id, answer: "late" }),
    /already closed/,
  );
});

test("legacy answer and timeout markers still classify request status", async () => {
  const mailboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-mailbox-legacy-"));
  const answered = await createInputRequest({
    mailboxRoot,
    runId: "run-legacy",
    question: "Legacy answer",
  });
  const timedOut = await createInputRequest({
    mailboxRoot,
    runId: "run-legacy",
    question: "Legacy timeout",
  });

  const answeredPath = path.join(mailboxRoot, answered.run_id, `${answered.request_id}.answer.json`);
  const timedOutPath = path.join(mailboxRoot, timedOut.run_id, `${timedOut.request_id}.timed_out.json`);
  await fs.writeFile(
    answeredPath,
    `${JSON.stringify({
      schema_version: 1,
      request_id: answered.request_id,
      answer: "legacy",
      answered_at: "2026-06-10T00:00:00.000Z",
    })}\n`,
  );
  await fs.writeFile(
    timedOutPath,
    `${JSON.stringify({
      schema_version: 1,
      request_id: timedOut.request_id,
      timed_out_at: "2026-06-10T00:00:01.000Z",
    })}\n`,
  );

  const answeredViews = await listInputRequests({ mailboxRoot, status: "answered" });
  assert.equal(answeredViews.length, 1);
  assert.equal(answeredViews[0].request_id, answered.request_id);
  assert.equal(answeredViews[0].answered_at, "2026-06-10T00:00:00.000Z");

  const timedOutViews = await listInputRequests({ mailboxRoot, status: "timed_out" });
  assert.equal(timedOutViews.length, 1);
  assert.equal(timedOutViews[0].request_id, timedOut.request_id);
  assert.equal(timedOutViews[0].timed_out_at, "2026-06-10T00:00:01.000Z");
});
