#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { defaultConfigPath } from "../dist/config.js";
import {
  formatAllowedModelChoices,
  resolveAllowedModelRef,
} from "../dist/modelAllowlist.js";

function usage() {
  return [
    "usage: node scripts/migrate-config.mjs",
    "",
    "Canonicalizes the configured Subagent007 default_model when it is a known allowed alias.",
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

const defaultModel = parsed.default_model;
if (typeof defaultModel !== "string" || defaultModel.trim() === "") {
  print({
    status: "unrepairable_model",
    config_path: configPath,
    default_model: defaultModel ?? null,
    allowed_models: formatAllowedModelChoices(),
  });
  process.exit(1);
}

let canonicalModel;
try {
  canonicalModel = resolveAllowedModelRef(defaultModel);
} catch (error) {
  print({
    status: "unrepairable_model",
    config_path: configPath,
    default_model: defaultModel,
    error: error instanceof Error ? error.message : String(error),
    allowed_models: formatAllowedModelChoices(),
  });
  process.exit(1);
}

if (canonicalModel === defaultModel) {
  print({
    status: "unchanged",
    config_path: configPath,
    default_model: canonicalModel,
  });
  process.exit(0);
}

const migrated = { ...parsed, default_model: canonicalModel };
await writeJsonAtomically(configPath, migrated);
print({
  status: "migrated",
  config_path: configPath,
  from: defaultModel,
  to: canonicalModel,
});
