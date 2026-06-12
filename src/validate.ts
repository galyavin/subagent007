import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  MODEL_CLASSES,
  OUTPUT_MODES,
  RUN_CONTINUITY_MODES,
  TOOL_PROFILES,
  type ModelClass,
  type OutputMode,
  type ResolvedRunSubagentRequest,
  type RunContinuity,
  type RunSubagentRequest,
  type RunnerConfig,
  type ToolProfile,
} from "./types.js";
import { DEFAULT_MODEL_CLASS, resolveModelClass } from "./modelAllowlist.js";
import { minimumRequestedTimeoutMs } from "./timeoutBudget.js";
import { ValidationError } from "./types.js";

const SKILL_NAME_ERROR =
  "skill must be a bare skill name such as pda-lite or plugin:skill-name; pass pda-lite, not $pda-lite, /skill:pda-lite, a path, markdown link, or prose";
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)?$/;
const PROMPT_SKILL_INVOCATION_PATTERNS = [
  /^\/skill:[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)?(?:\b|\s|$)/,
  /^\$[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)?(?:\b|\s|$)/,
  /^\[\$[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)?\]\([^)]+\)/,
  /^(?:use|run|invoke)\s+\$[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)?(?:\b|\s|$)/i,
];
const ONE_SHOT_MAX_PROMPT_CHARS = 6000;
const ONE_SHOT_BROAD_WORK_PATTERNS = [
  /\bHORCs?\b/i,
  /\bSAFs?\b/i,
  /\bhighest-order root cause\b/i,
  /\bsupreme atomic fix\b/i,
  /\bcampaign\b/i,
  /\bobserved real use trials?\b/i,
  /\bimplementation plan\b/i,
  /\breview the repo\b/i,
  /\baudit\b/i,
  /\bsynthesize\b/i,
  /\binvestigate\b/i,
  /\bstress-?test\b/i,
];
const ONE_SHOT_WRITE_WORK_PATTERNS = [
  /\bimplement\b/i,
  /\brepair\b/i,
  /\bmodify\b/i,
  /\bwrite\b/i,
  /\bedit\b/i,
  /\brefactor\b/i,
  /\bfix\b/i,
];
const ONE_SHOT_GUIDANCE =
  "This request is incompatible with run_subagent's quick_noninteractive contract; use schedule_run or start_run with explicit timeout_ms for broad, exploratory, skill-bound, cancellable, polling, or long-running work.";

function trimOptional(value: unknown, key: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ValidationError(`${key} must be a string`);
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
    throw new ValidationError(`${key} must be one of: ${choices.join(", ")}`);
  }
  return choice as T;
}

export function validateSkillName(value: unknown, key = "skill"): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ValidationError(`${key} must be a string or null`);
  }
  if (!SKILL_NAME_PATTERN.test(value)) {
    throw new ValidationError(SKILL_NAME_ERROR);
  }
  return value;
}

function assertNoUnstructuredSkillInvocation(prompt: string, resolvedSkill: string | undefined): void {
  if (resolvedSkill) {
    return;
  }
  const firstLine = prompt.trimStart().split(/\r?\n/, 1)[0]?.trimEnd() ?? "";
  if (PROMPT_SKILL_INVOCATION_PATTERNS.some((pattern) => pattern.test(firstLine))) {
    throw new ValidationError(
      "Pass skill_name instead of putting skill invocation syntax in prompt.",
    );
  }
}

function resolveSkillName(request: RunSubagentRequest, prompt: string): string | undefined {
  const legacySkill = validateSkillName(request.skill, "skill");
  const canonicalSkill = validateSkillName(request.skill_name, "skill_name");
  if (legacySkill && canonicalSkill && legacySkill !== canonicalSkill) {
    throw new ValidationError("skill and skill_name must match when both are provided");
  }
  const resolvedSkill = canonicalSkill ?? legacySkill;
  assertNoUnstructuredSkillInvocation(prompt, resolvedSkill);
  return resolvedSkill;
}

function validateModelClass(value: unknown): ModelClass | undefined {
  return validateChoice(value, "model_class", MODEL_CLASSES);
}

function validateOutputMode(value: unknown): OutputMode {
  return validateChoice(value, "output_mode", OUTPUT_MODES, "final") as OutputMode;
}

function validateToolProfile(value: unknown): ToolProfile {
  return validateChoice(value, "tool_profile", TOOL_PROFILES, "inspect") as ToolProfile;
}

function validateContinuity(value: unknown, request: unknown): RunContinuity {
  if (
    typeof request === "object" &&
    request !== null &&
    "session_id" in request
  ) {
    throw new ValidationError(
      "session_id is not a run_subagent input; use continuity.mode fresh or continuity.mode resume with continuity.session_id",
    );
  }
  if (value === undefined) {
    return { mode: "ephemeral" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("continuity must be an object when provided");
  }
  const continuity = value as Record<string, unknown>;
  const mode = trimOptional(continuity.mode, "continuity.mode");
  if (!mode || !RUN_CONTINUITY_MODES.includes(mode as RunContinuity["mode"])) {
    throw new ValidationError(
      `continuity.mode must be one of: ${RUN_CONTINUITY_MODES.join(", ")}`,
    );
  }
  const rawSessionId = trimOptional(continuity.session_id, "continuity.session_id");
  if (mode === "resume") {
    if (!rawSessionId) {
      throw new ValidationError("continuity.session_id is required when continuity.mode is resume");
    }
    if (!path.isAbsolute(rawSessionId)) {
      throw new ValidationError("continuity.session_id must be an absolute path when continuity.mode is resume");
    }
    return { mode, session_id: rawSessionId };
  }
  if (rawSessionId !== undefined) {
    throw new ValidationError(
      "continuity.session_id is only valid when continuity.mode is resume",
    );
  }
  return { mode: mode as "ephemeral" | "fresh" };
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
      throw new ValidationError(`resume session file does not exist: ${continuity.session_id}`);
    }
    throw new ValidationError(
      `resume session file is not accessible: ${continuity.session_id}: ${(error as Error).message}`,
    );
  }
  if (!stat.isFile()) {
    throw new ValidationError(`resume session path is not a file: ${continuity.session_id}`);
  }
  if (stat.size === 0) {
    throw new ValidationError(`resume session file is empty: ${continuity.session_id}`);
  }
  try {
    await fs.access(continuity.session_id, fsConstants.R_OK);
  } catch (error) {
    throw new ValidationError(
      `resume session file is not readable: ${continuity.session_id}: ${(error as Error).message}`,
    );
  }
}

export async function validateCwd(value: unknown): Promise<string> {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError("cwd must be a nonempty absolute path");
  }
  const cwd = value.trim();
  if (!path.isAbsolute(cwd)) {
    throw new ValidationError("cwd must be an absolute path");
  }
  let stat;
  try {
    stat = await fs.stat(cwd);
  } catch (error) {
    throw new ValidationError(`cwd is not accessible: ${(error as Error).message}`);
  }
  if (!stat.isDirectory()) {
    throw new ValidationError("cwd must be a directory");
  }
  return cwd;
}

export async function validateAndResolveRequest(
  request: RunSubagentRequest,
  config: RunnerConfig,
): Promise<ResolvedRunSubagentRequest> {
  const prompt = trimOptional(request.prompt, "prompt");
  if (!prompt) {
    throw new ValidationError("prompt must be a nonempty string");
  }

  const cwd = await validateCwd(request.cwd);

  if ("model" in request) {
    throw new ValidationError("model is no longer a public input; use model_class");
  }
  if ("thinking_level" in request) {
    throw new ValidationError("thinking_level is calibrated by model_class and is no longer a public input");
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
      throw new ValidationError("timeout_ms must be a positive integer when provided");
    }
    const minTimeoutMs = minimumRequestedTimeoutMs();
    if (request.timeout_ms < minTimeoutMs) {
      throw new ValidationError(
        `timeout_ms must be at least ${minTimeoutMs} ms with the configured response headroom and kill grace`,
      );
    }
    timeoutMs = request.timeout_ms;
  }

  const continuity = validateContinuity(request.continuity, request);
  await validateResumeSessionFile(continuity);

  return {
    prompt,
    cwd,
    modelClass,
    model: resolvedModelClass.model,
    thinkingLevel: resolvedModelClass.thinkingLevel,
    timeoutMs,
    continuity,
    skill: resolveSkillName(request, prompt),
    outputMode: validateOutputMode(request.output_mode),
    toolProfile: validateToolProfile(request.tool_profile),
  };
}

function oneShotIncompatibilityReason(
  request: RunSubagentRequest,
  resolved: ResolvedRunSubagentRequest,
): string | null {
  if (resolved.skill) {
    return "skill-bound work needs a durable, pollable run";
  }
  if (resolved.prompt.length > ONE_SHOT_MAX_PROMPT_CHARS) {
    return `prompt exceeds ${ONE_SHOT_MAX_PROMPT_CHARS} characters`;
  }
  if (ONE_SHOT_BROAD_WORK_PATTERNS.some((pattern) => pattern.test(resolved.prompt))) {
    return "prompt asks for broad, exploratory, or synthesis work";
  }
  if (
    request.tool_profile === "workspace_write" &&
    ONE_SHOT_WRITE_WORK_PATTERNS.some((pattern) => pattern.test(resolved.prompt))
  ) {
    return "workspace_write work should be durable and cancellable";
  }
  return null;
}

export function assertRunSubagentOneShotCompatible(
  request: RunSubagentRequest,
  resolved: ResolvedRunSubagentRequest,
): void {
  const reason = oneShotIncompatibilityReason(request, resolved);
  if (!reason) {
    return;
  }
  throw new ValidationError(`${ONE_SHOT_GUIDANCE} Reason: ${reason}.`);
}
