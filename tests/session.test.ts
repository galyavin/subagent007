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
            model_class: "C",
            session_id: "raw",
          } as Parameters<typeof runSubagentSession>[0] & { session_id: string },
          { sessionsDir: fixture.sessionsDir },
        ),
        /session_id is not supported by run_subagent_session/,
      );
    },
  );
});

test("run_subagent_session rejects raw continuity", async () => {
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
            session_key: "coherent-execution:T000-continuity",
            model_class: "C",
            continuity: { mode: "fresh" },
          } as Parameters<typeof runSubagentSession>[0] & { continuity: { mode: "fresh" } },
          { sessionsDir: fixture.sessionsDir },
        ),
        /continuity is not supported by run_subagent_session/,
      );
    },
  );
});

test("run_subagent_session rejects invalid resume mode and packet policy", async () => {
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
            session_key: "coherent-execution:T000-invalid-resume",
            model_class: "C",
            resume_mode: "invalid" as never,
          },
          { sessionsDir: fixture.sessionsDir },
        ),
        /resume_mode must be one of: new, resume_or_new, require_existing/,
      );

      await assert.rejects(
        runSubagentSession(
          {
            cwd: fixture.projectDir,
            prompt: "FAST",
            session_key: "coherent-execution:T000-invalid-packet",
            model_class: "C",
            packet_policy: "invalid" as never,
          },
          { sessionsDir: fixture.sessionsDir },
        ),
        /packet_policy must be one of: none, required, best_effort/,
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
          model_class: "C",
        },
        { sessionsDir: fixture.sessionsDir },
      );

      assert.equal(created.success, true);
      assert.equal(created.created_or_resumed, "created");
      assert.equal(created.model_changed_from_manifest, false);
      assert.equal(created.thinking_level_changed_from_manifest, false);
      assert.match(created.subagent_session_id ?? "", /pi-session\/fake-pi-session\.jsonl$/);
      assert.match(created.attempt_subagent_session_id ?? "", /attempt-pi-sessions\/0001-/);
      assert.equal(created.attempt_session_established, true);
      assert.equal(created.run_record.subagent_session_id, created.subagent_session_id);
      assert.equal(created.run_record.attempt_subagent_session_id, created.attempt_subagent_session_id);
      assert.equal(created.run_record.attempt_session_established, true);

      const manifest = JSON.parse(await fs.readFile(created.manifest_path, "utf8")) as SessionManifest;
      assert.equal(manifest.session_key, "coherent-execution:T001");
      assert.equal(manifest.subagent_session_id, created.subagent_session_id);
      assert.equal(manifest.run_count, 1);
      const legacyManifest = { ...manifest };
      delete legacyManifest.initial_model_class;
      await fs.writeFile(
        created.manifest_path,
        `${JSON.stringify(legacyManifest, null, 2)}\n`,
      );

      const resumedLegacy = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "FAST",
          session_key: "coherent-execution:T001",
          model_class: "C",
        },
        { sessionsDir: fixture.sessionsDir },
      );

      assert.equal(resumedLegacy.success, true);
      assert.equal(resumedLegacy.created_or_resumed, "resumed");
      assert.equal(resumedLegacy.model_changed_from_manifest, false);
      assert.equal(resumedLegacy.thinking_level_changed_from_manifest, false);

      const resumedLegacyManifest = JSON.parse(await fs.readFile(created.manifest_path, "utf8")) as SessionManifest;
      await fs.writeFile(
        created.manifest_path,
        `${JSON.stringify({ ...resumedLegacyManifest, initial_model_class: "D", initial_thinking_level: "xhigh" }, null, 2)}\n`,
      );

      const resumed = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "FAST",
          session_key: "coherent-execution:T001",
          model_class: "C",
        },
        { sessionsDir: fixture.sessionsDir },
      );

      assert.equal(resumed.success, true);
      assert.equal(resumed.created_or_resumed, "resumed");
      assert.equal(resumed.subagent_session_id, created.subagent_session_id);
      assert.match(resumed.attempt_subagent_session_id ?? "", /attempt-pi-sessions\/0003-/);
      assert.equal(resumed.attempt_session_established, true);
      assert.equal(resumed.model_changed_from_manifest, true);
      assert.equal(resumed.thinking_level_changed_from_manifest, true);

      const records = await readJsonl<SessionRunRecord>(created.ledger_path);
      assert.equal(records.length, 3);
      assert.equal(records[0].action, "created");
      assert.equal(records[1].action, "resumed");
      assert.equal(records[2].action, "resumed");
      assert.equal(records[1].subagent_session_id, created.subagent_session_id);
      assert.equal(records[1].attempt_subagent_session_id, resumedLegacy.attempt_subagent_session_id);
      assert.equal(records[1].attempt_session_established, true);
      assert.equal(records[2].subagent_session_id, created.subagent_session_id);
      assert.equal(records[2].attempt_subagent_session_id, resumed.attempt_subagent_session_id);
      assert.equal(records[2].attempt_session_established, true);

      const childLogs = await readJsonl<{ request: Record<string, unknown> }>(fixture.fakeLogPath);
      assert.equal(childLogs[0].request.sessionMode, "fresh");
      assert.equal(childLogs[0].request.toolProfile, "inspect");
      assert.equal(childLogs[1].request.sessionMode, "resume");
      assert.equal(childLogs[1].request.toolProfile, "inspect");
      assert.match(String(childLogs[1].request.sessionFile), /attempt-pi-sessions\/0002-/);
      assert.match(String(childLogs[1].request.sessionFile), /fake-pi-session\.jsonl$/);
      assert.equal(childLogs[2].request.sessionMode, "resume");
      assert.equal(childLogs[2].request.toolProfile, "inspect");
      assert.match(String(childLogs[2].request.sessionFile), /attempt-pi-sessions\/0003-/);
      assert.match(String(childLogs[2].request.sessionFile), /fake-pi-session\.jsonl$/);
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
          model_class: "C",
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
            model_class: "C",
          },
          { sessionsDir: fixture.sessionsDir },
        ),
        /session manifest is invalid/,
      );

      const invalidClass = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "FAST",
          session_key: "coherent-execution:T002-invalid-class",
          model_class: "C",
        },
        { sessionsDir: fixture.sessionsDir },
      );
      const invalidClassManifest = JSON.parse(
        await fs.readFile(invalidClass.manifest_path, "utf8"),
      ) as Record<string, unknown>;
      invalidClassManifest.initial_model_class = "Z";
      await fs.writeFile(invalidClass.manifest_path, `${JSON.stringify(invalidClassManifest)}\n`);

      await assert.rejects(
        runSubagentSession(
          {
            cwd: fixture.projectDir,
            prompt: "FAST",
            session_key: "coherent-execution:T002-invalid-class",
            model_class: "C",
          },
          { sessionsDir: fixture.sessionsDir },
        ),
        /session manifest is invalid/,
      );

      const invalidLedger = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "FAST",
          session_key: "coherent-execution:T002-invalid-ledger",
          model_class: "C",
        },
        { sessionsDir: fixture.sessionsDir },
      );
      const records = await readJsonl<Record<string, unknown>>(invalidLedger.ledger_path);
      records[0].resolved_model_class = "Z";
      await fs.writeFile(
        invalidLedger.ledger_path,
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );

      await assert.rejects(
        runSubagentSession(
          {
            cwd: fixture.projectDir,
            prompt: "FAST",
            session_key: "coherent-execution:T002-invalid-ledger",
            model_class: "C",
          },
          { sessionsDir: fixture.sessionsDir },
        ),
        /session ledger is invalid/,
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
          model_class: "C",
        },
        { sessionsDir: fixture.sessionsDir },
      );

      assert.equal(failed.success, false);
      assert.equal(failed.subagent_session_id, null);
      assert.equal(failed.session_established, false);
      assert.equal(failed.attempt_subagent_session_id, null);
      assert.equal(failed.attempt_session_established, false);
      assert.equal(failed.created_or_resumed, "not_created");
      assert.equal(failed.run_record.error, "Pi did not report a persisted session file");

      const attempts = await readJsonl<SessionRunRecord>(failed.attempts_path);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].action, "not_created");
      assert.equal(attempts[0].attempt_subagent_session_id, null);
      assert.equal(attempts[0].attempt_session_established, false);
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
          skill_name: "pda-lite",
          model_class: "C",
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
            skill_name: "pda-lite",
            model_class: "C",
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
            model_class: "C",
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
          model_class: "C",
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
          model_class: "C",
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
            model_class: "C",
          },
          { sessionsDir: fixture.sessionsDir },
        ),
        /session is already running/,
      );
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({
          pid: process.pid,
          hostname: os.hostname(),
          created_at: new Date(Date.now() - 60_000).toISOString(),
          task_id: "expired-task",
          owner_id: "expired-owner",
          lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
        })}\n`,
      );
      const recoveredExpiredLease = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "FAST",
          session_key: "coherent-execution:T005",
          model_class: "C",
        },
        { sessionsDir: fixture.sessionsDir },
      );
      assert.equal(recoveredExpiredLease.success, true);
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
          model_class: "C",
        },
        { sessionsDir: fixture.sessionsDir },
      );
      assert.equal(missing.success, false);
      assert.equal(missing.packet_parse_status, "missing");
      assert.equal(missing.subagent_session_id, null);
      assert.equal(missing.session_established, false);
      assert.match(missing.attempt_subagent_session_id ?? "", /attempt-pi-sessions\/0001-/);
      assert.equal(missing.attempt_session_established, true);
      await assert.rejects(fs.stat(missing.manifest_path), /ENOENT/);
      const attempts = await readJsonl<SessionRunRecord>(missing.attempts_path);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].success, false);
      assert.equal(attempts[0].action, "not_created");
      assert.equal(attempts[0].attempt_subagent_session_id, missing.attempt_subagent_session_id);
      assert.equal(attempts[0].attempt_session_established, true);

      const valid = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "PACKET_VALID",
          session_key: "coherent-execution:T006-valid",
          packet_policy: "required",
          model_class: "C",
        },
        { sessionsDir: fixture.sessionsDir },
      );
      assert.equal(valid.success, true);
      assert.equal(valid.packet_parse_status, "valid");
      assert.match(valid.subagent_session_id ?? "", /pi-session\/fake-pi-session\.jsonl$/);
      assert.match(valid.attempt_subagent_session_id ?? "", /attempt-pi-sessions\/0001-/);
      assert.equal(valid.session_established, true);
      assert.equal(valid.attempt_session_established, true);
      assert.equal(valid.claimed_packet?.verdict, "ready");
      assert.equal(typeof valid.packet_path, "string");

      const validWithClosure = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "PACKET_VALID_WITH_CLOSURE",
          session_key: "coherent-execution:T006-valid-with-closure",
          packet_policy: "required",
          model_class: "C",
        },
        { sessionsDir: fixture.sessionsDir },
      );
      assert.equal(validWithClosure.success, true);
      assert.equal(validWithClosure.packet_parse_status, "valid");
      assert.equal(validWithClosure.claimed_packet?.verdict, "ready");
      assert.equal(validWithClosure.claimed_packet?.closure?.artifact_roles?.[0]?.path, "tests/helpers/fakePiChild.ts");
      assert.equal(validWithClosure.claimed_packet?.closure?.validation?.[0], "closure shape parsed");
      assert.equal(typeof validWithClosure.packet_path, "string");

      const invalidClosure = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "PACKET_INVALID_CLOSURE_SHAPE",
          session_key: "coherent-execution:T006-invalid-closure",
          packet_policy: "required",
          model_class: "C",
        },
        { sessionsDir: fixture.sessionsDir },
      );
      assert.equal(invalidClosure.success, false);
      assert.equal(invalidClosure.created_or_resumed, "not_created");
      assert.equal(invalidClosure.packet_parse_status, "invalid");
      assert.match(invalidClosure.packet_error ?? "", /closure\.artifact_roles/);
      assert.match(invalidClosure.packet_error ?? "", /closure\.validation/);
      await assert.rejects(fs.stat(invalidClosure.manifest_path), /ENOENT/);
      const invalidClosureAttempts = await readJsonl<SessionRunRecord>(invalidClosure.attempts_path);
      assert.equal(invalidClosureAttempts.length, 1);
      assert.equal(invalidClosureAttempts[0].success, false);
      assert.equal(invalidClosureAttempts[0].action, "not_created");

      const nonReadyCases = [
        {
          prompt: "PACKET_INCONCLUSIVE",
          sessionKey: "coherent-execution:T006-inconclusive",
          verdict: "inconclusive",
        },
        {
          prompt: "PACKET_NEEDS_REPAIR",
          sessionKey: "coherent-execution:T006-needs-repair",
          verdict: "needs_repair",
        },
        {
          prompt: "PACKET_BLOCKED",
          sessionKey: "coherent-execution:T006-blocked",
          verdict: "blocked",
        },
        {
          prompt: "PACKET_READY_WITH_BLOCKER",
          sessionKey: "coherent-execution:T006-ready-with-blocker",
          verdict: "ready",
        },
      ];

      for (const packetCase of nonReadyCases) {
        const failed = await runSubagentSession(
          {
            cwd: fixture.projectDir,
            prompt: packetCase.prompt,
            session_key: packetCase.sessionKey,
            packet_policy: "required",
            model_class: "C",
          },
          { sessionsDir: fixture.sessionsDir },
        );
        assert.equal(failed.success, false);
        assert.equal(failed.created_or_resumed, "not_created");
        assert.equal(failed.packet_parse_status, "valid");
        assert.equal(failed.claimed_packet?.verdict, packetCase.verdict);
        assert.equal(typeof failed.packet_path, "string");
        await assert.rejects(fs.stat(failed.manifest_path), /ENOENT/);
        const caseAttempts = await readJsonl<SessionRunRecord>(failed.attempts_path);
        assert.equal(caseAttempts.length, 1);
        assert.equal(caseAttempts[0].success, false);
        assert.equal(caseAttempts[0].action, "not_created");
      }
    },
  );
});

test("run_subagent_session timeout does not emit one-shot recovery guidance", async () => {
  const fixture = await createSessionFixture();
  await withEnv(
    {
      SUBAGENT007_PI_CHILD_PATH: fixture.fakeChildPath,
      FAKE_PI_LOG_PATH: fixture.fakeLogPath,
      SUBAGENT007_FAILURE_LOG: "off",
      SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS: "0",
      SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS: "100",
      SUBAGENT007_TIMEOUT_KILL_GRACE_MS: "50",
      SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: "50",
    },
    async () => {
      const failed = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "TIMEOUT_ASSISTANT_EVENT",
          session_key: "coherent-execution:T006-timeout",
          timeout_ms: 260,
          model_class: "C",
        },
        { sessionsDir: fixture.sessionsDir },
      );

      assert.equal(failed.success, false);
      assert.equal(failed.timed_out, true);
      assert.equal((failed as unknown as Record<string, unknown>).timeout_recovery_hint, undefined);
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
          model_class: "C",
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
          model_class: "C",
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

test("run_subagent_session does not commit non-ready required packet resumes", async () => {
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
          prompt: "PACKET_VALID",
          session_key: "coherent-execution:T008",
          packet_policy: "required",
          model_class: "C",
        },
        { sessionsDir: fixture.sessionsDir },
      );
      assert.equal(created.success, true);

      const failed = await runSubagentSession(
        {
          cwd: fixture.projectDir,
          prompt: "PACKET_INCONCLUSIVE",
          session_key: "coherent-execution:T008",
          packet_policy: "required",
          model_class: "C",
        },
        { sessionsDir: fixture.sessionsDir },
      );

      assert.equal(failed.success, false);
      assert.equal(failed.packet_parse_status, "valid");
      assert.equal(failed.claimed_packet?.verdict, "inconclusive");
      assert.equal(failed.created_or_resumed, "not_created");
      assert.equal(failed.subagent_session_id, created.subagent_session_id);
      assert.equal(failed.session_established, true);
      assert.match(failed.attempt_subagent_session_id ?? "", /attempt-pi-sessions\/0002-/);
      assert.notEqual(failed.attempt_subagent_session_id, failed.subagent_session_id);
      assert.equal(failed.attempt_session_established, true);

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
      assert.equal(attempts[0].subagent_session_id, created.subagent_session_id);
      assert.equal(attempts[0].attempt_subagent_session_id, failed.attempt_subagent_session_id);
      assert.equal(attempts[0].attempt_session_established, true);
    },
  );
});
