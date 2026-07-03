#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_CLASSES = ["A", "B", "C", "D", "E"];
const DOC_ENV_KEY_PATTERN = /\b(?:SUBAGENT007_[A-Z0-9_]+|PI_CODING_AGENT_DIR|GIT_COMMIT)\b/g;
const PROCESS_ENV_DOT_PATTERN = /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g;
const PROCESS_ENV_INDEX_PATTERN = /\bprocess\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g;
const ENV_HELPER_ARG_PATTERN =
  /\b(?:defaultSubagentStatePath|safeIntegerFromEnv|nonnegativeIntegerFromEnv|optionalEnv)\(\s*["']([A-Z][A-Z0-9_]*)["']/g;
const ENV_CONSTANT_PATTERN = /\bconst\s+[A-Za-z0-9_]*ENV[A-Za-z0-9_]*\s*=\s*["']([A-Z][A-Z0-9_]*)["']/g;

function rootFromArgs(argv) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex === -1) {
    return SCRIPT_ROOT;
  }
  const root = argv[rootIndex + 1];
  if (!root) {
    throw new Error("--root requires a path");
  }
  return path.resolve(root);
}

const ROOT = rootFromArgs(process.argv.slice(2));

async function readText(relativePath) {
  return fs.readFile(path.join(ROOT, relativePath), "utf8");
}

function collectMatches(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? match[0]);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function isDocumentedRuntimeEnvKey(key) {
  return /^(?:SUBAGENT007_[A-Z0-9_]+|PI_CODING_AGENT_DIR|GIT_COMMIT)$/.test(key);
}

function calibrationBlockFor(modelSource, modelClass) {
  const blockMatch = /\bMODEL_CLASS_CALIBRATIONS\b[\s\S]*?=\s*\{([\s\S]*?)\n\};/.exec(modelSource);
  if (!blockMatch) {
    throw new Error("Could not find MODEL_CLASS_CALIBRATIONS in src/modelAllowlist.ts");
  }
  const classMatch = new RegExp(`\\b${modelClass}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`).exec(blockMatch[1]);
  if (!classMatch) {
    throw new Error(`Could not find model class ${modelClass} calibration`);
  }
  return classMatch[1];
}

function sourceCalibrationModels(modelSource) {
  return uniqueSorted(MODEL_CLASSES.map((modelClass) => {
    const block = calibrationBlockFor(modelSource, modelClass);
    const model = /\bmodel:\s*"([^"]+)"/.exec(block)?.[1];
    if (!model) {
      throw new Error(`Could not parse model for class ${modelClass}`);
    }
    return model;
  }));
}

async function listFiles(dir, predicate) {
  const root = path.join(ROOT, dir);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const relativePath = path.relative(ROOT, entryPath);
    if (entry.isDirectory()) {
      files.push(...await listFiles(relativePath, predicate));
    } else if (predicate(relativePath)) {
      files.push(relativePath);
    }
  }
  return files;
}

function sourceEnvKeysForText(text) {
  return [
    ...collectMatches(text, PROCESS_ENV_DOT_PATTERN),
    ...collectMatches(text, PROCESS_ENV_INDEX_PATTERN),
    ...collectMatches(text, ENV_HELPER_ARG_PATTERN),
    ...collectMatches(text, ENV_CONSTANT_PATTERN),
  ];
}

async function sourceEnvKeys() {
  const files = [
    ...await listFiles("src", (file) => file.endsWith(".ts")),
    ...await listFiles("scripts", (file) => file.endsWith(".mjs")),
  ];
  const keys = [];
  for (const file of files) {
    keys.push(...sourceEnvKeysForText(await readText(file)));
  }
  return uniqueSorted(keys.filter(isDocumentedRuntimeEnvKey));
}

function readmeEnvKeys(readme) {
  return uniqueSorted(collectMatches(readme, DOC_ENV_KEY_PATTERN));
}

function formatList(values) {
  return values.length === 0 ? "(none)" : values.map((value) => `  - ${value}`).join("\n");
}

function checkInternalCalibrationsNotPublished(readme, modelSource) {
  const leakedModels = uniqueSorted(
    sourceCalibrationModels(modelSource).filter((model) => readme.includes(model)),
  );
  return leakedModels.length === 0
    ? []
    : [`README publishes internal model calibration values:\n${formatList(leakedModels)}`];
}

async function checkEnvKeys(readme) {
  const expected = await sourceEnvKeys();
  const documented = readmeEnvKeys(readme);
  const documentedSet = new Set(documented);
  const expectedSet = new Set(expected);
  const missing = expected.filter((key) => !documentedSet.has(key));
  const stale = documented.filter((key) => !expectedSet.has(key));
  return [
    ...(missing.length === 0
      ? []
      : [`README is missing runtime/script environment keys:\n${formatList(missing)}`]),
    ...(stale.length === 0
      ? []
      : [`README documents environment keys not used by runtime/script source:\n${formatList(stale)}`]),
  ];
}

const readme = await readText("README.md");
const modelSource = await readText("src/modelAllowlist.ts");
const failures = [
  ...checkInternalCalibrationsNotPublished(readme, modelSource),
  ...await checkEnvKeys(readme),
];

if (failures.length > 0) {
  console.error(`Docs runtime fact drift detected:\n${failures.join("\n")}`);
  process.exitCode = 1;
}
