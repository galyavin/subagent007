import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  MODEL_CLASSES,
  EFFECT_PROFILES,
  OUTPUT_MODES,
  RUN_CONTINUITY_MODES,
  TOOL_PROFILES,
  type ModelClass,
  type OutputMode,
  type FailureReasonCode,
  type ResolvedRunSubagentRequest,
  type RunContinuity,
  type RunSubagentPromotionReasonCode,
  type RunSubagentRequest,
  type RunnerConfig,
} from "./types.js";
import { DEFAULT_MODEL_CLASS, resolveModelClass } from "./modelAllowlist.js";
import { minimumRequestedTimeoutMs } from "./timeoutBudget.js";
import { ValidationError } from "./types.js";
import { safeIntegerFromEnv } from "./env.js";
import { resolveSkillBinding } from "./skillBinding.js";

export { validateSkillName } from "./skillBinding.js";
const ONE_SHOT_MAX_PROMPT_CHARS = 6000;
const BROAD_WORK_OBJECTS =
  String.raw`(?:docs?|repo|diff|artifact|architecture|doctrine|charts?|implementation|requirements?|correctness|changes?|patch|repair|delta|residual)`;
const STRONG_BROAD_WORK_PATTERNS = [
  /\bhighest-order root cause\b/i,
  /\bsupreme atomic fix\b/i,
  /\bcampaign\b/i,
  /\bobserved real use trials?\b/i,
  /\bimplementation plan\b/i,
  /\breview the repo\b/i,
  /\bartifact verification\b/i,
  /\bverification scan\b/i,
  new RegExp(String.raw`\bverif(?:y|ication)\b.*\b${BROAD_WORK_OBJECTS}\b`, "i"),
  /\bfresh-?eye\b/i,
  /\bfollow-?up scan\b/i,
  new RegExp(String.raw`\breview\b.*\b${BROAD_WORK_OBJECTS}\b`, "i"),
  /\b(inspect|audit)\b.*\b(diff|repo|implementation|repair|delta)\b/i,
  new RegExp(String.raw`\bscan\b.*\b${BROAD_WORK_OBJECTS}\b`, "i"),
  /\baudit\b/i,
  /\bsynthesize\b/i,
  /\binvestigate\b/i,
  /\bstress-?test\b/i,
];
const ONE_SHOT_BROAD_WORK_PATTERNS = [
  /\bHORCs?\b/i,
  /\bSAFs?\b/i,
  ...STRONG_BROAD_WORK_PATTERNS,
];
const DEADLINE_RISK_BROAD_WORK_PATTERNS = STRONG_BROAD_WORK_PATTERNS;
const REVIEW_ACTION_PATTERN = /\b(?:verif(?:y|ication)|review|scan)\b/i;
const CORE_REVIEW_OBJECT_PATTERN = /\b(?:implementation|requirements?|correctness)\b/i;
const ONE_SHOT_WRITE_WORK_PATTERNS = [
  /\bimplement\b/i,
  /\brepair\b/i,
  /\bmodify\b/i,
  /\bwrite\b/i,
  /\bedit\b/i,
  /\brefactor\b/i,
  /\bfix\b/i,
];
const DEFAULT_DEADLINE_RISK_TIMEOUT_FLOOR_MS = 600_000;
const DEADLINE_RISK_TIMEOUT_FLOOR_ENV = "SUBAGENT007_DEADLINE_RISK_TIMEOUT_FLOOR_MS";

function validationReasonCodeForKey(key: string): FailureReasonCode {
  switch (key) {
    case "model_class":
      return "invalid_model_class";
    case "output_mode":
      return "invalid_output_mode";
    case "tool_profile":
      return "invalid_tool_profile";
    case "effect_profile":
      return "invalid_effect_profile";
    case "expected_skill_sha256":
      return "invalid_expected_skill_sha256";
    case "skill":
    case "skill_name":
      return "invalid_skill";
    case "continuity.mode":
    case "continuity.session_id":
      return "invalid_session_id";
    case "prompt":
      return "prompt_missing";
    case "cwd":
      return "cwd_not_absolute";
    case "timeout_ms":
      return "invalid_timeout_ms";
    default:
      return "unknown_validation_error";
  }
}

function promptForClassification(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

function promptHasCoreReviewActionAndObject(prompt: string): boolean {
  return REVIEW_ACTION_PATTERN.test(prompt) && CORE_REVIEW_OBJECT_PATTERN.test(prompt);
}

export interface RunSubagentOneShotIncompatibility {
  reason_code: RunSubagentPromotionReasonCode;
  message: string;
  safe_to_promote: true;
}

function workloadIncompatibility(
  resolved: ResolvedRunSubagentRequest,
  broadWorkPatterns: readonly RegExp[],
): RunSubagentOneShotIncompatibility | null {
  const prompt = promptForClassification(resolved.prompt);
  if (resolved.skill) {
    return {
      reason_code: "skill_bound",
      message: "skill-bound work needs a durable, pollable run",
      safe_to_promote: true,
    };
  }
  if (resolved.prompt.length > ONE_SHOT_MAX_PROMPT_CHARS) {
    return {
      reason_code: "prompt_too_long",
      message: `prompt exceeds ${ONE_SHOT_MAX_PROMPT_CHARS} characters`,
      safe_to_promote: true,
    };
  }
  if (
    promptHasCoreReviewActionAndObject(prompt) ||
    broadWorkPatterns.some((pattern) => pattern.test(prompt))
  ) {
    return {
      reason_code: "broad_work",
      message: "prompt asks for broad, exploratory, or synthesis work",
      safe_to_promote: true,
    };
  }
  if (ONE_SHOT_WRITE_WORK_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return {
      reason_code: "workspace_write",
      message: "write-capable work should be durable and cancellable",
      safe_to_promote: true,
    };
  }
  return null;
}

function trimOptional(value: unknown, key: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ValidationError(`${key} must be a string`, validationReasonCodeForKey(key));
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function validateChoice<T extends string>(
  value: unknown,
  key: string,
  choices: readonly T[],
  defaultValue?: T,
): T | undefined {
  const choice = trimOptional(value, key) ?? defaultValue;
  if (choice === undefined) {
    return undefined;
  }
  if (!choices.includes(choice as T)) {
    throw new ValidationError(`${key} must be one of: ${choices.join(", ")}`, validationReasonCodeForKey(key));
  }
  return choice as T;
}

function validateModelClass(value: unknown): ModelClass | undefined {
  return validateChoice(value, "model_class", MODEL_CLASSES);
}

function validateOutputMode(value: unknown): OutputMode {
  return validateChoice(value, "output_mode", OUTPUT_MODES, "final") as OutputMode;
}

function validateContinuity(value: unknown, request: unknown): RunContinuity {
  if (
    typeof request === "object" &&
    request !== null &&
    "session_id" in request
  ) {
    throw new ValidationError(
      "session_id is not a run_subagent input; use continuity.mode fresh or continuity.mode resume with continuity.session_id",
      "invalid_session_id",
    );
  }
  if (value === undefined) {
    return { mode: "ephemeral" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("continuity must be an object when provided", "invalid_session_id");
  }
  const continuity = value as Record<string, unknown>;
  const mode = validateChoice(continuity.mode, "continuity.mode", RUN_CONTINUITY_MODES);
  if (!mode) {
    throw new ValidationError(
      `continuity.mode must be one of: ${RUN_CONTINUITY_MODES.join(", ")}`,
      "invalid_session_id",
    );
  }
  const rawSessionId = trimOptional(continuity.session_id, "continuity.session_id");
  if (mode === "resume") {
    if (!rawSessionId) {
      throw new ValidationError("continuity.session_id is required when continuity.mode is resume", "invalid_session_id");
    }
    if (!path.isAbsolute(rawSessionId)) {
      throw new ValidationError("continuity.session_id must be an absolute path when continuity.mode is resume", "invalid_session_id");
    }
    return { mode, session_id: rawSessionId };
  }
  if (rawSessionId !== undefined) {
    throw new ValidationError(
      "continuity.session_id is only valid when continuity.mode is resume",
      "invalid_session_id",
    );
  }
  return { mode };
}

async function validateResumeSessionFile(continuity: RunContinuity): Promise<void> {
  if (continuity.mode !== "resume") {
    return;
  }

  let stat;
  try {
    stat = await fs.stat(continuity.session_id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ValidationError(`resume session file does not exist: ${continuity.session_id}`, "invalid_session_id");
    }
    throw new ValidationError(
      `resume session file is not accessible: ${continuity.session_id}: ${(error as Error).message}`,
      "invalid_session_id",
    );
  }
  if (!stat.isFile()) {
    throw new ValidationError(`resume session path is not a file: ${continuity.session_id}`, "invalid_session_id");
  }
  if (stat.size === 0) {
    throw new ValidationError(`resume session file is empty: ${continuity.session_id}`, "invalid_session_id");
  }
  try {
    await fs.access(continuity.session_id, fsConstants.R_OK);
  } catch (error) {
    throw new ValidationError(
      `resume session file is not readable: ${continuity.session_id}: ${(error as Error).message}`,
      "invalid_session_id",
    );
  }
}

export async function validateCwd(value: unknown): Promise<string> {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError("cwd must be a nonempty absolute path", "cwd_not_absolute");
  }
  const cwd = value.trim();
  if (!path.isAbsolute(cwd)) {
    throw new ValidationError("cwd must be an absolute path", "cwd_not_absolute");
  }
  let stat;
  try {
    stat = await fs.stat(cwd);
  } catch (error) {
    throw new ValidationError(`cwd is not accessible: ${(error as Error).message}`, "cwd_inaccessible");
  }
  if (!stat.isDirectory()) {
    throw new ValidationError("cwd must be a directory", "cwd_not_directory");
  }
  return cwd;
}

export async function validateAndResolveRequest(
  request: RunSubagentRequest,
  config: RunnerConfig,
): Promise<ResolvedRunSubagentRequest> {
  const prompt = trimOptional(request.prompt, "prompt");
  if (!prompt) {
    throw new ValidationError("prompt must be a nonempty string", "prompt_missing");
  }

  const cwd = await validateCwd(request.cwd);

  if ("model" in request) {
    throw new ValidationError("model is no longer a public input; use model_class", "invalid_model");
  }
  if ("thinking_level" in request) {
    throw new ValidationError(
      "thinking_level is calibrated by model_class and is no longer a public input",
      "invalid_thinking_level",
    );
  }
  const modelClass = validateModelClass(request.model_class) ?? config.default_model_class ?? DEFAULT_MODEL_CLASS;
  const resolvedModelClass = resolveModelClass(modelClass);

  let timeoutMs: number | undefined;
  if (request.timeout_ms !== undefined) {
    if (
      typeof request.timeout_ms !== "number" ||
      !Number.isFinite(request.timeout_ms) ||
      request.timeout_ms <= 0 ||
      !Number.isInteger(request.timeout_ms)
    ) {
      throw new ValidationError("timeout_ms must be a positive integer when provided", "invalid_timeout_ms");
    }
    const minTimeoutMs = minimumRequestedTimeoutMs();
    if (request.timeout_ms < minTimeoutMs) {
      throw new ValidationError(
        `timeout_ms must be at least ${minTimeoutMs} ms with the configured response headroom and kill grace`,
        "invalid_timeout_ms",
      );
    }
    timeoutMs = request.timeout_ms;
  }

  const continuity = validateContinuity(request.continuity, request);
  await validateResumeSessionFile(continuity);

  validateChoice(request.tool_profile, "tool_profile", TOOL_PROFILES);
  const effectProfile = validateChoice(request.effect_profile, "effect_profile", EFFECT_PROFILES);
  const recursiveDelegation = request.recursive_delegation ?? "disabled";
  if (request.continuity?.mode === "resume" && request.recursive_delegation === undefined) {
    throw new ValidationError("raw resume requires explicit recursive_delegation reauthorization", "recursive_delegation_reauthorization_required");
  }
  if (effectProfile === "workspace_read_only" && recursiveDelegation === "enabled") {
    throw new ValidationError("workspace_read_only excludes recursive delegation", "recursive_delegation_effect_conflict");
  }
  const expectedSkillSha256 = trimOptional(request.expected_skill_sha256, "expected_skill_sha256");
  const skillSnapshotBinding = request.skill_snapshot_binding;
  if (skillSnapshotBinding !== undefined) {
    if (typeof request.skill_name !== "string" || request.skill_name.trim() === "") {
      throw new ValidationError("skill_snapshot_binding requires canonical skill_name", "invalid_skill_snapshot_binding");
    }
    if (expectedSkillSha256 !== undefined) {
      throw new ValidationError("skill_snapshot_binding and expected_skill_sha256 are mutually exclusive", "invalid_skill_snapshot_binding");
    }
  }
  if (expectedSkillSha256 !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(expectedSkillSha256)) {
      throw new ValidationError(
        "expected_skill_sha256 must be a lowercase 64-character SHA-256 hex digest",
        "invalid_expected_skill_sha256",
      );
    }
    if (typeof request.skill_name !== "string" || request.skill_name.trim() === "") {
      throw new ValidationError(
        "expected_skill_sha256 requires canonical skill_name",
        "invalid_expected_skill_sha256",
      );
    }
  }

  return {
    prompt,
    cwd,
    modelClass,
    model: resolvedModelClass.model,
    thinkingLevel: resolvedModelClass.thinkingLevel,
    timeoutMs,
    continuity,
    skill: resolveSkillBinding(request, prompt),
    effectProfile,
    recursiveDelegation,
    requestedRecursiveDelegation: request.recursive_delegation ?? null,
    expectedSkillSha256,
    skillSnapshotBinding,
    outputMode: validateOutputMode(request.output_mode),
  };
}

export function runSubagentOneShotIncompatibility(
  _request: RunSubagentRequest,
  resolved: ResolvedRunSubagentRequest,
): RunSubagentOneShotIncompatibility | null {
  return workloadIncompatibility(resolved, ONE_SHOT_BROAD_WORK_PATTERNS);
}

export function deadlineRiskForRun(
  _request: RunSubagentRequest,
  resolved: ResolvedRunSubagentRequest,
): RunSubagentOneShotIncompatibility | null {
  return workloadIncompatibility(resolved, DEADLINE_RISK_BROAD_WORK_PATTERNS);
}

export function deadlineRiskTimeoutFloorMs(): number {
  return Math.max(
    minimumRequestedTimeoutMs(),
    safeIntegerFromEnv(
      DEADLINE_RISK_TIMEOUT_FLOOR_ENV,
      DEFAULT_DEADLINE_RISK_TIMEOUT_FLOOR_MS,
      0,
    ),
  );
}

export function assertDeadlineRiskTimeoutBudget(
  request: RunSubagentRequest,
  resolved: ResolvedRunSubagentRequest,
  toolName: "start_run" | "schedule_run" | "start_session_run" | "run_subagent_session",
): void {
  if (resolved.timeoutMs === undefined) {
    return;
  }
  const deadlineRisk = deadlineRiskForRun(request, resolved);
  if (!deadlineRisk) {
    return;
  }
  const floorMs = deadlineRiskTimeoutFloorMs();
  if (resolved.timeoutMs >= floorMs) {
    return;
  }
  throw new ValidationError(
    [
      "timeout_ms under budget for deadline-risk workload",
      `tool=${toolName}`,
      `reason=${deadlineRisk.reason_code}`,
      `requested_timeout_ms=${resolved.timeoutMs}`,
      `minimum_timeout_ms=${floorMs}`,
      "use wait_ms for the initial scheduler wait, omit timeout_ms for long durable work, or set timeout_ms to at least the minimum",
    ].join("; "),
    "timeout_underbudget_for_deadline_risk",
  );
}
