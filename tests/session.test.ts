import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runSubagentSession } from "../src/session.js";
import type { SessionManifest, SessionRunRecord } from "../src/types.js";
import { createFakePiChild } from "./helpers/fakePiChild.js";
import { readJsonl, withEnv } from "./helpers/testUtils.js";

async function createSessionFixture(): Promise<{
  projectDir: string;
  sessionsDir: string;
  failureLogPath: string;
  fakeChildPath: string;
  fakeLogPath: string;
}> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-session-"));
  const projectDir = path.join(tmp, "project");
  const sessionsDir = path.join(tmp, "sessions");
  const failureLogPath = path.join(tmp, "failures.jsonl");
  const fake = await createFakePiChild();
  await fs.mkdir(projectDir, { recursive: true });
  return {
    projectDir,
    sessionsDir,
    failureLogPath,
    fakeChildPath: fake.childPath,
    fakeLogPath: fake.logPath,
  };
}

test("run_subagent_session rejects raw session_id", async () => {
  const fixture = await createSessionFixture();
  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fixture.fakeChildPath,
      FAKE_PI_LOG_PATH: fixture.fakeLogPath,
      SUBAGENT007_FAILURE_LOG: "off",
    },
    async () => {
      await assert.rejects(
        runSubagentSession(
          {
            cwd: fixture.projectDir,
            prompt: "FAST",
            session_key: "coherent-execution:T000",
            model: "openai-codex/gpt-5.4-mini",
            thinking_level: "medium",
            session_id: "raw",
          } as Parameters<typeof runSubagentSession>[0] & { session_id: string },
          { sessionsDir: fixture.sessionsDir },
        ),
        /session_id is not supported by run_subagent_session/,
      );
    },
  );
});

test("run_subagent_session creates, resumes, and appends an auditable Pi ledger", async () => {
  const fixture = await createSessionFixture();
  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fixture.fakeChildPath,
      FAKE_PI_LOG_PATH: fixture.fakeLogPath,
      SUBAGENT007_FAILURE_LOG: "off",
    },
    async () => {
      const created = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "FAST",
          session_key: "coherent-execution:T001",
          resume_mode: "new",
          model: "openai-codex/gpt-5.4-mini",
          thinking_level: "medium",
        },
        { sessionsDir: fixture.sessionsDir },
      );

      assert.equal(created.success, true);
      assert.equal(created.created_or_resumed, "created");
      assert.match(created.subagent_session_id ?? "", /pi-session\/fake-pi-session\.jsonl$/);
      assert.equal(created.run_record.subagent_session_id, created.subagent_session_id);

      const manifest = JSON.parse(await fs.readFile(created.manifest_path, "utf8")) as SessionManifest;
      assert.equal(manifest.session_key, "coherent-execution:T001");
      assert.equal(manifest.subagent_session_id, created.subagent_session_id);
      assert.equal(manifest.run_count, 1);

      const resumed = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "FAST",
          session_key: "coherent-execution:T001",
          model: "openai-codex/gpt-5.4-mini",
          thinking_level: "high",
        },
        { sessionsDir: fixture.sessionsDir },
      );

      assert.equal(resumed.success, true);
      assert.equal(resumed.created_or_resumed, "resumed");
      assert.equal(resumed.subagent_session_id, created.subagent_session_id);
      assert.equal(resumed.model_changed_from_manifest, false);
      assert.equal(resumed.thinking_level_changed_from_manifest, true);

      const records = await readJsonl<SessionRunRecord>(created.ledger_path);
      assert.equal(records.length, 2);
      assert.equal(records[0].action, "created");
      assert.equal(records[1].action, "resumed");
      assert.equal(records[1].subagent_session_id, created.subagent_session_id);

      const childLogs = await readJsonl<{ request: Record<string, unknown> }>(fixture.fakeLogPath);
      assert.equal(childLogs[0].request.sessionMode, "fresh");
      assert.equal(childLogs[1].request.sessionMode, "resume");
      assert.match(String(childLogs[1].request.sessionFile), /attempt-pi-sessions\/0002-/);
      assert.match(String(childLogs[1].request.sessionFile), /fake-pi-session\.jsonl$/);
    },
  );
});

test("run_subagent_session fails closed on invalid persisted session state", async () => {
  const fixture = await createSessionFixture();
  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fixture.fakeChildPath,
      FAKE_PI_LOG_PATH: fixture.fakeLogPath,
      SUBAGENT007_FAILURE_LOG: "off",
    },
    async () => {
      const created = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "FAST",
          session_key: "coherent-execution:T002",
          model: "openai-codex/gpt-5.4-mini",
          thinking_level: "medium",
        },
        { sessionsDir: fixture.sessionsDir },
      );
      const manifest = JSON.parse(await fs.readFile(created.manifest_path, "utf8")) as Record<string, unknown>;
      delete manifest.subagent_session_id;
      await fs.writeFile(created.manifest_path, `${JSON.stringify(manifest)}\n`);

      await assert.rejects(
        runSubagentSession(
          {
            cwd: fixture.projectDir,
            prompt: "FAST",
            session_key: "coherent-execution:T002",
            model: "openai-codex/gpt-5.4-mini",
            thinking_level: "medium",
          },
          { sessionsDir: fixture.sessionsDir },
        ),
        /session manifest is invalid/,
      );
    },
  );
});

test("run_subagent_session records an attempt and failure log when Pi omits the session event", async () => {
  const fixture = await createSessionFixture();
  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fixture.fakeChildPath,
      FAKE_PI_LOG_PATH: fixture.fakeLogPath,
      SUBAGENT007_FAILURE_LOG_PATH: fixture.failureLogPath,
      SUBAGENT007_RECORD_SOURCE: "test",
    },
    async () => {
      const failed = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "NO_SESSION",
          session_key: "coherent-execution:T003",
          resume_mode: "new",
          model: "openai-codex/gpt-5.4-mini",
          thinking_level: "medium",
        },
        { sessionsDir: fixture.sessionsDir },
      );

      assert.equal(failed.success, false);
      assert.equal(failed.subagent_session_id, null);
      assert.equal(failed.session_established, false);
      assert.equal(failed.created_or_resumed, "not_created");
      assert.equal(failed.run_record.error, "Pi did not report a persisted session file");

      const attempts = await readJsonl<SessionRunRecord>(failed.attempts_path);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].action, "not_created");
      const failures = await readJsonl<{ tool: string; failure_class: string; reason_code: string }>(
        fixture.failureLogPath,
      );
      assert.equal(failures.length, 1);
      assert.equal(failures[0].tool, "run_subagent_session");
      assert.equal(failures[0].failure_class, "missing_session_id");
      assert.equal(failures[0].reason_code, "missing_session_id");
    },
  );
});

test("run_subagent_session enforces cwd identity and immutable skill binding", async () => {
  const fixture = await createSessionFixture();
  const otherProject = path.join(path.dirname(fixture.projectDir), "other");
  await fs.mkdir(otherProject, { recursive: true });
  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fixture.fakeChildPath,
      FAKE_PI_LOG_PATH: fixture.fakeLogPath,
      SUBAGENT007_FAILURE_LOG: "off",
    },
    async () => {
      await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "FAST",
          session_key: "coherent-execution:T004",
          skill: "pda-lite",
          model: "openai-codex/gpt-5.4-mini",
          thinking_level: "medium",
        },
        { sessionsDir: fixture.sessionsDir },
      );

      await assert.rejects(
        runSubagentSession(
          {
            cwd: otherProject,
            prompt: "FAST",
            session_key: "coherent-execution:T004",
            resume_mode: "require_existing",
            skill: "pda-lite",
            model: "openai-codex/gpt-5.4-mini",
            thinking_level: "medium",
          },
          { sessionsDir: fixture.sessionsDir },
        ),
        /session does not exist/,
      );
      await assert.rejects(
        runSubagentSession(
          {
            cwd: fixture.projectDir,
            prompt: "FAST",
            session_key: "coherent-execution:T004",
            model: "openai-codex/gpt-5.4-mini",
            thinking_level: "medium",
          },
          { sessionsDir: fixture.sessionsDir },
        ),
        /session skill mismatch/,
      );
    },
  );
});

test("run_subagent_session recovers only definitely stale local locks", async () => {
  const fixture = await createSessionFixture();
  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fixture.fakeChildPath,
      FAKE_PI_LOG_PATH: fixture.fakeLogPath,
      SUBAGENT007_FAILURE_LOG: "off",
    },
    async () => {
      const created = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "FAST",
          session_key: "coherent-execution:T005",
          model: "openai-codex/gpt-5.4-mini",
          thinking_level: "medium",
        },
        { sessionsDir: fixture.sessionsDir },
      );
      const lockPath = path.join(created.session_dir, "run.lock");
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ pid: 99999999, hostname: os.hostname(), created_at: new Date().toISOString() })}\n`,
      );

      const resumed = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "FAST",
          session_key: "coherent-execution:T005",
          model: "openai-codex/gpt-5.4-mini",
          thinking_level: "medium",
        },
        { sessionsDir: fixture.sessionsDir },
      );
      assert.equal(resumed.success, true);

      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ pid: process.pid, hostname: os.hostname(), created_at: new Date().toISOString() })}\n`,
      );
      await assert.rejects(
        runSubagentSession(
          {
            cwd: fixture.projectDir,
            prompt: "FAST",
            session_key: "coherent-execution:T005",
            model: "openai-codex/gpt-5.4-mini",
            thinking_level: "medium",
          },
          { sessionsDir: fixture.sessionsDir },
        ),
        /session is already running/,
      );
      await fs.rm(lockPath, { force: true });
    },
  );
});

test("run_subagent_session can require packets without making packet logic part of the workflow", async () => {
  const fixture = await createSessionFixture();
  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fixture.fakeChildPath,
      FAKE_PI_LOG_PATH: fixture.fakeLogPath,
      SUBAGENT007_FAILURE_LOG: "off",
    },
    async () => {
      const missing = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "FAST",
          session_key: "coherent-execution:T006-missing",
          packet_policy: "required",
          model: "openai-codex/gpt-5.4-mini",
          thinking_level: "medium",
        },
        { sessionsDir: fixture.sessionsDir },
      );
      assert.equal(missing.success, false);
      assert.equal(missing.packet_parse_status, "missing");
      await assert.rejects(fs.stat(missing.manifest_path), /ENOENT/);
      const attempts = await readJsonl<SessionRunRecord>(missing.attempts_path);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].success, false);
      assert.equal(attempts[0].action, "not_created");

      const valid = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "PACKET_VALID",
          session_key: "coherent-execution:T006-valid",
          packet_policy: "required",
          model: "openai-codex/gpt-5.4-mini",
          thinking_level: "medium",
        },
        { sessionsDir: fixture.sessionsDir },
      );
      assert.equal(valid.success, true);
      assert.equal(valid.packet_parse_status, "valid");
      assert.equal(valid.claimed_packet?.verdict, "ready");
      assert.equal(typeof valid.packet_path, "string");
    },
  );
});

test("run_subagent_session does not commit failed packet resumes", async () => {
  const fixture = await createSessionFixture();
  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fixture.fakeChildPath,
      FAKE_PI_LOG_PATH: fixture.fakeLogPath,
      SUBAGENT007_FAILURE_LOG: "off",
    },
    async () => {
      const created = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "FAST",
          session_key: "coherent-execution:T007",
          model: "openai-codex/gpt-5.4-mini",
          thinking_level: "medium",
        },
        { sessionsDir: fixture.sessionsDir },
      );
      assert.equal(created.success, true);

      const failed = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "FAST",
          session_key: "coherent-execution:T007",
          packet_policy: "required",
          model: "openai-codex/gpt-5.4-mini",
          thinking_level: "medium",
        },
        { sessionsDir: fixture.sessionsDir },
      );

      assert.equal(failed.success, false);
      assert.equal(failed.packet_parse_status, "missing");
      assert.equal(failed.created_or_resumed, "not_created");

      const manifest = JSON.parse(await fs.readFile(created.manifest_path, "utf8")) as SessionManifest;
      assert.equal(manifest.run_count, 1);
      assert.equal(manifest.last_output_path, created.output_path);

      const ledger = await readJsonl<SessionRunRecord>(created.ledger_path);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].success, true);

      const attempts = await readJsonl<SessionRunRecord>(created.attempts_path);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].success, false);
      assert.equal(attempts[0].action, "not_created");
    },
  );
});
