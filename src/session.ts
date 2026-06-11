import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "./config.js";
import {
  failureClassForSessionResult,
  failureReasonCodeForSessionResult,
  logFailure,
} from "./failureLog.js";
import { resolveAllowedModelRef } from "./modelAllowlist.js";
import { defaultSessionsDir } from "./output.js";
import { appendContractPacketInstruction, extractContractPacket } from "./packet.js";
import type { HeartbeatNotify } from "./progress.js";
import { runSubagent } from "./runSubagent.js";
import {
  OUTPUT_MODES,
  PACKET_PARSE_STATUSES,
  RESUME_MODES,
  RUN_STOP_REASONS,
  SESSION_PACKET_POLICIES,
  type ContractPacketV1,
  TOOL_PROFILES,
  type PacketParseStatus,
  type ResumeMode,
  type RunSubagentRequest,
  type RunSubagentSessionRequest,
  type RunSubagentSessionResult,
  type SessionManifest,
  type SessionPacketPolicy,
  type SessionRunRecord,
} from "./types.js";
import { ValidationError } from "./types.js";
import { validateAndResolveRequest } from "./validate.js";

const SESSION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const sessionManifestSchema = z.object({
  schema_version: z.literal(1),
  session_key: z.string(),
  cwd: z.string(),
  skill: z.string().nullable(),
  initial_model: z.string(),
  initial_thinking_level: z.string(),
  initial_model_class: z.enum(["A", "B", "C", "D", "E"]).optional(),
  subagent_session_id: z.string(),
  created_at: z.string(),
  last_run_at: z.string(),
  run_count: z.number().int().nonnegative(),
  last_output_path: z.string(),
  status: z.literal("active"),
});

const sessionRunRecordSchema = z.object({
  run_id: z.string(),
  sequence: z.number().int().positive(),
  started_at: z.string(),
  finished_at: z.string(),
  action: z.enum(["created", "resumed", "not_created"]),
  subagent_session_id: z.string().nullable(),
  attempt_subagent_session_id: z.string().nullable().optional(),
  attempt_session_established: z.boolean().optional(),
  resume_mode: z.enum(RESUME_MODES),
  output_path: z.string(),
  packet_path: z.string().nullable(),
  packet_policy: z.enum(SESSION_PACKET_POLICIES),
  packet_parse_status: z.enum(PACKET_PARSE_STATUSES),
  packet_error: z.string().optional(),
  success: z.boolean(),
  exit_code: z.number().int().nullable(),
  timed_out: z.boolean(),
  partial_output_available: z.boolean().optional(),
  resume_possible: z.boolean().optional(),
  duration_ms: z.number().int().nonnegative(),
  requested_timeout_ms: z.number().int().positive().nullable().optional(),
  resolved_timeout_ms: z.number().int().positive().nullable().optional(),
  timeout_floor_ms: z.number().int().nonnegative().optional(),
  effective_timeout_ms: z.number().int().positive().nullable().optional(),
  timeout_headroom_ms: z.number().int().nonnegative().optional(),
  kill_grace_ms: z.number().int().nonnegative().optional(),
  force_grace_ms: z.number().int().nonnegative().optional(),
  resolved_model_class: z.enum(["A", "B", "C", "D", "E"]).optional(),
  resolved_model: z.string(),
  resolved_thinking_level: z.string(),
  requested_skill: z.string().nullable(),
  requested_output_mode: z.enum(OUTPUT_MODES),
  written_output_mode: z.enum(OUTPUT_MODES),
  resolved_tool_profile: z.enum(TOOL_PROFILES).optional(),
  stop_reason: z.enum(RUN_STOP_REASONS).optional(),
  error: z.string().optional(),
});

interface LockOwner {
  pid: number;
  hostname: string;
  created_at: string;
}

function validationSummary(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
}

function validateSessionKey(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError("session_key must be a nonempty string");
  }
  const key = value.trim();
  if (!SESSION_KEY_PATTERN.test(key)) {
    throw new ValidationError(
      "session_key must start with an ASCII letter or digit and contain only letters, digits, underscores, hyphens, dots, or colons",
    );
  }
  return key;
}

function validateResumeMode(value: unknown): ResumeMode {
  if (value === undefined) {
    return "resume_or_new";
  }
  if (typeof value !== "string" || !RESUME_MODES.includes(value as ResumeMode)) {
    throw new ValidationError(`resume_mode must be one of: ${RESUME_MODES.join(", ")}`);
  }
  return value as ResumeMode;
}

function validateSessionPacketPolicy(value: unknown): SessionPacketPolicy {
  if (value === undefined) {
    return "none";
  }
  if (
    typeof value !== "string" ||
    !SESSION_PACKET_POLICIES.includes(value as SessionPacketPolicy)
  ) {
    throw new ValidationError(
      `packet_policy must be one of: ${SESSION_PACKET_POLICIES.join(", ")}`,
    );
  }
  return value as SessionPacketPolicy;
}

function assertNoRawSessionId(request: RunSubagentSessionRequest): void {
  if ((request as { session_id?: unknown }).session_id !== undefined) {
    throw new ValidationError("session_id is not supported by run_subagent_session; use session_key");
  }
  if ((request as { continuity?: unknown }).continuity !== undefined) {
    throw new ValidationError("continuity is not supported by run_subagent_session; use session_key and resume_mode");
  }
}

function identityHash(cwd: string, sessionKey: string): string {
  return createHash("sha256").update(`${cwd}\0${sessionKey}`).digest("hex").slice(0, 32);
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 48);
}

function sessionDirFor(sessionsDir: string, cwd: string, sessionKey: string): string {
  return path.join(sessionsDir, `${slug(sessionKey)}-${identityHash(cwd, sessionKey)}`);
}

async function readManifest(manifestPath: string): Promise<SessionManifest | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new ValidationError(`session manifest is unreadable: ${(error as Error).message}`);
  }
  const result = sessionManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError(`session manifest is invalid: ${validationSummary(result.error)}`);
  }
  return result.data;
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8")) as LockOwner;
  } catch {
    return null;
  }
}

function processIsDefinitelyGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function isStaleLocalLock(owner: LockOwner | null): boolean {
  return Boolean(
    owner &&
      owner.hostname === os.hostname() &&
      Number.isInteger(owner.pid) &&
      owner.pid > 0 &&
      processIsDefinitelyGone(owner.pid),
  );
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const owner: LockOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    created_at: new Date().toISOString(),
  };
  for (const staleRecoveryAttempt of [false, true]) {
    try {
      await fs.writeFile(lockPath, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
      return async () => {
        await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const existingOwner = await readLockOwner(lockPath);
      if (!staleRecoveryAttempt && isStaleLocalLock(existingOwner)) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      const ownerDescription = existingOwner
        ? ` by pid ${existingOwner.pid} on ${existingOwner.hostname}`
        : "";
      throw new ValidationError(`session is already running${ownerDescription}`);
    }
  }
  throw new ValidationError("session is already running");
}

async function writePacket(sessionDir: string, runId: string, output: string): Promise<{
  packetPath: string | null;
  packetParseStatus: PacketParseStatus;
  packetError?: string;
  claimedPacket: RunSubagentSessionResult["claimed_packet"];
}> {
  const packetExtraction = extractContractPacket(output);
  if (!packetExtraction.packet) {
    return {
      packetPath: null,
      packetParseStatus: packetExtraction.status,
      packetError: packetExtraction.error,
      claimedPacket: null,
    };
  }
  const packetPath = path.join(sessionDir, "packets", `${runId}.json`);
  await fs.mkdir(path.dirname(packetPath), { recursive: true });
  await fs.writeFile(packetPath, `${JSON.stringify(packetExtraction.packet, null, 2)}\n`, "utf8");
  return {
    packetPath,
    packetParseStatus: packetExtraction.status,
    packetError: packetExtraction.error,
    claimedPacket: packetExtraction.packet,
  };
}

function packetSatisfied(
  policy: SessionPacketPolicy,
  status: PacketParseStatus,
  packet: ContractPacketV1 | null,
): boolean {
  if (policy === "none" || policy === "best_effort") {
    return true;
  }
  return status === "valid" && packet?.verdict === "ready" && packet.blockers.length === 0;
}

function assertExistingSession(
  manifest: SessionManifest | null,
  resumeMode: ResumeMode,
  sessionKey: string,
): asserts manifest is SessionManifest {
  if (manifest) {
    return;
  }
  if (resumeMode === "require_existing") {
    throw new ValidationError(`session does not exist for session_key: ${sessionKey}`);
  }
}

function assertNewSessionAllowed(
  manifest: SessionManifest | null,
  resumeMode: ResumeMode,
  sessionKey: string,
): void {
  if (manifest && resumeMode === "new") {
    throw new ValidationError(`session already exists for session_key: ${sessionKey}`);
  }
}

function assertManifestCompatible(
  manifest: SessionManifest,
  cwd: string,
  skill: string | undefined,
): void {
  if (manifest.cwd !== cwd) {
    throw new ValidationError("session manifest cwd does not match requested cwd");
  }
  const requestedSkill = skill ?? null;
  if (manifest.skill !== requestedSkill) {
    throw new ValidationError(
      `session skill mismatch: existing=${manifest.skill ?? "none"} requested=${
        requestedSkill ?? "none"
      }`,
    );
  }
}

async function readLedgerRecords(ledgerPath: string): Promise<SessionRunRecord[]> {
  let ledgerText: string;
  try {
    ledgerText = await fs.readFile(ledgerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const lines = ledgerText.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new ValidationError(
        `session ledger is invalid at line ${index + 1}: ${(error as Error).message}`,
      );
    }
    const result = sessionRunRecordSchema.safeParse(parsed);
    if (!result.success) {
      throw new ValidationError(
        `session ledger is invalid at line ${index + 1}: ${validationSummary(result.error)}`,
      );
    }
    return result.data;
  });
}

async function writeManifestAtomic(manifestPath: string, manifest: SessionManifest): Promise<void> {
  const tmpPath = `${manifestPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, manifestPath);
}

async function reconcileManifestWithLedger(
  manifest: SessionManifest,
  manifestPath: string,
  ledgerPath: string,
): Promise<SessionManifest> {
  const records = await readLedgerRecords(ledgerPath);
  if (records.length === manifest.run_count) {
    return manifest;
  }
  if (records.length < manifest.run_count) {
    throw new ValidationError(
      `session ledger is behind manifest: ledger=${records.length} manifest=${manifest.run_count}`,
    );
  }
  const last = records.at(-1);
  if (!last || last.action === "not_created") {
    throw new ValidationError("session ledger cannot reconcile manifest from a failed start record");
  }
  if (last.subagent_session_id && last.subagent_session_id !== manifest.subagent_session_id) {
    throw new ValidationError("session ledger subagent_session_id does not match manifest");
  }
  const reconciled: SessionManifest = {
    ...manifest,
    run_count: records.length,
    last_run_at: last.finished_at,
    last_output_path: last.output_path,
  };
  await writeManifestAtomic(manifestPath, reconciled);
  return reconciled;
}

function sessionRunRequest(
  resolved: Awaited<ReturnType<typeof validateAndResolveRequest>>,
  manifest: SessionManifest | null,
): RunSubagentRequest {
  return {
    prompt: resolved.prompt,
    cwd: resolved.cwd,
    model_class: resolved.modelClass,
    timeout_ms: resolved.timeoutMs,
    skill: resolved.skill,
    output_mode: resolved.outputMode,
    tool_profile: resolved.toolProfile,
    continuity: manifest
      ? { mode: "resume", session_id: manifest.subagent_session_id }
      : { mode: "fresh" },
  };
}

function modelRefForComparison(modelRef: string): string {
  try {
    return resolveAllowedModelRef(modelRef);
  } catch {
    return modelRef;
  }
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
}

async function prepareAttemptSession(
  sessionDir: string,
  runId: string,
  manifest: SessionManifest | null,
): Promise<{
  attemptPiSessionDir: string;
  runManifest: SessionManifest | null;
}> {
  const attemptPiSessionDir = path.join(sessionDir, "attempt-pi-sessions", runId);
  if (!manifest) {
    return { attemptPiSessionDir, runManifest: null };
  }

  const canonicalPiSessionDir = path.dirname(manifest.subagent_session_id);
  await copyDirectoryContents(canonicalPiSessionDir, attemptPiSessionDir);
  return {
    attemptPiSessionDir,
    runManifest: {
      ...manifest,
      subagent_session_id: path.join(attemptPiSessionDir, path.basename(manifest.subagent_session_id)),
    },
  };
}

async function promoteAttemptSession(options: {
  sessionDir: string;
  manifest: SessionManifest | null;
  attemptSessionId: string;
}): Promise<string> {
  if (options.manifest) {
    await copyDirectoryContents(
      path.dirname(options.attemptSessionId),
      path.dirname(options.manifest.subagent_session_id),
    );
    return options.manifest.subagent_session_id;
  }

  const canonicalPiSessionDir = path.join(options.sessionDir, "pi-session");
  await copyDirectoryContents(path.dirname(options.attemptSessionId), canonicalPiSessionDir);
  return path.join(canonicalPiSessionDir, path.basename(options.attemptSessionId));
}

export async function runSubagentSession(
  request: RunSubagentSessionRequest,
  options: { sessionsDir?: string; heartbeat?: HeartbeatNotify; heartbeatIntervalMs?: number } = {},
): Promise<RunSubagentSessionResult> {
  assertNoRawSessionId(request);
  const config = await loadConfig();
  const sessionKey = validateSessionKey(request.session_key);
  const resumeMode = validateResumeMode(request.resume_mode);
  const packetPolicy = validateSessionPacketPolicy(request.packet_policy);
  const resolvedBase = await validateAndResolveRequest(request, config);
  const cwd = await fs.realpath(resolvedBase.cwd);
  const resolved = {
    ...resolvedBase,
    cwd,
    prompt:
      packetPolicy === "none"
        ? resolvedBase.prompt
        : appendContractPacketInstruction(resolvedBase.prompt),
  };

  const sessionsDir = options.sessionsDir ?? defaultSessionsDir();
  const sessionDir = sessionDirFor(sessionsDir, cwd, sessionKey);
  const manifestPath = path.join(sessionDir, "manifest.json");
  const ledgerPath = path.join(sessionDir, "ledger.jsonl");
  const attemptsPath = path.join(sessionDir, "attempts.jsonl");
  const lockPath = path.join(sessionDir, "run.lock");
  await fs.mkdir(sessionDir, { recursive: true });
  const releaseLock = await acquireLock(lockPath);

  try {
    let manifest = await readManifest(manifestPath);
    if (manifest) {
      manifest = await reconcileManifestWithLedger(manifest, manifestPath, ledgerPath);
    }
    assertNewSessionAllowed(manifest, resumeMode, sessionKey);
    assertExistingSession(manifest, resumeMode, sessionKey);
    if (manifest) {
      assertManifestCompatible(manifest, cwd, resolved.skill);
    }

    const action = manifest ? "resumed" : "created";
    const startedAt = new Date().toISOString();
    const sequence = (manifest?.run_count ?? 0) + 1;
    const runId = `${String(sequence).padStart(4, "0")}-${randomBytes(6).toString("hex")}`;
    const attemptSession = await prepareAttemptSession(sessionDir, runId, manifest);
    const runResult = await runSubagent(sessionRunRequest(resolved, attemptSession.runManifest), {
      runId,
      runsDir: path.join(sessionDir, "runs"),
      suppressFailureLog: true,
      allowTimeout: true,
      piSessionDir: attemptSession.attemptPiSessionDir,
      heartbeat: options.heartbeat,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
    });
    const outputText = await fs.readFile(runResult.output_path, "utf8");
    const attemptSubagentSessionId = attemptSession.runManifest?.subagent_session_id ?? runResult.session_id;
    const attemptSessionEstablished = attemptSubagentSessionId !== null;
    const packet =
      packetPolicy === "none"
        ? {
            packetPath: null,
            packetParseStatus: "not_run" as const,
            claimedPacket: null,
          }
        : await writePacket(sessionDir, runId, outputText);
    const processSuccess = runResult.success;
    const missingSessionIdError = attemptSubagentSessionId
      ? undefined
      : "Pi did not report a persisted session file";
    const success =
      processSuccess &&
      attemptSessionEstablished &&
      packetSatisfied(packetPolicy, packet.packetParseStatus, packet.claimedPacket);
    const committedSubagentSessionId = success && attemptSubagentSessionId
      ? await promoteAttemptSession({
          sessionDir,
          manifest,
          attemptSessionId: attemptSubagentSessionId,
        })
      : manifest?.subagent_session_id ?? null;
    const finishedAt = new Date().toISOString();
    const runRecord: SessionRunRecord = {
      run_id: runId,
      sequence,
      started_at: startedAt,
      finished_at: finishedAt,
      action: success ? action : "not_created",
      subagent_session_id: success ? committedSubagentSessionId : manifest?.subagent_session_id ?? null,
      attempt_subagent_session_id: attemptSubagentSessionId,
      attempt_session_established: attemptSessionEstablished,
      resume_mode: resumeMode,
      output_path: runResult.output_path,
      packet_path: packet.packetPath,
      packet_policy: packetPolicy,
      packet_parse_status: packet.packetParseStatus,
      packet_error: packet.packetError,
      success,
      exit_code: runResult.exit_code,
      timed_out: runResult.timed_out,
      partial_output_available: runResult.partial_output_available,
      resume_possible: runResult.resume_possible,
      duration_ms: runResult.duration_ms,
      requested_timeout_ms: runResult.requested_timeout_ms,
      resolved_timeout_ms: runResult.resolved_timeout_ms,
      timeout_floor_ms: runResult.timeout_floor_ms,
      effective_timeout_ms: runResult.effective_timeout_ms,
      timeout_headroom_ms: runResult.timeout_headroom_ms,
      kill_grace_ms: runResult.kill_grace_ms,
      force_grace_ms: runResult.force_grace_ms,
      resolved_model_class: runResult.resolved_model_class,
      resolved_model: runResult.resolved_model,
      resolved_thinking_level: runResult.resolved_thinking_level,
      requested_skill: runResult.requested_skill,
      requested_output_mode: runResult.requested_output_mode,
      written_output_mode: runResult.written_output_mode,
      resolved_tool_profile: runResult.resolved_tool_profile,
      stop_reason: runResult.stop_reason,
      error: missingSessionIdError,
    };
    if (success && committedSubagentSessionId) {
      const nextManifest: SessionManifest = {
        schema_version: 1,
        session_key: sessionKey,
        cwd,
        skill: resolved.skill ?? null,
        initial_model: manifest?.initial_model ?? resolved.model,
        initial_thinking_level: manifest?.initial_thinking_level ?? resolved.thinkingLevel,
        initial_model_class: manifest?.initial_model_class ?? resolved.modelClass,
        subagent_session_id: committedSubagentSessionId,
        created_at: manifest?.created_at ?? startedAt,
        last_run_at: finishedAt,
        run_count: runRecord.sequence,
        last_output_path: runResult.output_path,
        status: "active",
      };
      await fs.appendFile(ledgerPath, `${JSON.stringify(runRecord)}\n`, "utf8");
      await writeManifestAtomic(manifestPath, nextManifest);
    } else {
      await fs.appendFile(attemptsPath, `${JSON.stringify(runRecord)}\n`, "utf8");
    }

    const result: RunSubagentSessionResult = {
      output_path: runResult.output_path,
      success,
      exit_code: runResult.exit_code,
      timed_out: runResult.timed_out,
      partial_output_available: runResult.partial_output_available,
      resume_possible: runResult.resume_possible,
      duration_ms: runResult.duration_ms,
      requested_timeout_ms: runResult.requested_timeout_ms,
      resolved_timeout_ms: runResult.resolved_timeout_ms,
      timeout_floor_ms: runResult.timeout_floor_ms,
      effective_timeout_ms: runResult.effective_timeout_ms,
      timeout_headroom_ms: runResult.timeout_headroom_ms,
      kill_grace_ms: runResult.kill_grace_ms,
      force_grace_ms: runResult.force_grace_ms,
      size_bytes: runResult.size_bytes,
      resolved_model_class: runResult.resolved_model_class,
      resolved_model: runResult.resolved_model,
      resolved_thinking_level: runResult.resolved_thinking_level,
      requested_skill: runResult.requested_skill,
      requested_output_mode: runResult.requested_output_mode,
      written_output_mode: runResult.written_output_mode,
      resolved_tool_profile: runResult.resolved_tool_profile,
      stop_reason: runResult.stop_reason,
      session_key: sessionKey,
      session_dir: sessionDir,
      manifest_path: manifestPath,
      ledger_path: ledgerPath,
      attempts_path: attemptsPath,
      subagent_session_id: committedSubagentSessionId,
      attempt_subagent_session_id: attemptSubagentSessionId,
      attempt_session_established: attemptSessionEstablished,
      session_established: committedSubagentSessionId !== null,
      created_or_resumed: success ? action : "not_created",
      resume_mode: resumeMode,
      requested_packet_policy: packetPolicy,
      packet_path: packet.packetPath,
      packet_parse_status: packet.packetParseStatus,
      packet_error: packet.packetError,
      claimed_packet: packet.claimedPacket,
      run_record: runRecord,
      model_changed_from_manifest: Boolean(
        manifest &&
          (manifest.initial_model_class
            ? manifest.initial_model_class !== resolved.modelClass
            : modelRefForComparison(manifest.initial_model) !== resolved.model),
      ),
      thinking_level_changed_from_manifest: Boolean(
        manifest && manifest.initial_thinking_level !== resolved.thinkingLevel,
      ),
    };
    if (!result.success && result.run_record.stop_reason !== "cancelled") {
      const isPacketSatisfied = packetSatisfied(
        packetPolicy,
        result.packet_parse_status,
        result.claimed_packet,
      );
      await logFailure({
        tool: "run_subagent_session",
        failure_class: failureClassForSessionResult(
          { ...result, session_established: attemptSessionEstablished },
          isPacketSatisfied,
        ),
        reason_code: failureReasonCodeForSessionResult(
          { ...result, session_established: attemptSessionEstablished },
          isPacketSatisfied,
        ),
        cwd,
        output_path: result.output_path,
        session_key: result.session_key,
        session_dir: result.session_dir,
        success: result.success,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        partial_output_available: result.partial_output_available,
        resume_possible: result.resume_possible,
        duration_ms: result.duration_ms,
        requested_timeout_ms: result.requested_timeout_ms,
        resolved_timeout_ms: result.resolved_timeout_ms,
        timeout_floor_ms: result.timeout_floor_ms,
        effective_timeout_ms: result.effective_timeout_ms,
        timeout_headroom_ms: result.timeout_headroom_ms,
        kill_grace_ms: result.kill_grace_ms,
        force_grace_ms: result.force_grace_ms,
        model_class: result.resolved_model_class,
        model: result.resolved_model,
        thinking_level: result.resolved_thinking_level,
        skill: result.requested_skill,
        output_mode: result.requested_output_mode,
        tool_profile: result.resolved_tool_profile,
      });
    }
    return result;
  } finally {
    await releaseLock();
  }
}
