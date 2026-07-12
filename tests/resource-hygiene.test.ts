import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  acquireActiveChildLease,
  DEFAULT_MAX_ACTIVE_CHILDREN,
  hasLiveActiveChildLease,
} from "../src/activeChildLease.js";
import { reconcileOwnedTemporaryArtifacts } from "../src/ownedTemporaryArtifact.js";
import { createStreamingRunTranscript, recoverStreamingRunTranscript } from "../src/output.js";
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
