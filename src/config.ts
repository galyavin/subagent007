import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { THINKING_LEVELS, type RunnerConfig, type ThinkingLevel } from "./types.js";
import { ValidationError } from "./types.js";

function defaultConfigPath(): string {
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

function thinkingLevel(value: unknown, key: string): ThinkingLevel | undefined {
  const level = nonEmptyString(value, key);
  if (level === undefined) {
    return undefined;
  }
  if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
    throw new ValidationError(`${key} must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  return level as ThinkingLevel;
}

export async function loadConfig(configPath = defaultConfigPath()): Promise<RunnerConfig> {
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
  return {
    default_model: nonEmptyString(record.default_model, "default_model"),
    default_thinking_level: thinkingLevel(record.default_thinking_level, "default_thinking_level"),
  };
}
