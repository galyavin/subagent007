#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { defaultConfigPath } from "../dist/config.js";
import {
  modelClassChoices,
  modelClassForResolvedPair,
} from "../dist/modelAllowlist.js";

function usage() {
  return [
    "usage: node scripts/migrate-config.mjs",
    "",
    "Canonicalizes the configured Subagent007 default_model_class.",
    "Legacy default_model/default_thinking_level pairs are migrated when they match a known class calibration.",
    "Set SUBAGENT007_CONFIG_PATH to migrate a non-default config file.",
  ].join("\n");
}

function print(result) {
  console.log(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(argv) {
  if (argv.length === 0) {
    return { mode: "migrate" };
  }
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { mode: "help" };
  }
  return { mode: "invalid", error: `unknown argument: ${argv.join(" ")}` };
}

async function writeJsonAtomically(configPath, value) {
  const tmpPath = path.join(path.dirname(configPath), `.config.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await fs.rename(tmpPath, configPath);
}

const invocation = parseArgs(process.argv.slice(2));
if (invocation.mode === "help") {
  console.log(usage());
  process.exit(0);
}
if (invocation.mode === "invalid") {
  console.error(invocation.error);
  console.error("");
  console.error(usage());
  process.exit(2);
}

const configPath = defaultConfigPath();
let raw;
try {
  raw = await fs.readFile(configPath, "utf8");
} catch (error) {
  if (error && error.code === "ENOENT") {
    print({ status: "missing_config", config_path: configPath });
    process.exit(0);
  }
  throw error;
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (error) {
  print({
    status: "invalid_json",
    config_path: configPath,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}

if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
  print({
    status: "invalid_json",
    config_path: configPath,
    error: "config must contain a JSON object",
  });
  process.exit(1);
}

function allowedClasses() {
  return modelClassChoices().join(", ");
}

function unrepairableModelClassResult(details) {
  return {
    status: "unrepairable_model_class",
    config_path: configPath,
    ...details,
    allowed_model_classes: allowedClasses(),
  };
}

function migratedConfig(value, modelClass) {
  const migrated = { ...value, default_model_class: modelClass };
  delete migrated.default_model;
  delete migrated.default_thinking_level;
  return migrated;
}

const rawModelClass = parsed.default_model_class;
if (typeof rawModelClass === "string" && rawModelClass.trim() !== "") {
  const canonicalModelClass = rawModelClass.trim();
  if (!modelClassChoices().includes(canonicalModelClass)) {
    print(unrepairableModelClassResult({
      default_model_class: rawModelClass,
    }));
    process.exit(1);
  }

  const migrated = migratedConfig(parsed, canonicalModelClass);
  if (JSON.stringify(migrated) === JSON.stringify(parsed)) {
    print({
      status: "unchanged",
      config_path: configPath,
      default_model_class: canonicalModelClass,
    });
    process.exit(0);
  }

  await writeJsonAtomically(configPath, migrated);
  print({
    status: "migrated",
    config_path: configPath,
    from: rawModelClass,
    to: canonicalModelClass,
    default_model_class: canonicalModelClass,
  });
  process.exit(0);
}

const defaultModel = parsed.default_model;
const defaultThinkingLevel = parsed.default_thinking_level;
if (
  typeof defaultModel !== "string" ||
  defaultModel.trim() === "" ||
  typeof defaultThinkingLevel !== "string" ||
  defaultThinkingLevel.trim() === ""
) {
  print(unrepairableModelClassResult({
    default_model: defaultModel ?? null,
    default_thinking_level: defaultThinkingLevel ?? null,
  }));
  process.exit(1);
}

const modelClass = modelClassForResolvedPair(defaultModel, defaultThinkingLevel.trim());
if (!modelClass) {
  print(unrepairableModelClassResult({
    default_model: defaultModel,
    default_thinking_level: defaultThinkingLevel,
  }));
  process.exit(1);
}

const migrated = migratedConfig(parsed, modelClass);
await writeJsonAtomically(configPath, migrated);
print({
  status: "migrated",
  config_path: configPath,
  from: {
    default_model: defaultModel,
    default_thinking_level: defaultThinkingLevel,
  },
  to: modelClass,
  default_model_class: modelClass,
});
