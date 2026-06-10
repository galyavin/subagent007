import fs from "node:fs/promises";
import path from "node:path";
import {
  OUTPUT_MODES,
  RUN_CONTINUITY_MODES,
  THINKING_LEVELS,
  type OutputMode,
  type ResolvedRunSubagentRequest,
  type RunContinuity,
  type RunSubagentRequest,
  type RunnerConfig,
  type ThinkingLevel,
} from "./types.js";
import { resolveAllowedModelRef } from "./modelAllowlist.js";
import { ValidationError } from "./types.js";

const SKILL_NAME_ERROR =
  "skill must be a bare skill name such as pda-lite or plugin:skill-name; pass pda-lite, not $pda-lite, a path, markdown link, or prose";

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

export function validateSkillName(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ValidationError("skill must be a string");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)?$/.test(value)) {
    throw new ValidationError(SKILL_NAME_ERROR);
  }
  return value;
}

function validateThinkingLevel(value: unknown, key: string): ThinkingLevel | undefined {
  const level = trimOptional(value, key);
  if (level === undefined) {
    return undefined;
  }
  if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
    throw new ValidationError(`${key} must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  return level as ThinkingLevel;
}

function validateOutputMode(value: unknown): OutputMode {
  const mode = trimOptional(value, "output_mode") ?? "final";
  if (!OUTPUT_MODES.includes(mode as OutputMode)) {
    throw new ValidationError(`output_mode must be one of: ${OUTPUT_MODES.join(", ")}`);
  }
  return mode as OutputMode;
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
    return { mode, session_id: rawSessionId };
  }
  if (rawSessionId !== undefined) {
    throw new ValidationError(
      "continuity.session_id is only valid when continuity.mode is resume",
    );
  }
  return { mode: mode as "ephemeral" | "fresh" };
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

  const model = trimOptional(request.model, "model") ?? config.default_model;
  if (!model) {
    throw new ValidationError("model was omitted and default_model is not configured");
  }
  const resolvedModel = resolveAllowedModelRef(model);
  const thinkingLevel =
    validateThinkingLevel(request.thinking_level, "thinking_level") ?? config.default_thinking_level;
  if (!thinkingLevel) {
    throw new ValidationError(
      "thinking_level was omitted and default_thinking_level is not configured",
    );
  }

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
    timeoutMs = request.timeout_ms;
  }

  return {
    prompt,
    cwd,
    model: resolvedModel,
    thinkingLevel,
    timeoutMs,
    continuity: validateContinuity(request.continuity, request),
    skill: validateSkillName(request.skill),
    outputMode: validateOutputMode(request.output_mode),
  };
}
