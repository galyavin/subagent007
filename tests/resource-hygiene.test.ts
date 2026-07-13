import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  acquireActiveChildLease,
  admitActiveChild,
  DEFAULT_MAX_ACTIVE_CHILDREN,
  hasLiveActiveChildLease,
} from "../src/activeChildLease.js";
import { reconcileOwnedTemporaryArtifacts } from "../src/ownedTemporaryArtifact.js";
import { createStreamingRunTranscript, recoverStreamingRunTranscript } from "../src/output.js";
import { reconcileRunTaskSnapshotTemps } from "../src/runTask.js";
import { withEnv } from "./helpers/testUtils.js";

test("streaming transcripts preserve output beyond the former 256 KiB boundary", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-transcript-stream-"));
  const writer = await createStreamingRunTranscript(runsDir, { ownerId: "large-run" });
  const assistantText = `PUBLIC ${"x".repeat(300 * 1024)}`;
  await writer.appendProcessLine(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: assistantText }] },
  }));
  const output = await writer.finalize();
  const text = await fs.readFile(output.outputPath, "utf8");
  assert.equal(text.includes(assistantText), true);
  assert.equal(output.sizeBytes > 256 * 1024, true);
  assert.doesNotMatch(text, /transcript truncated/);
  assert.equal(output.hasPublicAssistantText, true);
});

test("streaming transcripts discard raw fallback after structured public events begin", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-transcript-switch-"));
  const writer = await createStreamingRunTranscript(runsDir);
  await writer.appendProcessLine("PRIVATE RAW PREFIX");
  await writer.appendProcessLine(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "PUBLIC ANSWER" }] },
  }));
  const output = await writer.finalize();
  const text = await fs.readFile(output.outputPath, "utf8");
  assert.doesNotMatch(text, /PRIVATE RAW PREFIX/);
  assert.match(text, /PUBLIC ANSWER/);
});

test("transcript recovery converges after staging was already published", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-transcript-recovery-"));
  const runId = "recovery-run";
  const writer = await createStreamingRunTranscript(runsDir, { ownerId: runId });
  const stagingPath = writer.stagingPath;
  await writer.appendProcessLine("PUBLIC RECOVERY");
  const published = await writer.finalize();

  assert.deepEqual(
    await recoverStreamingRunTranscript(stagingPath, runId),
    { outputPath: published.outputPath, sizeBytes: published.sizeBytes },
  );
  assert.equal(await recoverStreamingRunTranscript(stagingPath, "other-run"), undefined);
  assert.equal(
    await recoverStreamingRunTranscript(path.join(runsDir, `.${runId}.absent.partial`), runId),
    undefined,
  );
});

test("default active-child capacity is finite and still allows an explicit opt-out", async () => {
  const activeChildrenDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-default-capacity-"));
  await withEnv(
    {
      SUBAGENT007_ACTIVE_CHILDREN_DIR: activeChildrenDir,
      SUBAGENT007_MAX_ACTIVE_CHILDREN: undefined,
    },
    async () => {
      const leases = [];
      try {
        for (let index = 0; index < DEFAULT_MAX_ACTIVE_CHILDREN; index += 1) {
          leases.push(await acquireActiveChildLease(`run-${index}`));
        }
        assert.equal(await hasLiveActiveChildLease("run-0"), true);
        await assert.rejects(
          acquireActiveChildLease("over-capacity"),
          /local child capacity exhausted/,
        );
      } finally {
        await Promise.all(leases.map((lease) => lease.release()));
      }
      assert.equal(await hasLiveActiveChildLease("run-0"), false);
    },
  );
});

test("unreadable active leases conservatively consume capacity", async () => {
  const activeChildrenDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-unreadable-lease-"));
  await fs.writeFile(path.join(activeChildrenDir, "unreadable.json"), "{");
  await withEnv(
    {
      SUBAGENT007_ACTIVE_CHILDREN_DIR: activeChildrenDir,
      SUBAGENT007_MAX_ACTIVE_CHILDREN: "1",
    },
    async () => {
      await assert.rejects(acquireActiveChildLease("blocked"), /local child capacity exhausted/);
      assert.equal(await hasLiveActiveChildLease("unknown-owner"), true);
      assert.equal(await fs.readFile(path.join(activeChildrenDir, "unreadable.json"), "utf8"), "{");
    },
  );
});

test("one owner pump preserves queue order and does not bypass an unready head", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-owner-pump-"));
  await withEnv(
    {
      SUBAGENT007_ACTIVE_CHILDREN_DIR: path.join(stateRoot, "active"),
      SUBAGENT007_QUEUED_RUNS_DIR: path.join(stateRoot, "queued"),
      SUBAGENT007_MAX_ACTIVE_CHILDREN: "1",
      SUBAGENT007_MAX_QUEUED_RUNS: "2",
    },
    async () => {
      const blocker = await admitActiveChild("blocker", true);
      const first = await admitActiveChild("first", true);
      const second = await admitActiveChild("second", true);
      assert.equal(blocker.kind, "active");
      assert.equal(first.kind, "queued");
      assert.equal(second.kind, "queued");
      if (blocker.kind !== "active" || first.kind !== "queued" || second.kind !== "queued") {
        return;
      }
      const secondLeasePromise = second.ticket.waitForLease(new AbortController().signal);
      let secondPromoted = false;
      void secondLeasePromise.then(() => { secondPromoted = true; });
      await blocker.lease.release();
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(secondPromoted, false);
      const firstLease = await first.ticket.waitForLease(new AbortController().signal);
      await firstLease.release();
      const secondLease = await secondLeasePromise;
      await secondLease.release();
    },
  );
});

test("temporary-artifact reconciliation removes only owned artifacts whose process is gone", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-owned-temp-root-"));
  const liveDir = path.join(tempRoot, "subagent007-pi-child-live");
  const staleDir = path.join(tempRoot, "subagent007-pi-final-stale");
  const legacyDir = path.join(tempRoot, "subagent007-pi-child-unowned");
  const malformedDir = path.join(tempRoot, "subagent007-pi-final-malformed");
  await Promise.all([liveDir, staleDir, legacyDir, malformedDir].map((dir) => fs.mkdir(dir)));
  await fs.writeFile(path.join(liveDir, ".subagent007-owner.json"), JSON.stringify({
    schema_version: 1,
    pid: process.pid,
  }));
  await fs.writeFile(path.join(staleDir, ".subagent007-owner.json"), JSON.stringify({
    schema_version: 1,
    pid: 2_000_000_000,
  }));
  await fs.writeFile(path.join(malformedDir, ".subagent007-owner.json"), JSON.stringify({
    schema_version: 1,
    pid: 0,
  }));

  assert.equal(await reconcileOwnedTemporaryArtifacts(tempRoot), 1);
  assert.equal((await fs.stat(liveDir)).isDirectory(), true);
  assert.equal((await fs.stat(legacyDir)).isDirectory(), true);
  assert.equal((await fs.stat(malformedDir)).isDirectory(), true);
  await assert.rejects(fs.stat(staleDir), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("run-task snapshot reconciliation recovers a valid dead-owner successor and preserves live writes", async () => {
  const runTasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-run-task-temps-"));
  const deadPid = 2_000_000_000;
  const recoverRunId = "recover-run";
  const existingRunId = "existing-run";
  const liveRunId = "live-run";
  const recoverTemp = path.join(runTasksDir, `${recoverRunId}.json.tmp-${deadPid}-aaaaaa`);
  const existingTemp = path.join(runTasksDir, `${existingRunId}.json.tmp-${deadPid}-bbbbbb`);
  const liveTemp = path.join(runTasksDir, `${liveRunId}.json.tmp-${process.pid}-cccccc`);
  await fs.writeFile(recoverTemp, JSON.stringify({ run_id: recoverRunId, status: "completed" }));
  await fs.writeFile(path.join(runTasksDir, `${existingRunId}.json`), JSON.stringify({ run_id: existingRunId, marker: "canonical" }));
  await fs.writeFile(existingTemp, JSON.stringify({ run_id: existingRunId, marker: "stale" }));
  await fs.writeFile(liveTemp, JSON.stringify({ run_id: liveRunId, status: "working" }));

  await withEnv({ SUBAGENT007_RUN_TASKS_DIR: runTasksDir }, async () => {
    assert.equal(await reconcileRunTaskSnapshotTemps(), 3);
  });

  assert.equal(JSON.parse(await fs.readFile(path.join(runTasksDir, `${recoverRunId}.json`), "utf8")).status, "completed");
  assert.equal(JSON.parse(await fs.readFile(path.join(runTasksDir, `${existingRunId}.json`), "utf8")).marker, "canonical");
  await assert.rejects(fs.stat(recoverTemp), /ENOENT/);
  await assert.rejects(fs.stat(existingTemp), /ENOENT/);
  assert.equal((await fs.stat(liveTemp)).isFile(), true);
});
