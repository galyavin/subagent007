import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  MODEL_CLASSES,
  EFFECT_PROFILES,
  OUTPUT_MODES,
  RECURSIVE_EDGE_WITNESSES,
  RUN_CONTINUITY_MODES,
  type ModelClass,
  type OutputMode,
  type FailureReasonCode,
  type ResolvedRunSubagentRequest,
  type RunContinuity,
  type RunSubagentRequest,
  type RunnerConfig,
} from "./types.js";
import { DEFAULT_MODEL_CLASS, resolveModelClass } from "./modelAllowlist.js";
import { minimumRequestedTimeoutMs } from "./timeoutBudget.js";
import { ValidationError } from "./types.js";
import { resolveSkillBinding, validateSkillName } from "./skillBinding.js";
import { boundedEffectProfileSkill, isBoundedEffectProfile } from "./toolProfile.js";
import {
  isEffectScopedAuthoringProfile,
  normalizeAllowedOutputPaths,
} from "./authoringEffectScope.js";

export { validateSkillName } from "./skillBinding.js";

function validationReasonCodeForKey(key: string): FailureReasonCode {
  switch (key) {
    case "model_class":
      return "invalid_model_class";
    case "output_mode":
      return "invalid_output_mode";
    case "effect_profile":
      return "invalid_effect_profile";
    case "allowed_output_paths":
      return "authoring_effect_scope_invalid";
    case "recursive_edge_witness":
      return "recursive_control_invalid";
    case "expected_skill_sha256":
      return "invalid_expected_skill_sha256";
    case "skill_name":
    case "system_skill_name":
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
  const rawRequest = request as unknown as Record<string, unknown>;
  if (Object.hasOwn(rawRequest, "skill")) {
    throw new ValidationError("skill is not a supported input; use skill_name", "invalid_skill");
  }
  if (Object.hasOwn(rawRequest, "tool_profile")) {
    throw new ValidationError("tool_profile is not a supported input", "unknown_validation_error");
  }
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

  const effectProfile = validateChoice(request.effect_profile, "effect_profile", EFFECT_PROFILES);
  const recursiveDelegation = request.recursive_delegation ?? "disabled";
  const recursiveEdgeWitness = validateChoice(
    request.recursive_edge_witness,
    "recursive_edge_witness",
    RECURSIVE_EDGE_WITNESSES,
  );
  if (recursiveEdgeWitness && recursiveDelegation !== "enabled") {
    throw new ValidationError(
      "recursive_edge_witness requires recursive_delegation enabled",
      "recursive_control_invalid",
    );
  }
  if (isBoundedEffectProfile(effectProfile)) {
    const requiredSkill = boundedEffectProfileSkill(effectProfile);
    if (request.skill_name !== requiredSkill) {
      throw new ValidationError(
        `${effectProfile} requires exact canonical skill_name ${JSON.stringify(requiredSkill)}`,
        "invalid_skill",
      );
    }
    if (request.continuity?.mode === "resume") {
      throw new ValidationError(
        `${effectProfile} supports only ephemeral and fresh continuity; resume is not supported`,
        "effect_profile_unsupported",
      );
    }
    if (request.skill_snapshot_binding === undefined || request.skill_snapshot_binding === null || typeof request.skill_snapshot_binding !== "object") {
      throw new ValidationError(
        `${effectProfile} requires an immutable skill_snapshot_binding with a complete runtime-bundle digest`,
        "invalid_skill_snapshot_binding",
      );
    }
    if (request.expected_skill_sha256 !== undefined) {
      throw new ValidationError(
        `${effectProfile} requires skill_snapshot_binding instead of expected_skill_sha256`,
        "invalid_skill_snapshot_binding",
      );
    }
  }
  if (request.continuity?.mode === "resume" && request.recursive_delegation === undefined) {
    throw new ValidationError("raw resume requires explicit recursive_delegation reauthorization", "recursive_delegation_reauthorization_required");
  }
  if (effectProfile && recursiveDelegation === "enabled") {
    throw new ValidationError(`${effectProfile} excludes recursive delegation`, "recursive_delegation_effect_conflict");
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

  const skill = resolveSkillBinding(request, prompt);
  const systemSkill = validateSkillName(request.system_skill_name, "system_skill_name");
  if (systemSkill && systemSkill === skill) {
    throw new ValidationError(
      "system_skill_name must differ from skill_name so the governing body is not duplicated as a specialist invocation",
      "invalid_skill",
    );
  }
  if (systemSkill && effectProfile) {
    throw new ValidationError(
      "system_skill_name preserves ambient tools and is not supported with an effect_profile",
      "effect_profile_unsupported",
    );
  }

  const taskRoot = isEffectScopedAuthoringProfile(effectProfile) ? await fs.realpath(cwd) : cwd;
  const allowedOutputPaths = normalizeAllowedOutputPaths(
    request.allowed_output_paths,
    taskRoot,
    effectProfile,
  );
  return {
    prompt,
    cwd: taskRoot,
    modelClass,
    model: resolvedModelClass.model,
    thinkingLevel: resolvedModelClass.thinkingLevel,
    timeoutMs,
    continuity,
    skill,
    systemSkill,
    effectProfile,
    recursiveDelegation,
    requestedRecursiveDelegation: request.recursive_delegation ?? null,
    ...(allowedOutputPaths ? { allowedOutputPaths } : {}),
    expectedSkillSha256,
    skillSnapshotBinding,
    outputMode: validateOutputMode(request.output_mode),
  };
}
