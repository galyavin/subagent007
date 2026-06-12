import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MODEL_CLASSES,
  THINKING_LEVELS,
  type ModelClass,
  type RunnerConfig,
  type ThinkingLevel,
} from "./types.js";
import { ValidationError } from "./types.js";
import { modelClassForResolvedPair } from "./modelAllowlist.js";

export function defaultConfigPath(): string {
  return process.env.SUBAGENT007_CONFIG_PATH
    ? path.resolve(process.env.SUBAGENT007_CONFIG_PATH)
    : path.join(os.homedir(), ".codex", "subagent007-pi", "config.json");
}

function nonEmptyString(value: unknown, key: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${key} must be a nonempty string when provided`);
  }
  return value.trim();
}

function legacyNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function legacyThinkingLevel(value: unknown): ThinkingLevel | undefined {
  const level = legacyNonEmptyString(value);
  return level && THINKING_LEVELS.includes(level as ThinkingLevel) ? level as ThinkingLevel : undefined;
}

function modelClass(value: unknown, key: string): ModelClass | undefined {
  const modelClassValue = nonEmptyString(value, key);
  if (modelClassValue === undefined) {
    return undefined;
  }
  if (!MODEL_CLASSES.includes(modelClassValue as ModelClass)) {
    throw new ValidationError(`${key} must be one of: ${MODEL_CLASSES.join(", ")}`);
  }
  return modelClassValue as ModelClass;
}

export function normalizeConfigRecord(record: Record<string, unknown>): RunnerConfig {
  const configuredModelClass = modelClass(record.default_model_class, "default_model_class");
  if (configuredModelClass !== undefined) {
    return { default_model_class: configuredModelClass };
  }

  const legacyDefaultModel = legacyNonEmptyString(record.default_model);
  const legacyDefaultThinkingLevel = legacyThinkingLevel(record.default_thinking_level);
  if (legacyDefaultModel !== undefined && legacyDefaultThinkingLevel !== undefined) {
    const migratedModelClass = modelClassForResolvedPair(legacyDefaultModel, legacyDefaultThinkingLevel);
    if (migratedModelClass !== null) {
      return { default_model_class: migratedModelClass };
    }
  }

  return {};
}

export async function loadConfigRecord(configPath = defaultConfigPath()): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new ValidationError(`failed to read config file ${configPath}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ValidationError(`config file ${configPath} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError(`config file ${configPath} must contain a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  return record;
}

export async function loadConfig(configPath = defaultConfigPath()): Promise<RunnerConfig> {
  return normalizeConfigRecord(await loadConfigRecord(configPath));
}
