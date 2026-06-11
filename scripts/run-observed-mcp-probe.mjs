#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PRODUCT_SURFACES = [
  "tool-listing",
  "model-class-listing",
  "run_subagent-success",
  "run_subagent-schema-error",
  "run_subagent-handler-validation",
  "run_subagent-child-failure",
  "run_subagent-timeout-recovery",
  "start_run-async-polling",
  "answer_run_input-caller-input",
  "cancel_run-cancellation-settlement",
  "transcript-redaction",
  "run_subagent_session-packet-failure",
  "run_subagent_session-valid-packet-closure",
  "run_subagent_session-invalid-packet-closure",
  "installed-pi-integration",
];

const SCENARIO_REGISTRY = {
  success: {
    tool: "run_subagent",
    evidence_class: "mcp-call-observed",
    lifecycle_phases: ["one-shot-success"],
    result_classes: ["success"],
    surfaces: ["run_subagent-success"],
  },
  "schema-error": {
    tool: "run_subagent",
    evidence_class: "mcp-call-observed",
    lifecycle_phases: ["sdk-schema-validation"],
    result_classes: ["schema_error"],
    surfaces: ["run_subagent-schema-error"],
  },
  "handler-validation": {
    tool: "run_subagent",
    evidence_class: "mcp-call-observed",
    lifecycle_phases: ["handler-validation"],
    result_classes: ["validation_error"],
    surfaces: ["run_subagent-handler-validation"],
  },
  "child-failure": {
    tool: "run_subagent",
    evidence_class: "mcp-call-observed",
    lifecycle_phases: ["child-process-terminal"],
    result_classes: ["nonzero_exit"],
    surfaces: ["run_subagent-child-failure"],
  },
  "packet-failure": {
    tool: "run_subagent_session",
    evidence_class: "mcp-call-observed",
    lifecycle_phases: ["session-attempt", "packet-required-gate"],
    result_classes: ["packet_failed"],
    surfaces: ["run_subagent_session-packet-failure"],
  },
};

const SCENARIOS = new Set(Object.keys(SCENARIO_REGISTRY));

function usage() {
  return [
    "usage: node scripts/run-observed-mcp-probe.mjs [options]",
    "",
    "Runs campaign-scoped MCP tool probes and records every call attempt to the campaign ledger.",
    "",
    "Options:",
    "  --server <path>       MCP server entrypoint. Default: dist/server.js",
    "  --cwd <path>          Absolute project cwd for successful child-backed probes.",
    "  --scenario <name>     Scenario to run. May repeat. Default: all-bundled.",
    "                       Names: all-bundled, success, schema-error, handler-validation, child-failure, packet-failure",
    "  --quiet               Do not print a JSON summary.",
    "  -h, --help            Show this help.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    server: path.resolve("dist/server.js"),
    cwd: undefined,
    scenarios: [],
    scenarioSet: "custom",
    quiet: false,
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
    } else if (arg === "--server") {
      options.server = path.resolve(nextValue(index, arg));
      index += 1;
    } else if (arg === "--cwd") {
      options.cwd = path.resolve(nextValue(index, arg));
      index += 1;
    } else if (arg === "--scenario") {
      const scenario = nextValue(index, arg);
      if (scenario === "all" || scenario === "all-bundled") {
        options.scenarios.push(...SCENARIOS);
        options.scenarioSet = "all-bundled";
      } else if (!SCENARIOS.has(scenario)) {
        throw new Error(`unknown scenario: ${scenario}`);
      } else {
        options.scenarios.push(scenario);
      }
      index += 1;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.help) {
    return { mode: "help" };
  }
  if (options.scenarios.length === 0) {
    options.scenarios = [...SCENARIOS];
    options.scenarioSet = "all-bundled";
  }
  if (options.scenarios.some((scenario) => scenario !== "schema-error") && !options.cwd) {
    throw new Error("--cwd is required unless only schema-error is being probed");
  }
  return { mode: "run", options };
}

function unique(values) {
  return [...new Set(values)].sort();
}

function coverageSummary(scenarios) {
  const metadata = scenarios.map((scenario) => ({
    scenario,
    ...SCENARIO_REGISTRY[scenario],
  }));
  const coveredSurfaces = unique(metadata.flatMap((scenario) => scenario.surfaces));
  return {
    scenarios: metadata,
    covered_surfaces: coveredSurfaces,
    uncovered_surfaces: PRODUCT_SURFACES.filter((surface) => !coveredSurfaces.includes(surface)),
    tools: unique(metadata.map((scenario) => scenario.tool)),
    lifecycle_phases: unique(metadata.flatMap((scenario) => scenario.lifecycle_phases)),
    result_classes: unique(metadata.flatMap((scenario) => scenario.result_classes)),
    evidence_classes: unique(metadata.map((scenario) => scenario.evidence_class)),
  };
}

function campaignLedgerPath() {
  if (process.env.SUBAGENT007_CAMPAIGN_LEDGER_PATH) {
    return path.resolve(process.env.SUBAGENT007_CAMPAIGN_LEDGER_PATH);
  }
  if (process.env.SUBAGENT007_FAILURE_LOG_PATH) {
    return path.join(path.dirname(path.resolve(process.env.SUBAGENT007_FAILURE_LOG_PATH)), "campaign-ledger.jsonl");
  }
  return path.join(process.cwd(), "campaign-ledger.jsonl");
}

function cwdClass(value) {
  if (typeof value !== "string") {
    return typeof value;
  }
  if (!path.isAbsolute(value)) {
    return "relative";
  }
  if (value.startsWith(`${os.tmpdir()}${path.sep}`)) {
    return "temp";
  }
  return "absolute";
}

function redactArguments(args) {
  const keys = Object.keys(args).sort();
  const shape = { keys };
  if (Object.hasOwn(args, "cwd")) {
    shape.cwd_class = cwdClass(args.cwd);
  }
  if (Object.hasOwn(args, "prompt")) {
    shape.prompt_present = typeof args.prompt === "string" && args.prompt.length > 0;
    shape.prompt_length = typeof args.prompt === "string" ? args.prompt.length : null;
  }
  for (const key of ["run_kind", "output_mode", "packet_policy", "resume_mode"]) {
    if (Object.hasOwn(args, key)) {
      shape[key] = args[key];
    }
  }
  if (Object.hasOwn(args, "session_key")) {
    shape.session_key_present = typeof args.session_key === "string" && args.session_key.length > 0;
  }
  return shape;
}

async function appendLedger(ledgerPath, event) {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  const record = {
    schema_version: 1,
    event_id: randomUUID(),
    timestamp: new Date().toISOString(),
    campaign_id: process.env.SUBAGENT007_CAMPAIGN_ID ?? null,
    evidence_class: "mcp-call-observed",
    ...event,
  };
  await fs.appendFile(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

async function readFailureRecords() {
  const failureLogPath = process.env.SUBAGENT007_FAILURE_LOG_PATH;
  if (!failureLogPath) {
    return [];
  }
  let text;
  try {
    text = await fs.readFile(failureLogPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parse_error: true };
      }
    });
}

function responseText(response) {
  return Array.isArray(response.content)
    ? response.content
        .map((entry) => (entry?.type === "text" && typeof entry.text === "string" ? entry.text : ""))
        .join("\n")
    : "";
}

function isSchemaError(response) {
  return response?.isError === true && /Input validation error/.test(responseText(response));
}

function responseSummary(response) {
  const structured = response.structuredContent && typeof response.structuredContent === "object"
    ? response.structuredContent
    : {};
  return {
    is_error: response.isError === true,
    success: typeof structured.success === "boolean" ? structured.success : null,
    status: typeof structured.status === "string" ? structured.status : null,
    exit_code: typeof structured.exit_code === "number" || structured.exit_code === null
      ? structured.exit_code
      : undefined,
    timed_out: typeof structured.timed_out === "boolean" ? structured.timed_out : undefined,
    packet_parse_status: typeof structured.packet_parse_status === "string"
      ? structured.packet_parse_status
      : undefined,
    session_established: typeof structured.session_established === "boolean"
      ? structured.session_established
      : undefined,
    attempt_session_established: typeof structured.attempt_session_established === "boolean"
      ? structured.attempt_session_established
      : undefined,
  };
}

function scenarioCall(scenario, cwd) {
  if (scenario === "success") {
    return {
      tool: "run_subagent",
      args: {
        cwd,
        prompt: "FAST",
        run_kind: "quick_noninteractive",
      },
    };
  }
  if (scenario === "schema-error") {
    return {
      tool: "run_subagent",
      args: {
        cwd: cwd ?? process.cwd(),
      },
    };
  }
  if (scenario === "handler-validation") {
    return {
      tool: "run_subagent",
      args: {
        cwd: "relative-path",
        prompt: "SECRET_LEDGER_PROMPT_HANDLER_VALIDATION",
        run_kind: "quick_noninteractive",
      },
    };
  }
  if (scenario === "child-failure") {
    return {
      tool: "run_subagent",
      args: {
        cwd,
        prompt: "FAIL_EXIT SECRET_LEDGER_PROMPT_CHILD_FAILURE",
        run_kind: "quick_noninteractive",
        output_mode: "transcript",
      },
    };
  }
  if (scenario === "packet-failure") {
    return {
      tool: "run_subagent_session",
      args: {
        cwd,
        prompt: "PACKET_INCONCLUSIVE SECRET_LEDGER_PROMPT_PACKET_FAILURE",
        session_key: `campaign-probe:${Date.now()}:${randomUUID().slice(0, 8)}`,
        resume_mode: "new",
        packet_policy: "required",
      },
    };
  }
  throw new Error(`unknown scenario: ${scenario}`);
}

async function runCall(client, ledgerPath, scenario, call) {
  const callId = randomUUID();
  await appendLedger(ledgerPath, {
    event: "call_started",
    call_id: callId,
    scenario,
    tool: call.tool,
    argument_shape: redactArguments(call.args),
  });

  const failuresBefore = await readFailureRecords();
  let response;
  try {
    response = await client.callTool({
      name: call.tool,
      arguments: call.args,
    });
  } catch (error) {
    await appendLedger(ledgerPath, {
      event: "call_handler_error",
      call_id: callId,
      scenario,
      tool: call.tool,
      error_class: error instanceof Error ? error.name : typeof error,
    });
    response = null;
  }

  if (response) {
    if (isSchemaError(response)) {
      await appendLedger(ledgerPath, {
        event: "call_schema_error",
        call_id: callId,
        scenario,
        tool: call.tool,
        result: responseSummary(response),
      });
    } else if (response.isError === true) {
      await appendLedger(ledgerPath, {
        event: "call_handler_error",
        call_id: callId,
        scenario,
        tool: call.tool,
        result: responseSummary(response),
      });
    } else {
      await appendLedger(ledgerPath, {
        event: "call_result",
        call_id: callId,
        scenario,
        tool: call.tool,
        result: responseSummary(response),
      });
    }
  }

  const failuresAfter = await readFailureRecords();
  const delta = failuresAfter.slice(failuresBefore.length);
  if (delta.length > 0) {
    await appendLedger(ledgerPath, {
      event: "failure_log_delta",
      call_id: callId,
      scenario,
      tool: call.tool,
      delta_count: delta.length,
      failure_classes: [...new Set(delta.map((record) => record.failure_class).filter(Boolean))].sort(),
      reason_codes: [...new Set(delta.map((record) => record.reason_code).filter(Boolean))].sort(),
      tools: [...new Set(delta.map((record) => record.tool).filter(Boolean))].sort(),
    });
  }

  return {
    call_id: callId,
    scenario,
    tool: call.tool,
    response: response ? responseSummary(response) : null,
    failure_log_delta_count: delta.length,
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

const ledgerPath = campaignLedgerPath();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [parsed.options.server],
  env: process.env,
});
const client = new Client({ name: "subagent007-observed-mcp-probe", version: "0.1.0" });
const results = [];

try {
  await client.connect(transport);
  for (const scenario of parsed.options.scenarios) {
    results.push(await runCall(client, ledgerPath, scenario, scenarioCall(scenario, parsed.options.cwd)));
  }
} finally {
  await client.close();
}

const events = (await fs.readFile(ledgerPath, "utf8"))
  .split(/\r?\n/)
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));
const eventCounts = events.reduce((counts, event) => {
  counts[event.event] = (counts[event.event] ?? 0) + 1;
  return counts;
}, {});

if (!parsed.options.quiet) {
  console.log(JSON.stringify(
    {
      campaign_id: process.env.SUBAGENT007_CAMPAIGN_ID ?? null,
      ledger_path: ledgerPath,
      scenario_set: parsed.options.scenarioSet,
      scenarios: parsed.options.scenarios,
      coverage_summary: coverageSummary(parsed.options.scenarios),
      calls: results,
      event_counts: eventCounts,
    },
    null,
    2,
  ));
}
