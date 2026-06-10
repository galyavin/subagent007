import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  answerInputRequest,
  createInputRequest,
  listInputRequests,
  waitForInputAnswer,
} from "../src/inputMailbox.js";

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
