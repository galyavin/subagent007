#!/usr/bin/env node
import path from "node:path";
import { modelClassChoices, resolveModelClass } from "../dist/modelAllowlist.js";
import {
  MODEL_HEALTH_SURFACE_ONE_SHOT,
  upsertModelHealthRecord,
} from "../dist/modelHealth.js";
import { runSubagentCore } from "../dist/runSubagent.js";

const MODEL_CLASS_CHOICES = modelClassChoices();
const MODEL_CLASSES = new Set(MODEL_CLASS_CHOICES);

function usage() {
  return [
    "usage: node scripts/probe-model-health.mjs --model-class <A-E|Z1-Z3> [--cwd <path>] [options]",
    "",
    "Records one-shot model-class health for Subagent007.",
    "",
    "Options:",
    "  --model-class <A-E|Z1-Z3>  Model class to probe or record.",
    "  --cwd <path>               Absolute cwd for a real one-shot smoke probe.",
    "  --prompt <text>            Smoke prompt. Default asks for SUBAGENT007_HEALTH_OK.",
    "  --record-status <status>   Record healthy or unhealthy without running a child.",
    "  --latency-ms <n>           Success latency for direct healthy records.",
    "  --failure-class <text>     Failure class for direct unhealthy records.",
    "  -h, --help                 Show this help.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    modelClass: undefined,
    cwd: undefined,
    prompt: "Reply with exactly: SUBAGENT007_HEALTH_OK",
    recordStatus: undefined,
    latencyMs: undefined,
    failureClass: undefined,
    help: false,
  };

  function nextValue(index, name) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    return value;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--model-class") {
      options.modelClass = nextValue(index, arg);
      index += 1;
    } else if (arg === "--cwd") {
      options.cwd = path.resolve(nextValue(index, arg));
      index += 1;
    } else if (arg === "--prompt") {
      options.prompt = nextValue(index, arg);
      index += 1;
    } else if (arg === "--record-status") {
      options.recordStatus = nextValue(index, arg);
      index += 1;
    } else if (arg === "--latency-ms") {
      const value = Number(nextValue(index, arg));
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("--latency-ms must be a nonnegative integer");
      }
      options.latencyMs = value;
      index += 1;
    } else if (arg === "--failure-class") {
      options.failureClass = nextValue(index, arg);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.help) {
    return { mode: "help" };
  }
  if (!MODEL_CLASSES.has(options.modelClass)) {
    throw new Error(`--model-class must be one of: ${MODEL_CLASS_CHOICES.join(", ")}`);
  }
  if (
    options.recordStatus !== undefined &&
    options.recordStatus !== "healthy" &&
    options.recordStatus !== "unhealthy"
  ) {
    throw new Error("--record-status must be healthy or unhealthy");
  }
  if (!options.recordStatus && !options.cwd) {
    throw new Error("--cwd is required unless --record-status is provided");
  }
  return { mode: "run", options };
}

function recordFor(options, result = null) {
  const { model } = resolveModelClass(options.modelClass);
  const checkedAt = new Date().toISOString();
  if (options.recordStatus) {
    const healthy = options.recordStatus === "healthy";
    return {
      schema_version: 1,
      model_class: options.modelClass,
      resolved_model: model,
      surface: MODEL_HEALTH_SURFACE_ONE_SHOT,
      checked_at: checkedAt,
      usable_for_one_shot: healthy,
      ...(healthy && options.latencyMs !== undefined ? { last_success_latency_ms: options.latencyMs } : {}),
      ...(!healthy
        ? {
            last_failure_class: options.failureClass ?? "manual_unhealthy",
            last_failure_at: checkedAt,
          }
        : {}),
    };
  }
  const healthy = Boolean(result?.success && !result.timed_out);
  return {
    schema_version: 1,
    model_class: options.modelClass,
    resolved_model: model,
    surface: MODEL_HEALTH_SURFACE_ONE_SHOT,
    checked_at: checkedAt,
    usable_for_one_shot: healthy,
    ...(healthy ? { last_success_latency_ms: result.duration_ms } : {}),
    ...(!healthy
      ? {
          last_failure_class: result?.timed_out ? "timeout" : result?.stop_reason ?? "failed",
          last_failure_at: checkedAt,
        }
      : {}),
  };
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  console.error(usage());
  process.exit(2);
}

if (parsed.mode === "help") {
  console.log(usage());
  process.exit(0);
}

let result = null;
if (!parsed.options.recordStatus) {
  result = await runSubagentCore(
    {
      cwd: parsed.options.cwd,
      prompt: parsed.options.prompt,
      model_class: parsed.options.modelClass,
      run_kind: "quick_noninteractive",
      output_mode: "final",
    },
  );
}

const record = recordFor(parsed.options, result);
await upsertModelHealthRecord(record);
console.log(JSON.stringify({ record, probe_result: result }, null, 2));
process.exit(record.usable_for_one_shot ? 0 : 1);
