#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CURATED_EXACT_MODEL_REFS,
  MODEL_RUNTIME_FALLBACKS,
  MODEL_CLASS_CALIBRATIONS,
  OPENAI_CODEX_GPT54_PLUS_REF,
  isOpenAICodexGpt54OrNewerModelId,
  splitKnownProviderModelRef,
} from "../dist/modelAllowlist.js";

const execFileAsync = promisify(execFile);

async function run(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      return { ok: false, error: `${response.status} ${response.statusText}` };
    }
    return { ok: true, json: await response.json() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function parsePiList(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("provider ")) {
      continue;
    }
    const columns = trimmed.split(/\s{2,}/);
    if (columns.length >= 2) {
      rows.push({ provider: columns[0], model: columns[1] });
    }
  }
  return rows;
}

function presentStatus(verified, present, error) {
  if (!verified) {
    return error ? `unverified: ${error}` : "unverified";
  }
  return present ? "present" : "missing";
}

function printTable(rows) {
  const headers = ["model_ref", "pi", "source", "details"];
  const allRows = [headers, ...rows.map((row) => [row.modelRef, row.piStatus, row.sourceStatus, row.details])];
  const widths = headers.map((_, index) =>
    Math.max(...allRows.map((row) => row[index].length))
  );
  for (const row of allRows) {
    console.log(`| ${row.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} |`);
    if (row === headers) {
      console.log(`| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`);
    }
  }
}

const piResult = await run("pi", ["--list-models"]);
const piModels = piResult.ok ? parsePiList(piResult.output) : [];
const piRefs = new Set(piModels.map((row) => `${row.provider}/${row.model}`));

const openRouterResult = await fetchJson("https://openrouter.ai/api/v1/models");
const openRouterIds = openRouterResult.ok
  ? new Set((openRouterResult.json.data ?? []).map((model) => model.id))
  : undefined;

const ollamaResult = await fetchJson("http://localhost:11434/api/tags");
const ollamaIds = ollamaResult.ok
  ? new Set((ollamaResult.json.models ?? []).map((model) => model.model ?? model.name))
  : undefined;

const rows = [];
const openAICodexMatches = piModels
  .filter((model) => model.provider === "openai-codex" && isOpenAICodexGpt54OrNewerModelId(model.model))
  .map((model) => model.model)
  .sort((a, b) => a.localeCompare(b));

rows.push({
  modelRef: OPENAI_CODEX_GPT54_PLUS_REF,
  piStatus: presentStatus(piResult.ok, openAICodexMatches.length > 0, piResult.error),
  sourceStatus: "pi-registry",
  details: openAICodexMatches.length > 0 ? openAICodexMatches.join(", ") : "No matching Pi models.",
  drift: piResult.ok && openAICodexMatches.length === 0,
  unverified: !piResult.ok,
});

const exactModelRefs = new Set(CURATED_EXACT_MODEL_REFS);
const calibratedModelRefs = new Map();
for (const [modelClass, calibration] of Object.entries(MODEL_CLASS_CALIBRATIONS)) {
  const modelClasses = calibratedModelRefs.get(calibration.model) ?? [];
  modelClasses.push(modelClass);
  calibratedModelRefs.set(calibration.model, modelClasses);
}

for (const [modelRef, modelClasses] of calibratedModelRefs) {
  if (exactModelRefs.has(modelRef)) {
    continue;
  }
  const { provider } = splitKnownProviderModelRef(modelRef);
  const piPresent = piRefs.has(modelRef);
  rows.push({
    modelRef,
    piStatus: presentStatus(piResult.ok, piPresent, piResult.error),
    sourceStatus: provider === "openai-codex" ? "pi-registry" : "calibration",
    details: `Concrete calibration for class ${modelClasses.join("/")}.`,
    drift: piResult.ok && !piPresent,
    unverified: !piResult.ok,
  });
}

for (const modelRef of CURATED_EXACT_MODEL_REFS) {
  const { provider, model } = splitKnownProviderModelRef(modelRef);
  if (!provider) {
    throw new Error(`curated model ref must be provider-qualified: ${modelRef}`);
  }

  const fallback = MODEL_RUNTIME_FALLBACKS[modelRef];
  const fallbackTemplatePresent = fallback ? piRefs.has(fallback.template) : false;
  const piPresent = piRefs.has(modelRef) || fallbackTemplatePresent;
  let sourceVerified = false;
  let sourcePresent = false;
  let sourceError;
  if (provider === "openrouter") {
    sourceVerified = openRouterIds !== undefined;
    sourcePresent = Boolean(openRouterIds?.has(model));
    sourceError = openRouterResult.ok ? undefined : openRouterResult.error;
  } else if (provider === "ollama") {
    sourceVerified = ollamaIds !== undefined;
    sourcePresent = Boolean(ollamaIds?.has(model));
    sourceError = ollamaResult.ok ? undefined : ollamaResult.error;
  }

  rows.push({
    modelRef,
    piStatus: presentStatus(piResult.ok, piPresent, piResult.error),
    sourceStatus: presentStatus(sourceVerified, sourcePresent, sourceError),
    details: fallback && fallbackTemplatePresent
      ? `Exact curated model; runtime fallback uses ${fallback.template}.`
      : "Exact curated model.",
    drift: (piResult.ok && !piPresent) || (sourceVerified && !sourcePresent),
    unverified: !piResult.ok || !sourceVerified,
  });
}

console.log("# Model Reconciliation");
console.log("");
console.log(`Generated: ${new Date().toISOString()}`);
console.log(`Pi models: ${piModels.length}${piResult.ok ? "" : " (unverified)"}`);
console.log(`OpenRouter models: ${openRouterIds?.size ?? "unverified"}`);
console.log(`Ollama models: ${ollamaIds?.size ?? "unverified"}`);
console.log("");
printTable(rows);

const driftRows = rows.filter((row) => row.drift);
const unverifiedRows = rows.filter((row) => row.unverified && !row.drift);
if (driftRows.length > 0) {
  console.log("");
  console.log("Drift detected:");
  for (const row of driftRows) {
    console.log(`- ${row.modelRef}: pi=${row.piStatus}, source=${row.sourceStatus}`);
  }
  process.exitCode = 1;
} else if (unverifiedRows.length > 0) {
  console.log("");
  console.log("Unverified sources:");
  for (const row of unverifiedRows) {
    console.log(`- ${row.modelRef}: pi=${row.piStatus}, source=${row.sourceStatus}`);
  }
}
