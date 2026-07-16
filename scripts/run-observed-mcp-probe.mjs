#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = process.env.SUBAGENT007_COVERAGE_MANIFEST_PATH
  ? path.resolve(process.env.SUBAGENT007_COVERAGE_MANIFEST_PATH)
  : path.join(SCRIPT_DIR, "observed-coverage-manifest.json");
const MANIFEST = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
const PRODUCT_SURFACES = Object.keys(MANIFEST.surfaces).sort();
const SCENARIO_REGISTRY = MANIFEST.scenarios;
const SCENARIOS = new Set(Object.keys(SCENARIO_REGISTRY));
const PROFILES = new Set(Object.keys(MANIFEST.profiles));
const PROBE_MODES = new Set(["protocol-deterministic", "live-model"]);
const EXPECTED_PUBLIC_TOOLS = [
  "answer_run_input",
  "cancel_run",
  "get_run",
  "get_run_contract",
  "get_runtime_readiness",
  "list_allowed_models",
  "list_model_classes",
  "run_subagent",
  "run_subagent_session",
  "schedule_run",
  "start_run",
  "start_session_run",
].sort();
const SKILL_BINDING_TOOLS = [
  "run_subagent",
  "run_subagent_session",
  "schedule_run",
  "start_run",
  "start_session_run",
].sort();
const CONSTRAINED_RUN_TOOLS = ["run_subagent", "schedule_run", "start_run"];
const NAMED_SESSION_TOOLS = ["run_subagent_session", "start_session_run"];
const FORBIDDEN_PUBLIC_CALIBRATION_FIELDS = new Set([
  "resolved_model",
  "resolved_thinking_level",
  "resolved_default_model",
  "resolved_default_thinking_level",
]);
const FORBIDDEN_FAILURE_LOG_CALIBRATION_FIELDS = new Set([
  "model",
  "thinking_level",
]);
const RETIRED_BUNDLED_ALIAS = "all-bundled";
const RETIRED_BUNDLED_ALIAS_MESSAGE =
  "all-bundled is retired; use --profile protocol-core for the historical bundled protocol-core scenario set";
const RECURSIVE_DELEGATE_SCENARIO_PROMPTS = {
  "recursive-delegate-success": "RECURSIVE_DELEGATE_FAST",
  "recursive-delegate-two-hop": "RECURSIVE_DELEGATE_TWO_HOP",
  "recursive-delegate-depth-boundary": "RECURSIVE_DELEGATE_TWO_HOP",
  "recursive-delegate-parent-terminal-child-finish": "RECURSIVE_DELEGATE_WAIT0_CHILD_FINISH",
  "recursive-delegate-depth-limit": "RECURSIVE_DELEGATE_DEPTH_LIMIT",
  "recursive-delegate-forged-lineage": "RECURSIVE_DELEGATE_FORGED_PARENT",
};

function selectProfile(options, profile) {
  options.profile = profile;
  options.scenarioSet = profile;
  options.mode = MANIFEST.profiles[profile].mode;
}

function assertNotRetiredAlias(value) {
  if (value === RETIRED_BUNDLED_ALIAS) {
    throw new Error(RETIRED_BUNDLED_ALIAS_MESSAGE);
  }
}

function usage() {
  return [
    "usage: node scripts/run-observed-mcp-probe.mjs [options]",
    "",
    "Runs campaign-scoped MCP tool probes and records every call attempt to the campaign ledger.",
    "",
    "Options:",
    "  --server <path>       MCP server entrypoint. Default: dist/server.js",
    "  --cwd <path>          Absolute project cwd for successful child-backed probes.",
    "  --profile <name>      Coverage profile. Default: protocol-core.",
    "                       Names: protocol-core, full-current, live-current.",
    "                       Profile aliases: all -> full-current; live-smoke, stateful-live -> live-current.",
    "                       all-bundled is retired; use --profile protocol-core for the historical bundled subset.",
    "  --scenario <name>     Scenario to run. May repeat. Overrides profile scenarios.",
    "                       Scenario alias: all -> full-current.",
    "  --mode <mode>         Evidence mode: protocol-deterministic or live-model. Default: protocol-deterministic.",
    "  --quiet               Do not print a JSON summary.",
    "  -h, --help            Show this help.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    server: path.resolve("dist/server.js"),
    cwd: undefined,
    scenarios: [],
    profile: "protocol-core",
    scenarioSet: "protocol-core",
    mode: "protocol-deterministic",
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
    } else if (arg === "--profile") {
      const profile = nextValue(index, arg);
      assertNotRetiredAlias(profile);
      const canonical = MANIFEST.aliases[profile] ?? profile;
      if (!PROFILES.has(canonical)) {
        throw new Error(`unknown profile: ${profile}`);
      }
      selectProfile(options, canonical);
      index += 1;
    } else if (arg === "--scenario") {
      const scenario = nextValue(index, arg);
      assertNotRetiredAlias(scenario);
      if (scenario === "all") {
        const profile = MANIFEST.aliases[scenario];
        selectProfile(options, profile);
        options.scenarios.push(...MANIFEST.profiles[profile].scenarios);
      } else if (!SCENARIOS.has(scenario)) {
        throw new Error(`unknown scenario: ${scenario}`);
      } else {
        options.scenarios.push(scenario);
        options.scenarioSet = "custom";
      }
      index += 1;
    } else if (arg === "--mode") {
      const mode = nextValue(index, arg);
      if (!PROBE_MODES.has(mode)) {
        throw new Error(`unknown mode: ${mode}`);
      }
      options.mode = mode;
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
    options.scenarios = [...MANIFEST.profiles[options.profile].scenarios];
  }
  options.scenarios = [...new Set(options.scenarios)];
  if (options.scenarios.some((scenario) => scenario !== "schema-error") && !options.cwd) {
    throw new Error("--cwd is required unless only schema-error is being probed");
  }
  const incompatible = options.scenarios.filter((scenario) =>
    !scenarioEvidenceCompatible(scenario, evidenceClassForMode(options.mode)),
  );
  if (incompatible.length > 0) {
    throw new Error(`${options.mode} mode cannot run incompatible scenarios: ${incompatible.join(", ")}`);
  }
  return { mode: "run", options };
}

function unique(values) {
  return [...new Set(values)].sort();
}

function uniqueRecordValues(records, field) {
  return unique(records.map((record) => record[field]).filter(Boolean));
}

function evidenceClassForMode(mode) {
  return mode === "protocol-deterministic" ? "protocol-deterministic" : "live-model-smoke";
}

function scenarioEvidenceCompatible(scenarioName, evidenceClass) {
  const scenario = SCENARIO_REGISTRY[scenarioName];
  if (!scenario) {
    return false;
  }
  return scenario.surfaces.every((surfaceName) =>
    MANIFEST.surfaces[surfaceName]?.evidence_classes?.includes(evidenceClass),
  );
}

function assertManifestComplete() {
  const missing = MANIFEST.saf_required_surfaces.filter((surface) => !MANIFEST.surfaces[surface]);
  if (missing.length > 0) {
    throw new Error(`coverage manifest omits SAF-required surfaces: ${missing.join(", ")}`);
  }
  for (const [alias, target] of Object.entries(MANIFEST.aliases)) {
    if (!MANIFEST.profiles[target]) {
      throw new Error(`coverage alias ${alias} targets unknown profile: ${target}`);
    }
  }
  for (const [scenarioName, scenario] of Object.entries(MANIFEST.scenarios)) {
    const unknownSurfaces = scenario.surfaces.filter((surface) => !MANIFEST.surfaces[surface]);
    if (unknownSurfaces.length > 0) {
      throw new Error(`coverage scenario ${scenarioName} covers unknown surfaces: ${unknownSurfaces.join(", ")}`);
    }
  }
  for (const [profileName, profile] of Object.entries(MANIFEST.profiles)) {
    const evidenceClass = evidenceClassForMode(profile.mode);
    const unknownScenarios = profile.scenarios.filter((scenario) => !MANIFEST.scenarios[scenario]);
    if (unknownScenarios.length > 0) {
      throw new Error(`coverage profile ${profileName} selects unknown scenarios: ${unknownScenarios.join(", ")}`);
    }
    const missingRequired = profile.required_surfaces.filter((surface) => !MANIFEST.surfaces[surface]);
    if (missingRequired.length > 0) {
      throw new Error(`coverage profile ${profileName} requires unknown surfaces: ${missingRequired.join(", ")}`);
    }
    const incompatibleScenarios = profile.scenarios.filter((scenario) =>
      !scenarioEvidenceCompatible(scenario, evidenceClass),
    );
    if (incompatibleScenarios.length > 0) {
      throw new Error(
        `coverage profile ${profileName} selects scenarios incompatible with ${evidenceClass}: ${incompatibleScenarios.join(", ")}`,
      );
    }
    const unsatisfied = profile.required_surfaces.filter((surface) =>
      !profile.scenarios.some((scenarioName) =>
        MANIFEST.scenarios[scenarioName].surfaces.includes(surface) &&
          MANIFEST.surfaces[surface].evidence_classes.includes(evidenceClass),
      ),
    );
    if (unsatisfied.length > 0) {
      throw new Error(`coverage profile ${profileName} has no compatible scenario for required surfaces: ${unsatisfied.join(", ")}`);
    }
  }
}

function responseHasNoForbiddenCalibrationFields(response) {
  return Boolean(response) &&
    response.public_calibration_fields_absent === true &&
    response.failure_log_calibration_fields_absent === true;
}

function recursiveChildEvents(response, phase) {
  const values = response?.[`recursive_child_${phase}_events`];
  return Array.isArray(values) ? values : [];
}

function recursiveChildEvent(response, phase, childRunId) {
  return recursiveChildEvents(response, phase).find((event) => event?.child_run_id === childRunId);
}

function recursiveChildEventMatchesLineage(response, phase, childRunId) {
  const event = recursiveChildEvent(response, phase, childRunId);
  return event?.parent_run_id === response.run_id &&
    event?.root_run_id === response.run_id &&
    event?.recursion_depth === 1;
}

function recursiveChildFinishedEventMatches(response, childRunId, status, success) {
  const event = recursiveChildEvent(response, "finished", childRunId);
  return recursiveChildEventMatchesLineage(response, "finished", childRunId) &&
    event?.status === status &&
    event?.success === success;
}

function responseMatchesResultShape(response, resultClass) {
  if (!response) {
    return false;
  }
  const completedAfterPolling =
    response.success === true && response.status === "completed" && response.polled === true;
  if (resultClass === "expected_tool_surface") {
    return response.is_error === false &&
      response.tool_surface_complete === true &&
      response.tool_surface_exact === true &&
      response.skill_alias_guidance_clear === true &&
      response.effect_profile_schema_exact === true &&
      response.operational_guidance_clear === true;
  }
  if (resultClass === "success") {
    return response.is_error === false && response.success !== false;
  }
  if (resultClass === "run_success") {
    return response.is_error === false &&
      response.success === true &&
      response.status === "completed" &&
      response.timed_out === false;
  }
  if (resultClass === "schema_error") {
    return response.is_error === true;
  }
  if (resultClass === "preflight_rejected") {
    return response.kind === "preflight_rejected" && response.child_started === false;
  }
  if (resultClass === "nonzero_exit") {
    return response.success === false &&
      typeof response.exit_code === "number" &&
      response.exit_code !== 0;
  }
  if (resultClass === "missing_final_output") {
    return response.success === false &&
      response.status === "failed" &&
      response.exit_code === 0 &&
      response.timed_out === false &&
      response.reason_code === "missing_final_output" &&
      response.requested_output_mode === "final" &&
      response.written_output_mode === "transcript" &&
      response.output_reference_modes.includes("transcript");
  }
  if (resultClass === "packet_required_not_ready") {
    return response.success === false &&
      response.reason_code === "packet_required_not_ready" &&
      response.packet_parse_status === "valid";
  }
  if (resultClass === "transcript_redacted") {
    return response.success === true && response.transcript_redacted === true;
  }
  if (resultClass === "timeout_recovered") {
    return response.success === false &&
      response.timed_out === true &&
      response.timeout_recovery_hint === true;
  }
  if (resultClass === "async_polling") {
    return completedAfterPolling;
  }
  if (resultClass === "scheduled_durable") {
    return completedAfterPolling && response.scheduled === true;
  }
  if (resultClass === "input_answered") {
    return response.success === true && response.input_answered === true;
  }
  if (resultClass === "input_exact_retry") {
    return response.success === true && response.input_exact_retry === true;
  }
  if (resultClass === "session_resume") {
    return response.success === true && response.session_resume === true && response.child_started === true;
  }
  if (resultClass === "queue_lifecycle") {
    return response.queue_lifecycle === true;
  }
  if (resultClass === "cancelled") {
    return response.status === "cancelled" && response.cancellation_settled === true;
  }
  if (resultClass === "valid_packet_closure") {
    return response.success === true &&
      response.packet_parse_status === "valid" &&
      response.packet_closure_valid === true;
  }
  if (resultClass === "invalid_packet_closure") {
    return response.success === false &&
      response.packet_parse_status === "invalid" &&
      response.packet_closure_invalid === true;
  }
  if (resultClass === "auto_promoted") {
    return response.auto_promoted_from === "run_subagent" && completedAfterPolling;
  }
  if (resultClass === "session_async_polling") {
    return completedAfterPolling &&
      response.child_started === true &&
      response.session_established === true &&
      response.packet_parse_status === "valid" &&
      response.packet_closure_valid === true;
  }
  if (resultClass === "start_session_packet_failure_logged") {
    return response.success === false &&
      response.status === "failed" &&
      response.reason_code === "packet_required_not_ready" &&
      response.packet_parse_status === "valid" &&
      response.failure_log_matching_tool === "start_session_run" &&
      response.failure_log_matching_task_kind === "session" &&
      response.failure_log_matching_run_id === response.run_id;
  }
  if (resultClass === "session_require_existing_missing") {
    return response.kind === "preflight_rejected" &&
      response.status === "rejected" &&
      response.success === false &&
      response.reason_code === "session_does_not_exist" &&
      response.child_started === false &&
      response.run_id === undefined;
  }
  if (resultClass === "local_capacity_exhaustion_release") {
    return response.capacity_rejected === true &&
      response.kind === "preflight_rejected" &&
      response.status === "rejected" &&
      response.reason_code === "local_capacity_exhausted" &&
      response.child_started === false &&
      response.cleanup_status === "cancelled" &&
      response.after_release_status === "completed" &&
      response.after_release_success === true;
  }
  if (resultClass === "run_not_found") {
    return response.kind === "operation_rejected" &&
      response.reason_code === "run_not_found";
  }
  if (resultClass === "input_wrong_rejected") {
    return response.input_wrong_rejected === true &&
      response.kind === "operation_rejected" &&
      response.is_error === false &&
      response.reason_code === "input_request_not_part_of_run";
  }
  if (resultClass === "terminal_cancel_idempotent") {
    return response.terminal_cancel_idempotent === true;
  }
  if (resultClass === "restart_drift") {
    return response.status === "failed" &&
      response.error_class === "restart_drift" &&
      response.reason_code === "server_restarted_active_run";
  }
  if (resultClass === "recursive_delegate_success_lineage") {
    return response.success === true &&
      response.status === "completed" &&
      response.polled === true &&
      response.root_run_id === response.run_id &&
      response.recursion_depth === 0 &&
      response.delegated_success === true &&
      response.delegated_status === "completed" &&
      response.delegated_parent_run_id === response.run_id &&
      response.delegated_root_run_id === response.run_id &&
      response.delegated_recursion_depth === 1 &&
      response.root_child_contains_delegated === true &&
      response.delegated_view_status === "completed" &&
      response.delegated_view_parent_run_id === response.run_id &&
      response.delegated_view_root_run_id === response.run_id &&
      response.delegated_view_recursion_depth === 1 &&
      response.recursive_child_started_event === true &&
      response.recursive_child_finished_event === true &&
      recursiveChildEventMatchesLineage(response, "started", response.delegated_run_id) &&
      recursiveChildFinishedEventMatches(response, response.delegated_run_id, "completed", true);
  }
  if (resultClass === "recursive_delegate_parent_terminal_child_finish_event") {
    return response.success === true &&
      response.status === "completed" &&
      response.polled === true &&
      typeof response.delegated_run_id === "string" &&
      response.delegated_status === "working" &&
      response.delegated_view_status === "completed" &&
      response.delegated_view_parent_run_id === response.run_id &&
      response.delegated_view_root_run_id === response.run_id &&
      response.delegated_view_recursion_depth === 1 &&
      response.root_child_contains_delegated === true &&
      recursiveChildEventMatchesLineage(response, "started", response.delegated_run_id) &&
      recursiveChildFinishedEventMatches(response, response.delegated_run_id, "completed", true);
  }
  if (resultClass === "recursive_delegate_two_hop") {
    return response.success === true &&
      response.delegated_view_status === "completed" &&
      response.delegated_view_parent_run_id === response.run_id &&
      response.delegated_view_root_run_id === response.run_id &&
      response.delegated_view_recursion_depth === 1 &&
      response.root_child_contains_delegated === true &&
      response.nested_child_status === "completed" &&
      typeof response.nested_delegated_run_id === "string" &&
      Array.isArray(response.delegated_view_child_run_ids) &&
      response.delegated_view_child_run_ids.includes(response.nested_delegated_run_id) &&
      response.nested_child_parent_run_id === response.delegated_run_id &&
      response.nested_child_root_run_id === response.run_id &&
      response.nested_child_recursion_depth === 2;
  }
  if (resultClass === "recursive_delegate_depth_boundary") {
    return response.success === true &&
      response.delegated_view_status === "completed" &&
      response.delegated_view_parent_run_id === response.run_id &&
      response.delegated_view_root_run_id === response.run_id &&
      response.nested_delegate_reason_code === "recursive_depth_exceeded" &&
      response.delegated_view_recursion_depth === 1 &&
      response.nested_delegated_run_id === undefined &&
      response.nested_child_run_count === 0;
  }
  if (resultClass === "recursive_delegate_depth_rejected") {
    return response.success === true &&
      response.status === "completed" &&
      response.polled === true &&
      response.delegated_status === "rejected" &&
      response.delegated_kind === "recursive_delegate_rejected" &&
      response.delegated_reason_code === "recursive_depth_exceeded" &&
      response.root_child_run_count === 0 &&
      response.recursive_child_started_event !== true &&
      response.recursive_child_finished_event !== true;
  }
  if (resultClass === "recursive_delegate_forged_rejected") {
    return response.success === true &&
      response.status === "completed" &&
      response.polled === true &&
      response.delegated_status === "rejected" &&
      response.delegated_kind === "recursive_delegate_rejected" &&
      response.delegated_reason_code === "recursive_control_invalid" &&
      response.root_child_run_count === 0 &&
      response.recursive_child_started_event !== true &&
      response.recursive_child_finished_event !== true;
  }
  if (resultClass === "runtime_ready") {
    return response.is_error === false &&
      response.ready === true &&
      response.status === "ready" &&
      response.contract_name === "subagent007.runtime_readiness";
  }
  return false;
}

function responseMatchesResultClass(response, resultClass) {
  return responseHasNoForbiddenCalibrationFields(response) &&
    responseMatchesResultShape(response, resultClass);
}

function coverageSummary(scenarios, mode, profileName, calls = []) {
  const evidenceClass = evidenceClassForMode(mode);
  const profile = MANIFEST.profiles[profileName] ?? {
    required_surfaces: [],
    scenarios,
  };
  const callsByScenario = new Map(calls.map((call) => [call.scenario, call]));
  const metadata = scenarios.map((scenario) => {
    const registryEntry = SCENARIO_REGISTRY[scenario];
    const call = callsByScenario.get(scenario);
    const evidence_satisfied = registryEntry.result_classes.some((resultClass) =>
      responseMatchesResultClass(call?.response, resultClass),
    );
    return {
      scenario,
      ...registryEntry,
      evidence_class: evidenceClass,
      evidence_satisfied,
      observed_result: call?.response ?? null,
    };
  });
  const coveredSurfaces = unique(
    metadata
      .filter((scenario) => scenario.evidence_satisfied)
      .flatMap((scenario) => scenario.surfaces),
  );
  const selectedSurfaces = unique(metadata.flatMap((scenario) => scenario.surfaces));
  const coveredByEvidenceClass = metadata.reduce((groups, scenario) => {
    if (!scenario.evidence_satisfied) {
      return groups;
    }
    groups[scenario.evidence_class] = unique([
      ...(groups[scenario.evidence_class] ?? []),
      ...scenario.surfaces,
    ]);
    return groups;
  }, {});
  const optionalSurfaces = PRODUCT_SURFACES.filter((surface) => !profile.required_surfaces.includes(surface));
  const outOfScopeSurfaces = PRODUCT_SURFACES.filter((surface) => !selectedSurfaces.includes(surface));
  const uncoveredSurfaces = PRODUCT_SURFACES.filter((surface) => !coveredSurfaces.includes(surface));
  return {
    profile: profileName,
    scenarios: metadata,
    required_surfaces: [...profile.required_surfaces].sort(),
    optional_surfaces: optionalSurfaces,
    out_of_scope_surfaces: outOfScopeSurfaces,
    skipped_surfaces: outOfScopeSurfaces,
    covered_surfaces: coveredSurfaces,
    covered_surfaces_by_evidence_class: coveredByEvidenceClass,
    uncovered_surfaces: uncoveredSurfaces,
    missing_required_surfaces: profile.required_surfaces.filter((surface) => !coveredSurfaces.includes(surface)).sort(),
    tools: unique(metadata.map((scenario) => scenario.tool)),
    result_classes: unique(metadata.flatMap((scenario) => scenario.result_classes)),
    evidence_classes: unique(metadata.map((scenario) => scenario.evidence_class)),
  };
}

async function createDeterministicFakeChild() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-probe-fake-pi-"));
  const childPath = path.join(tmp, "fake-pi-child.cjs");
  const logPath = path.join(tmp, "fake-pi-child.jsonl");
  await fs.writeFile(
    childPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "const path = require('path');",
      "const net = require('net');",
      "const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));",
      "const logPath = process.env.FAKE_PI_LOG_PATH;",
      "function requestForLog() {",
      "  const clone = { ...request };",
      "  if (clone.recursiveControl) clone.recursiveControl = { ...clone.recursiveControl, socket_path: '[redacted]', token: '[redacted]' };",
      "  return clone;",
      "}",
      "if (logPath) fs.appendFileSync(logPath, JSON.stringify({ request: requestForLog() }) + '\\n');",
      "function writeEvent(event) { process.stdout.write(JSON.stringify(event) + '\\n'); }",
      "function writeFinal(text) {",
      "  if (request.outputLastMessagePath && request.outputMode === 'final') fs.writeFileSync(request.outputLastMessagePath, text);",
      "  else process.stdout.write(text);",
      "}",
      "function sessionFileForFresh() {",
      "  if (!request.sessionDir) return null;",
      "  fs.mkdirSync(request.sessionDir, { recursive: true });",
      "  const sessionFile = path.join(request.sessionDir, 'fake-pi-session.jsonl');",
      "  fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'fake-pi-session' }) + '\\n');",
      "  return sessionFile;",
      "}",
      "let sessionFile = null;",
      "if (request.sessionMode === 'fresh') sessionFile = sessionFileForFresh();",
      "if (request.sessionMode === 'resume') sessionFile = request.sessionFile;",
      "if (sessionFile) writeEvent({ type: 'subagent007.session', session_id: sessionFile });",
      "function packetFinal(packet) {",
      "  return '```contract_packet_v1\\n' + JSON.stringify(packet) + '\\n```';",
      "}",
      "function writeInputRequest() {",
      "  const runDir = path.join(request.mailboxRoot, request.runId);",
      "  fs.mkdirSync(runDir, { recursive: true });",
      "  const requestId = request.runId + '-abcdef123456';",
      "  const requestPath = path.join(runDir, requestId + '.json');",
      "  fs.writeFileSync(requestPath, JSON.stringify({ schema_version: 2, request_id: requestId, run_id: request.runId, session_id: null, created_at: new Date().toISOString(), question: 'Need campaign input?', options: [], option_ids: [], freeform: true, max_answer_chars: 4096 }) + '\\n');",
      "  writeEvent({ type: 'subagent007.input_request', request_id: requestId, question: 'Need campaign input?', option_count: 0, freeform: true });",
      "  let buffer = '';",
      "  process.stdin.setEncoding('utf8');",
      "  process.stdin.on('data', (chunk) => {",
      "    buffer += chunk;",
      "    let newline;",
      "    while ((newline = buffer.indexOf('\\n')) >= 0) {",
      "      const line = buffer.slice(0, newline);",
      "      buffer = buffer.slice(newline + 1);",
      "      const message = JSON.parse(line);",
      "      if (message.type === 'subagent007.input_response' && message.request_id === requestId) {",
      "        writeEvent({ type: 'subagent007.input_response_accepted', run_id: request.runId, request_id: requestId, response_id: message.response_id });",
      "        writeFinal('INPUT ACCEPTED');",
      "        process.stdin.pause();",
      "        process.exit(0);",
      "      }",
      "    }",
      "  });",
      "}",
      "function callRecursiveDelegate(params, callerOverride) {",
      "  const control = request.recursiveControl;",
      "  if (!control) return Promise.resolve({ status: 'rejected', kind: 'recursive_delegate_rejected', success: false, error_class: 'validation_error', reason_code: 'recursive_control_invalid', message: 'missing recursive control' });",
      "  const id = 'fake-' + process.pid + '-' + Date.now();",
      "  const payload = {",
      "    id,",
      "    token: control.token,",
      "    method: 'delegate',",
      "    caller: callerOverride || {",
      "      parent_run_id: control.parent_run_id,",
      "      root_run_id: control.root_run_id,",
      "      recursion_depth: control.recursion_depth",
      "    },",
      "    params",
      "  };",
      "  return new Promise((resolve, reject) => {",
      "    const socket = net.createConnection(control.socket_path);",
      "    let buffer = '';",
      "    socket.setEncoding('utf8');",
      "    socket.once('connect', () => socket.write(JSON.stringify(payload) + '\\n'));",
      "    socket.once('error', reject);",
      "    socket.on('data', (chunk) => {",
      "      buffer += chunk;",
      "      const newlineIndex = buffer.indexOf('\\n');",
      "      if (newlineIndex === -1) return;",
      "      socket.end();",
      "      const response = JSON.parse(buffer.slice(0, newlineIndex));",
      "      if (response.id !== id) throw new Error('recursive response id mismatch');",
      "      resolve(response.ok ? response.result : { status: 'rejected', kind: 'recursive_delegate_rejected', success: false, error_class: 'validation_error', reason_code: response.error.reason_code, message: response.error.message });",
      "    });",
      "  });",
      "}",
      "if (request.prompt.includes('FAIL_EXIT')) {",
      "  process.stderr.write('FAKE PI FAILURE\\n');",
      "  process.exit(42);",
      "} else if (request.prompt.includes('TIMEOUT_ASSISTANT_EVENT')) {",
      "  writeEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'PUBLIC PARTIAL ASSISTANT' }] } });",
      "  setInterval(() => {}, 1000);",
      "} else if (request.prompt.includes('HEARTBEAT_SLEEP')) {",
      "  setTimeout(() => writeFinal('HEARTBEAT DONE'), 160);",
      "} else if (request.prompt.includes('CLEAN_EXIT_NO_FINAL')) {",
      "  writeEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'PUBLIC DIAGNOSTIC ONLY' }] } });",
      "} else if (request.prompt.includes('CANCEL_WAIT')) {",
      "  setInterval(() => {}, 1000);",
      "} else if (request.prompt.includes('REQUEST_INPUT_WAIT')) {",
      "  writeInputRequest();",
      "} else if (request.prompt.includes('RECURSIVE_DELEGATE_WAIT0_CHILD_FINISH')) {",
      "  callRecursiveDelegate({ prompt: 'HEARTBEAT_SLEEP', cwd: request.cwd, wait_ms: 0 }).then((result) => {",
      "    writeFinal(JSON.stringify({ delegated: result }));",
      "  }).catch((error) => {",
      "    process.stderr.write('FAKE RECURSIVE DELEGATE FAILURE: ' + (error && error.stack ? error.stack : String(error)) + '\\n');",
      "    process.exitCode = 1;",
      "  });",
      "} else if (request.prompt.includes('RECURSIVE_DELEGATE_TWO_HOP')) {",
      "  callRecursiveDelegate({ prompt: 'RECURSIVE_DELEGATE_FAST', cwd: request.cwd, wait_ms: 1000 }).then((result) => {",
      "    writeFinal(JSON.stringify({ delegated: result }));",
      "  }).catch((error) => {",
      "    process.stderr.write('FAKE RECURSIVE DELEGATE FAILURE: ' + (error && error.stack ? error.stack : String(error)) + '\\n');",
      "    process.exitCode = 1;",
      "  });",
      "} else if (request.prompt.includes('RECURSIVE_DELEGATE_FAST') || request.prompt.includes('RECURSIVE_DELEGATE_DEPTH_LIMIT')) {",
      "  callRecursiveDelegate({ prompt: 'FAST', cwd: request.cwd, wait_ms: 1000 }).then((result) => {",
      "    writeFinal(JSON.stringify({ delegated: result }));",
      "  }).catch((error) => {",
      "    process.stderr.write('FAKE RECURSIVE DELEGATE FAILURE: ' + (error && error.stack ? error.stack : String(error)) + '\\n');",
      "    process.exitCode = 1;",
      "  });",
      "} else if (request.prompt.includes('RECURSIVE_DELEGATE_FORGED_PARENT')) {",
      "  callRecursiveDelegate({ prompt: 'FAST', cwd: request.cwd, wait_ms: 1000 }, {",
      "    parent_run_id: request.runId + '-forged',",
      "    root_run_id: request.runId,",
      "    recursion_depth: 0",
      "  }).then((result) => {",
      "    writeFinal(JSON.stringify({ delegated: result }));",
      "  }).catch((error) => {",
      "    process.stderr.write('FAKE RECURSIVE DELEGATE FAILURE: ' + (error && error.stack ? error.stack : String(error)) + '\\n');",
      "    process.exitCode = 1;",
      "  });",
      "} else if (request.prompt.includes('PACKET_INCONCLUSIVE')) {",
      "  writeFinal(packetFinal({ verdict: 'inconclusive', summary: 'not ready', findings: [], blockers: ['needs evidence'], next_step: 'repair' }));",
      "} else if (request.prompt.includes('PACKET_VALID_WITH_CLOSURE')) {",
      "  writeFinal(packetFinal({ verdict: 'ready', summary: 'ok with closure', findings: [], blockers: [], next_step: 'done', closure: { canonical_closure_source: 'scripts/run-observed-mcp-probe.mjs', artifact_roles: [{ path: 'scripts/run-observed-mcp-probe.mjs', role: 'fake packet producer' }], validation: ['closure shape parsed'], claim_ceiling: 'fake child packet only' } }));",
      "} else if (request.prompt.includes('PACKET_INVALID_CLOSURE_SHAPE')) {",
      "  writeFinal(packetFinal({ verdict: 'ready', summary: 'bad closure shape', findings: [], blockers: [], next_step: 'repair closure', closure: { canonical_closure_source: 'scripts/run-observed-mcp-probe.mjs', artifact_roles: { 'scripts/run-observed-mcp-probe.mjs': 'fake packet producer' }, validation: 'closure shape parsed', claim_ceiling: 'fake child packet only' } }));",
      "} else if (request.prompt.includes('RAW_THINKING_TRANSCRIPT')) {",
      "  writeEvent({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'user prompt' }] } });",
      "  writeEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'SECRET_THINKING_SHOULD_NOT_LEAK' } });",
      "  writeEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'PUBLIC ASSISTANT TEXT' }] } });",
      "} else {",
      "  writeFinal('FAST FINAL');",
      "}",
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(childPath, 0o755);
  return { childPath, logPath };
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

function requireScopedDeterministicProbe(mode) {
  if (mode !== "protocol-deterministic") {
    return;
  }
  const failureLogPath = process.env.SUBAGENT007_FAILURE_LOG_PATH?.trim();
  const recordSource = process.env.SUBAGENT007_RECORD_SOURCE?.trim();
  const campaignId = process.env.SUBAGENT007_CAMPAIGN_ID?.trim();
  if (!failureLogPath) {
    throw new Error(
      "protocol-deterministic observed probes require SUBAGENT007_FAILURE_LOG_PATH so fake failures cannot write the default production ledger",
    );
  }
  if (recordSource !== "test" && !campaignId) {
    throw new Error(
      "protocol-deterministic observed probes require SUBAGENT007_RECORD_SOURCE=test or SUBAGENT007_CAMPAIGN_ID so fake failures are not production-shaped",
    );
  }
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

async function appendLedger(ledgerPath, evidenceClass, event) {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  const record = {
    schema_version: 1,
    event_id: randomUUID(),
    timestamp: new Date().toISOString(),
    campaign_id: process.env.SUBAGENT007_CAMPAIGN_ID ?? null,
    evidence_class: evidenceClass,
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

async function waitForFailureRecord(predicate, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const matching = (await readFailureRecords()).find(predicate);
    if (matching || Date.now() >= deadline) return matching;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function responseText(response) {
  return Array.isArray(response.content)
    ? response.content
        .map((entry) => (entry?.type === "text" && typeof entry.text === "string" ? entry.text : ""))
        .join("\n")
    : "";
}

function forbiddenFieldPaths(value, forbiddenFields, pathParts = []) {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      forbiddenFieldPaths(entry, forbiddenFields, [...pathParts, String(index)]),
    );
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const path = [...pathParts, key];
    return [
      ...(forbiddenFields.has(key) || key.includes("thinking_level") ? [path.join(".")] : []),
      ...forbiddenFieldPaths(child, forbiddenFields, path),
    ];
  });
}

function isSchemaError(response) {
  return response?.isError === true && /Input validation error/.test(responseText(response));
}

function toolInputDescription(tool, fieldName) {
  const properties = tool?.inputSchema?.properties;
  const field = properties && typeof properties === "object" ? properties[fieldName] : undefined;
  return typeof field?.description === "string" ? field.description : "";
}

function toolListingSummary(response) {
  const tools = Array.isArray(response?.tools) ? response.tools : [];
  const toolNames = unique(tools.map((tool) => tool?.name).filter((name) => typeof name === "string"));
  const missingTools = EXPECTED_PUBLIC_TOOLS.filter((name) => !toolNames.includes(name));
  const unexpectedTools = toolNames.filter((name) => !EXPECTED_PUBLIC_TOOLS.includes(name));
  const skillGuidance = SKILL_BINDING_TOOLS.map((toolName) => {
    const tool = tools.find((entry) => entry?.name === toolName);
    const skillNameDescription = toolInputDescription(tool, "skill_name");
    const skillDescription = toolInputDescription(tool, "skill");
    return {
      tool: toolName,
      skill_name_preferred: /prefer/i.test(skillNameDescription),
      skill_legacy_alias: /legacy alias/i.test(skillDescription),
      descriptions_distinct: skillNameDescription !== "" &&
        skillDescription !== "" &&
        skillNameDescription !== skillDescription,
    };
  });
  const unclearSkillTools = skillGuidance
    .filter((entry) =>
      !entry.skill_name_preferred ||
      !entry.skill_legacy_alias ||
      !entry.descriptions_distinct
    )
    .map((entry) => entry.tool);
  const answerRunInput = tools.find((tool) => tool?.name === "answer_run_input");
  const startSessionRun = tools.find((tool) => tool?.name === "start_session_run");
  const runSubagentSession = tools.find((tool) => tool?.name === "run_subagent_session");
  const includesAll = (text, patterns) => patterns.every((pattern) => pattern.test(text));
  const operationalGuidance = {
    input_receipt: includesAll(answerRunInput?.description ?? "", [/stable response_id/i, /receipt/i, /exact live retry/i, /without redelivery/i]),
    session_default_and_scope: includesAll(startSessionRun?.description ?? "", [/resume_or_new/i, /scoped to cwd/i, /skill binding/i]),
    session_wrapper: includesAll(runSubagentSession?.description ?? "", [/synchronous compatibility wrapper/i, /prefer start_session_run/i]),
  };
  const effectProfileSchemaExact =
    CONSTRAINED_RUN_TOOLS.every((toolName) => {
      const properties = tools.find((tool) => tool?.name === toolName)?.inputSchema?.properties ?? {};
      return Object.hasOwn(properties, "effect_profile") && Object.hasOwn(properties, "expected_skill_sha256");
    }) &&
    NAMED_SESSION_TOOLS.every((toolName) => {
      const properties = tools.find((tool) => tool?.name === toolName)?.inputSchema?.properties ?? {};
      return !Object.hasOwn(properties, "effect_profile") && !Object.hasOwn(properties, "expected_skill_sha256");
    });
  return {
    tool_count: toolNames.length,
    tool_names: toolNames,
    expected_tool_count: EXPECTED_PUBLIC_TOOLS.length,
    missing_tools: missingTools,
    unexpected_tools: unexpectedTools,
    tool_surface_complete: missingTools.length === 0,
    tool_surface_exact: missingTools.length === 0 && unexpectedTools.length === 0,
    skill_alias_guidance_clear: unclearSkillTools.length === 0,
    effect_profile_schema_exact: effectProfileSchemaExact,
    unclear_skill_alias_tools: unclearSkillTools,
    operational_guidance_clear: Object.values(operationalGuidance).every(Boolean),
    unclear_operational_guidance: Object.entries(operationalGuidance)
      .filter(([, clear]) => !clear)
      .map(([name]) => name),
  };
}

function responseSummary(response) {
  const structured = response.structuredContent && typeof response.structuredContent === "object"
    ? response.structuredContent
    : {};
  const recentEvents = Array.isArray(structured.recent_events) ? structured.recent_events : [];
  const recursiveChildStartedEvents = recentEvents.filter((event) =>
    event?.event === "recursive_child_started" &&
      typeof event?.metadata?.child_run_id === "string"
  );
  const recursiveChildFinishedEvents = recentEvents.filter((event) =>
    event?.event === "recursive_child_finished" &&
      typeof event?.metadata?.child_run_id === "string" &&
      typeof event?.metadata?.status === "string"
  );
  const recursiveChildEventSummary = (event) => {
    const metadata = event?.metadata ?? {};
    return {
      child_run_id: metadata.child_run_id,
      parent_run_id: metadata.parent_run_id,
      root_run_id: metadata.root_run_id,
      recursion_depth: metadata.recursion_depth,
      ...(typeof metadata.status === "string" ? { status: metadata.status } : {}),
      ...(typeof metadata.success === "boolean" ? { success: metadata.success } : {}),
    };
  };
  const recursiveChildStartedSummaries = recursiveChildStartedEvents.map(recursiveChildEventSummary);
  const recursiveChildFinishedSummaries = recursiveChildFinishedEvents.map(recursiveChildEventSummary);
  const latestRecursiveChildFinished = recursiveChildFinishedSummaries.at(-1);
  const forbiddenPublicCalibrationFields = forbiddenFieldPaths(structured, FORBIDDEN_PUBLIC_CALIBRATION_FIELDS);
  return {
    is_error: response.isError === true,
    public_calibration_fields_absent: forbiddenPublicCalibrationFields.length === 0,
    forbidden_public_calibration_fields: forbiddenPublicCalibrationFields,
    success: typeof structured.success === "boolean" ? structured.success : null,
    status: typeof structured.status === "string" ? structured.status : null,
    kind: typeof structured.kind === "string" ? structured.kind : null,
    ready: typeof structured.ready === "boolean" ? structured.ready : undefined,
    contract_name: typeof structured.contract_name === "string" ? structured.contract_name : undefined,
    error_class: typeof structured.error_class === "string" ? structured.error_class : undefined,
    reason_code: typeof structured.reason_code === "string" ? structured.reason_code : undefined,
    run_id: typeof structured.run_id === "string" ? structured.run_id : undefined,
    parent_run_id: typeof structured.parent_run_id === "string" ? structured.parent_run_id : undefined,
    root_run_id: typeof structured.root_run_id === "string" ? structured.root_run_id : undefined,
    recursion_depth: typeof structured.recursion_depth === "number" ? structured.recursion_depth : undefined,
    child_run_ids: Array.isArray(structured.child_run_ids)
      ? structured.child_run_ids.filter((value) => typeof value === "string")
      : undefined,
    recursive_child_started_event: recursiveChildStartedEvents.length > 0,
    recursive_child_finished_event: recursiveChildFinishedEvents.length > 0,
    recursive_child_started_events: recursiveChildStartedSummaries,
    recursive_child_finished_events: recursiveChildFinishedSummaries,
    recursive_child_finished_status: typeof latestRecursiveChildFinished?.status === "string"
      ? latestRecursiveChildFinished.status
      : undefined,
    recursive_child_finished_success: typeof latestRecursiveChildFinished?.success === "boolean"
      ? latestRecursiveChildFinished.success
      : undefined,
    child_started: typeof structured.child_started === "boolean" ? structured.child_started : undefined,
    active_phase: typeof structured.active_phase === "string" ? structured.active_phase : undefined,
    exit_code: typeof structured.exit_code === "number" || structured.exit_code === null
      ? structured.exit_code
      : undefined,
    timed_out: typeof structured.timed_out === "boolean" ? structured.timed_out : undefined,
    requested_output_mode: typeof structured.requested_output_mode === "string"
      ? structured.requested_output_mode
      : undefined,
    written_output_mode: typeof structured.written_output_mode === "string"
      ? structured.written_output_mode
      : undefined,
    output_reference_modes: Array.isArray(structured.output_references)
      ? structured.output_references
          .map((reference) => reference?.output_mode)
          .filter((value) => typeof value === "string")
      : [],
    packet_parse_status: typeof structured.packet_parse_status === "string"
      ? structured.packet_parse_status
      : undefined,
    packet_error: typeof structured.packet_error === "string" ? structured.packet_error : undefined,
    packet_closure_valid: Boolean(structured.claimed_packet?.closure),
    packet_closure_invalid: typeof structured.packet_error === "string" && /closure/i.test(structured.packet_error),
    cancellation_settled: Array.isArray(structured.recent_events) &&
      structured.recent_events.some((event) => event?.event === "cancellation_settled"),
    timeout_recovery_hint: typeof structured.timeout_recovery_hint === "string" &&
      structured.timeout_recovery_hint.length > 0,
    input_response_receipt: structured.input_response_receipt,
    input_request_count: Array.isArray(structured.input_requests) ? structured.input_requests.length : undefined,
    pending_input_count: Array.isArray(structured.input_requests)
      ? structured.input_requests.filter((request) => request?.status === "pending").length
      : undefined,
    session_established: typeof structured.session_established === "boolean"
      ? structured.session_established
      : undefined,
    created_or_resumed: typeof structured.created_or_resumed === "string"
      ? structured.created_or_resumed
      : undefined,
    attempt_session_established: typeof structured.attempt_session_established === "boolean"
      ? structured.attempt_session_established
      : undefined,
    auto_promoted_from: structured.auto_promoted_from === "run_subagent"
      ? structured.auto_promoted_from
      : undefined,
    promotion_reason_code: typeof structured.promotion_reason_code === "string"
      ? structured.promotion_reason_code
      : undefined,
    output_path: typeof structured.output_path === "string" ? structured.output_path : undefined,
  };
}

function isRecursiveDelegateScenario(scenario) {
  return Object.hasOwn(RECURSIVE_DELEGATE_SCENARIO_PROMPTS, scenario);
}

async function recursiveDelegateOutputSummary(summary) {
  if (typeof summary.output_path !== "string") {
    return {};
  }
  try {
    const outputText = await fs.readFile(summary.output_path, "utf8");
    const output = JSON.parse(outputText);
    const delegated = output?.delegated && typeof output.delegated === "object"
      ? output.delegated
      : null;
    if (!delegated) {
      return {};
    }
    const delegatedRunId = typeof delegated.run_id === "string" ? delegated.run_id : undefined;
    return {
      delegated_status: typeof delegated.status === "string" ? delegated.status : undefined,
      delegated_success: typeof delegated.success === "boolean" ? delegated.success : undefined,
      delegated_kind: typeof delegated.kind === "string" ? delegated.kind : undefined,
      delegated_error_class: typeof delegated.error_class === "string" ? delegated.error_class : undefined,
      delegated_reason_code: typeof delegated.reason_code === "string" ? delegated.reason_code : undefined,
      delegated_run_id: delegatedRunId,
      delegated_parent_run_id: typeof delegated.parent_run_id === "string" ? delegated.parent_run_id : undefined,
      delegated_root_run_id: typeof delegated.root_run_id === "string" ? delegated.root_run_id : undefined,
      delegated_recursion_depth: typeof delegated.recursion_depth === "number"
        ? delegated.recursion_depth
        : undefined,
      root_child_run_count: Array.isArray(summary.child_run_ids) ? summary.child_run_ids.length : undefined,
      root_child_contains_delegated: Boolean(
        delegatedRunId &&
          Array.isArray(summary.child_run_ids) &&
          summary.child_run_ids.includes(delegatedRunId),
      ),
    };
  } catch {
    return {};
  }
}

async function responseSummaryForScenario(response, scenario) {
  const summary = responseSummary(response);
  if (scenario === "tool-listing") {
    return {
      ...summary,
      ...toolListingSummary(response),
    };
  }
  if (isRecursiveDelegateScenario(scenario)) {
    return {
      ...summary,
      ...(await recursiveDelegateOutputSummary(summary)),
    };
  }
  if (scenario !== "transcript-redaction" || typeof summary.output_path !== "string") {
    return summary;
  }
  try {
    const output = await fs.readFile(summary.output_path, "utf8");
    return {
      ...summary,
      transcript_redacted:
        output.includes("PUBLIC ASSISTANT TEXT") &&
        !/SECRET_THINKING_SHOULD_NOT_LEAK|SECRET_TRANSCRIPT_PROMPT_SHOULD_NOT_LEAK|RAW_THINKING_TRANSCRIPT|thinking_delta|assistantMessageEvent/.test(output),
    };
  } catch {
    return { ...summary, transcript_redacted: false };
  }
}

function runSubagentScenarioCall(cwd, prompt, extraArgs = {}) {
  return {
    tool: "run_subagent",
    args: {
      cwd,
      prompt,
      run_kind: "quick_noninteractive",
      ...extraArgs,
    },
  };
}

function scenarioCall(scenario, cwd) {
  if (scenario === "tool-listing") {
    return {
      tool: "__list_tools",
      args: {},
    };
  }
  if (scenario === "model-listing") {
    return {
      tool: "list_model_classes",
      args: {},
    };
  }
  if (scenario === "model-listing-alias") {
    return {
      tool: "list_allowed_models",
      args: {},
    };
  }
  if (scenario === "run-contract") {
    return {
      tool: "get_run_contract",
      args: {},
    };
  }
  if (scenario === "runtime-readiness") {
    return {
      tool: "get_runtime_readiness",
      args: {
        expected_contract_name: "subagent007.durable_run",
        expected_contract_version: 2,
        source_state_policy: "allow_unknown",
      },
    };
  }
  if (scenario === "success") {
    return runSubagentScenarioCall(cwd, "FAST");
  }
  if (scenario === "auto-promotion") {
    return runSubagentScenarioCall(cwd, "Investigate coverage gaps");
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
    return runSubagentScenarioCall("relative-path", "SECRET_LEDGER_PROMPT_HANDLER_VALIDATION");
  }
  if (scenario === "child-failure") {
    return runSubagentScenarioCall(cwd, "FAIL_EXIT SECRET_LEDGER_PROMPT_CHILD_FAILURE", {
      output_mode: "transcript",
    });
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
  if (scenario === "transcript-redaction") {
    return runSubagentScenarioCall(cwd, "RAW_THINKING_TRANSCRIPT SECRET_TRANSCRIPT_PROMPT_SHOULD_NOT_LEAK", {
      output_mode: "transcript",
    });
  }
  if (scenario === "timeout-recovery") {
    return runSubagentScenarioCall(cwd, "TIMEOUT_ASSISTANT_EVENT", {
      output_mode: "transcript",
    });
  }
  if (scenario === "session-valid-closure") {
    return {
      tool: "run_subagent_session",
      args: {
        cwd,
        prompt: "PACKET_VALID_WITH_CLOSURE",
        session_key: `campaign-probe-valid:${Date.now()}:${randomUUID().slice(0, 8)}`,
        resume_mode: "new",
        packet_policy: "required",
      },
    };
  }
  if (scenario === "session-invalid-closure") {
    return {
      tool: "run_subagent_session",
      args: {
        cwd,
        prompt: "PACKET_INVALID_CLOSURE_SHAPE",
        session_key: `campaign-probe-invalid:${Date.now()}:${randomUUID().slice(0, 8)}`,
        resume_mode: "new",
        packet_policy: "required",
      },
    };
  }
  if (scenario === "installed-pi-integration") {
    return runSubagentScenarioCall(cwd, "Reply with the single word READY.");
  }
  throw new Error(`unknown scenario: ${scenario}`);
}

async function runCall(client, ledgerPath, evidenceClass, scenario, call) {
  const callId = randomUUID();
  await appendLedger(ledgerPath, evidenceClass, {
    event: "call_started",
    call_id: callId,
    scenario,
    tool: call.tool,
    argument_shape: redactArguments(call.args),
  });

  const failuresBefore = await readFailureRecords();
  let response;
  let observedSummary = null;
  try {
    response = call.tool === "__list_tools"
      ? await client.listTools()
      : await client.callTool({
          name: call.tool,
          arguments: call.args,
        });
  } catch (error) {
    await appendLedger(ledgerPath, evidenceClass, {
      event: "call_handler_error",
      call_id: callId,
      scenario,
      tool: call.tool,
      error_class: error instanceof Error ? error.name : typeof error,
    });
    response = null;
  }

  if (response) {
    const summary = await responseSummaryForScenario(response, scenario);
    observedSummary = summary;
    if (isSchemaError(response)) {
      await appendLedger(ledgerPath, evidenceClass, {
        event: "call_schema_error",
        call_id: callId,
        scenario,
        tool: call.tool,
        result: summary,
      });
    } else if (summary.kind === "preflight_rejected") {
      await appendLedger(ledgerPath, evidenceClass, {
        event: "call_preflight_rejected",
        call_id: callId,
        scenario,
        tool: call.tool,
        result: summary,
      });
    } else if (summary.kind === "operation_rejected") {
      await appendLedger(ledgerPath, evidenceClass, {
        event: "call_operation_rejected",
        call_id: callId,
        scenario,
        tool: call.tool,
        result: summary,
      });
    } else if (response.isError === true) {
      await appendLedger(ledgerPath, evidenceClass, {
        event: "call_handler_error",
        call_id: callId,
        scenario,
        tool: call.tool,
        result: summary,
      });
    } else {
      await appendLedger(ledgerPath, evidenceClass, {
        event: "call_result",
        call_id: callId,
        scenario,
        tool: call.tool,
        result: summary,
      });
    }
  }

  if (
    observedSummary &&
    (observedSummary.success === false ||
      observedSummary.status === "failed" ||
      observedSummary.status === "timed_out" ||
      observedSummary.kind === "preflight_rejected" ||
      observedSummary.kind === "operation_rejected")
  ) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const failuresAfter = await readFailureRecords();
  const delta = failuresAfter.slice(failuresBefore.length);
  const forbiddenFailureLogCalibrationFields = forbiddenFieldPaths(delta, FORBIDDEN_FAILURE_LOG_CALIBRATION_FIELDS);
  if (observedSummary) {
    observedSummary.failure_log_calibration_fields_absent = forbiddenFailureLogCalibrationFields.length === 0;
    observedSummary.forbidden_failure_log_calibration_fields = forbiddenFailureLogCalibrationFields;
  }
  if (delta.length > 0) {
    await appendLedger(ledgerPath, evidenceClass, {
      event: "failure_log_delta",
      call_id: callId,
      scenario,
      tool: call.tool,
      delta_count: delta.length,
      failure_classes: uniqueRecordValues(delta, "failure_class"),
      reason_codes: uniqueRecordValues(delta, "reason_code"),
      tools: uniqueRecordValues(delta, "tool"),
      failure_log_calibration_fields_absent: forbiddenFailureLogCalibrationFields.length === 0,
      forbidden_failure_log_calibration_fields: forbiddenFailureLogCalibrationFields,
    });
  }

  return {
    call_id: callId,
    scenario,
    tool: call.tool,
    response: observedSummary,
    failure_log_delta_count: delta.length,
  };
}

async function waitForRun(client, ledgerPath, evidenceClass, scenario, runId, predicate, options = {}) {
  const deadline = Date.now() + 5000;
  let latest;
  while (Date.now() < deadline) {
    latest = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "get_run",
      args: { run_id: runId },
    });
    if (predicate(latest.response)) {
      return latest;
    }
    if (options.stopOnTerminal !== false && ["completed", "failed", "cancelled"].includes(latest.response?.status)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return latest;
}

async function runScenario(client, ledgerPath, evidenceClass, scenario, cwd) {
  if (scenario === "auto-promotion") {
    const started = await runCall(client, ledgerPath, evidenceClass, scenario, scenarioCall(scenario, cwd));
    const terminal = started.response?.run_id
      ? await waitForRun(client, ledgerPath, evidenceClass, scenario, started.response.run_id, (response) =>
          response?.status === "completed",
        )
      : started;
    return {
      ...terminal,
      tool: "run_subagent",
      response: {
        ...(terminal.response ?? {}),
        auto_promoted_from: started.response?.auto_promoted_from,
        promotion_reason_code: started.response?.promotion_reason_code,
        polled: true,
      },
      failure_log_delta_count: started.failure_log_delta_count + (terminal.failure_log_delta_count ?? 0),
    };
  }

  if (scenario === "start-run-async-polling") {
    const started = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_run",
      args: { cwd, prompt: "HEARTBEAT_SLEEP" },
    });
    const terminal = started.response?.run_id
      ? await waitForRun(client, ledgerPath, evidenceClass, scenario, started.response.run_id, (response) =>
          response?.status === "completed",
        )
      : started;
    return {
      ...terminal,
      tool: "start_run",
      response: {
        ...(terminal.response ?? {}),
        polled: true,
      },
      failure_log_delta_count: started.failure_log_delta_count + (terminal.failure_log_delta_count ?? 0),
    };
  }

  if (scenario === "missing-final-output") {
    const started = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_run",
      args: { cwd, prompt: "CLEAN_EXIT_NO_FINAL", output_mode: "final" },
    });
    const terminal = started.response?.run_id
      ? await waitForRun(client, ledgerPath, evidenceClass, scenario, started.response.run_id, (response) =>
          response?.status === "failed",
        )
      : started;
    return {
      ...terminal,
      tool: "start_run",
      response: {
        ...(terminal.response ?? {}),
        polled: true,
      },
      failure_log_delta_count: started.failure_log_delta_count + (terminal.failure_log_delta_count ?? 0),
    };
  }

  if (scenario === "local-capacity-exhaustion") {
    const started = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_run",
      args: { cwd, prompt: "CANCEL_WAIT", timeout_ms: 6000 },
    });
    if (!started.response?.run_id) {
      return started;
    }
    const rejected = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_run",
      args: { cwd, prompt: "FAST", timeout_ms: 6000 },
    });
    const cancelled = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "cancel_run",
      args: { run_id: started.response.run_id },
    });
    const settled = await waitForRun(client, ledgerPath, evidenceClass, scenario, started.response.run_id, (response) =>
      response?.status === "cancelled",
    );
    const afterRelease = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_run",
      args: { cwd, prompt: "FAST", timeout_ms: 6000 },
    });
    const afterReleaseTerminal = afterRelease.response?.run_id
      ? await waitForRun(client, ledgerPath, evidenceClass, scenario, afterRelease.response.run_id, (response) =>
          response?.status === "completed",
        )
      : afterRelease;
    return {
      ...rejected,
      tool: "start_run",
      response: {
        ...(rejected.response ?? {}),
        capacity_rejected:
          rejected.response?.kind === "preflight_rejected" &&
          rejected.response?.reason_code === "local_capacity_exhausted",
        cleanup_status: settled.response?.status ?? cancelled.response?.status,
        after_release_status: afterReleaseTerminal.response?.status,
        after_release_success: afterReleaseTerminal.response?.success,
      },
      failure_log_delta_count:
        started.failure_log_delta_count +
        rejected.failure_log_delta_count +
        cancelled.failure_log_delta_count +
        (settled.failure_log_delta_count ?? 0) +
        afterRelease.failure_log_delta_count +
        (afterReleaseTerminal.failure_log_delta_count ?? 0),
    };
  }

  if (scenario === "queue-lifecycle") {
    const active = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_run",
      args: { cwd, prompt: "CANCEL_WAIT", timeout_ms: 6000 },
    });
    const queued = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_run",
      args: { cwd, prompt: "FAST", timeout_ms: 6000 },
    });
    const overflow = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_run",
      args: { cwd, prompt: "FAST", timeout_ms: 6000 },
    });
    const activeCancelled = active.response?.run_id
      ? await runCall(client, ledgerPath, evidenceClass, scenario, { tool: "cancel_run", args: { run_id: active.response.run_id } })
      : active;
    const activeTerminal = active.response?.run_id
      ? await waitForRun(client, ledgerPath, evidenceClass, scenario, active.response.run_id, (response) => response?.status === "cancelled")
      : activeCancelled;
    const promoted = queued.response?.run_id
      ? await waitForRun(client, ledgerPath, evidenceClass, scenario, queued.response.run_id, (response) => response?.status === "completed")
      : queued;
    const cancellationActive = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_run",
      args: { cwd, prompt: "CANCEL_WAIT", timeout_ms: 6000 },
    });
    const queuedForCancellation = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_run",
      args: { cwd, prompt: "FAST", timeout_ms: 6000 },
    });
    const queuedCancelled = queuedForCancellation.response?.run_id
      ? await runCall(client, ledgerPath, evidenceClass, scenario, { tool: "cancel_run", args: { run_id: queuedForCancellation.response.run_id } })
      : queuedForCancellation;
    const queuedTerminal = queuedForCancellation.response?.run_id
      ? await waitForRun(client, ledgerPath, evidenceClass, scenario, queuedForCancellation.response.run_id, (response) => response?.status === "cancelled")
      : queuedCancelled;
    const cancellationActiveCancelled = cancellationActive.response?.run_id
      ? await runCall(client, ledgerPath, evidenceClass, scenario, { tool: "cancel_run", args: { run_id: cancellationActive.response.run_id } })
      : cancellationActive;
    const cancellationActiveTerminal = cancellationActive.response?.run_id
      ? await waitForRun(client, ledgerPath, evidenceClass, scenario, cancellationActive.response.run_id, (response) => response?.status === "cancelled")
      : cancellationActiveCancelled;
    return {
      ...promoted,
      tool: "start_run",
      response: {
        ...(promoted.response ?? {}),
        queue_lifecycle:
          queued.response?.status === "working" &&
          queued.response?.active_phase === "queued" &&
          queued.response?.child_started === false &&
          overflow.response?.reason_code === "local_queue_exhausted" &&
          activeTerminal.response?.status === "cancelled" &&
          promoted.response?.status === "completed" &&
          queuedForCancellation.response?.active_phase === "queued" &&
          queuedTerminal.response?.status === "cancelled" &&
          cancellationActiveTerminal.response?.status === "cancelled",
      },
      failure_log_delta_count: active.failure_log_delta_count + queued.failure_log_delta_count + overflow.failure_log_delta_count +
        activeCancelled.failure_log_delta_count + (activeTerminal.failure_log_delta_count ?? 0) + (promoted.failure_log_delta_count ?? 0) +
        cancellationActive.failure_log_delta_count + queuedForCancellation.failure_log_delta_count + queuedCancelled.failure_log_delta_count +
        (queuedTerminal.failure_log_delta_count ?? 0) + cancellationActiveCancelled.failure_log_delta_count +
        (cancellationActiveTerminal.failure_log_delta_count ?? 0),
    };
  }

  if (scenario === "start-session-run-async-polling") {
    const started = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_session_run",
      args: {
        cwd,
        prompt: "PACKET_VALID_WITH_CLOSURE",
        session_key: `campaign-probe-start-session:${Date.now()}:${randomUUID().slice(0, 8)}`,
        resume_mode: "new",
        packet_policy: "required",
      },
    });
    const terminal = started.response?.run_id
      ? await waitForRun(client, ledgerPath, evidenceClass, scenario, started.response.run_id, (response) =>
          response?.status === "completed",
        )
      : started;
    return {
      ...terminal,
      tool: "start_session_run",
      response: {
        ...(terminal.response ?? {}),
        polled: true,
      },
      failure_log_delta_count: started.failure_log_delta_count + (terminal.failure_log_delta_count ?? 0),
    };
  }

  if (scenario === "session-resume") {
    const sessionKey = `campaign-probe-resume:${Date.now()}:${randomUUID().slice(0, 8)}`;
    const created = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_session_run",
      args: { cwd, prompt: "FAST", session_key: sessionKey, resume_mode: "new", packet_policy: "none" },
    });
    const createdTerminal = created.response?.run_id
      ? await waitForRun(client, ledgerPath, evidenceClass, scenario, created.response.run_id, (response) => response?.status === "completed")
      : created;
    const resumed = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_session_run",
      args: { cwd, prompt: "FAST", session_key: sessionKey, resume_mode: "require_existing", packet_policy: "none" },
    });
    const terminal = resumed.response?.run_id
      ? await waitForRun(client, ledgerPath, evidenceClass, scenario, resumed.response.run_id, (response) => response?.status === "completed")
      : resumed;
    return {
      ...terminal,
      tool: "start_session_run",
      response: {
        ...(terminal.response ?? {}),
        session_resume: createdTerminal.response?.session_established === true &&
          terminal.response?.session_established === true &&
          terminal.response?.created_or_resumed === "resumed",
      },
      failure_log_delta_count: created.failure_log_delta_count + (createdTerminal.failure_log_delta_count ?? 0) +
        resumed.failure_log_delta_count + (terminal.failure_log_delta_count ?? 0),
    };
  }

  if (scenario === "start-session-packet-failure") {
    const started = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_session_run",
      args: {
        cwd,
        prompt: "PACKET_INCONCLUSIVE",
        session_key: `campaign-probe-start-session-packet:${Date.now()}:${randomUUID().slice(0, 8)}`,
        resume_mode: "new",
        packet_policy: "required",
      },
    });
    const terminal = started.response?.run_id
      ? await waitForRun(client, ledgerPath, evidenceClass, scenario, started.response.run_id, (response) =>
          response?.status === "failed",
        )
      : started;
    const matchingFailure = await waitForFailureRecord((record) =>
      record?.run_id === started.response?.run_id &&
        record?.reason_code === "packet_required_not_ready"
    );
    return {
      ...terminal,
      tool: "start_session_run",
      response: {
        ...(terminal.response ?? {}),
        polled: true,
        failure_log_matching_tool: matchingFailure?.tool,
        failure_log_matching_task_kind: matchingFailure?.task_kind,
        failure_log_matching_run_id: matchingFailure?.run_id,
      },
      failure_log_delta_count: started.failure_log_delta_count + (terminal.failure_log_delta_count ?? 0),
    };
  }

  if (scenario === "start-session-require-existing-missing") {
    return runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_session_run",
      args: {
        cwd,
        prompt: "FAST",
        session_key: `campaign-probe-missing-start-session:${Date.now()}:${randomUUID().slice(0, 8)}`,
        resume_mode: "require_existing",
        packet_policy: "none",
      },
    });
  }

  if (scenario === "run-subagent-session-require-existing-missing") {
    return runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "run_subagent_session",
      args: {
        cwd,
        prompt: "FAST",
        session_key: `campaign-probe-missing-run-session:${Date.now()}:${randomUUID().slice(0, 8)}`,
        resume_mode: "require_existing",
        packet_policy: "none",
      },
    });
  }

  if (scenario === "caller-input") {
    const started = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_run",
      args: { cwd, prompt: "REQUEST_INPUT_WAIT" },
    });
    if (!started.response?.run_id) {
      return started;
    }
    const pending = await waitForRun(client, ledgerPath, evidenceClass, scenario, started.response.run_id, (response) =>
      (response?.pending_input_count ?? 0) > 0,
    );
    const getResponse = await client.callTool({
      name: "get_run",
      arguments: { run_id: started.response.run_id },
    });
    const structured = getResponse.structuredContent && typeof getResponse.structuredContent === "object"
      ? getResponse.structuredContent
      : {};
    const requestId = Array.isArray(structured.input_requests)
      ? structured.input_requests.find((request) => request?.status === "pending")?.request_id
      : undefined;
    if (!requestId) {
      return {
        ...pending,
        tool: "answer_run_input",
        response: { ...(pending.response ?? {}), input_answered: false },
      };
    }
    const answered = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "answer_run_input",
      args: {
        run_id: started.response.run_id,
        request_id: requestId,
        answer: "SECRET_CAMPAIGN_INPUT_ANSWER",
        response_id: "campaign-response-001",
      },
    });
    const terminal = await waitForRun(client, ledgerPath, evidenceClass, scenario, started.response.run_id, (response) =>
      response?.status === "completed",
    );
    return {
      ...terminal,
      tool: "answer_run_input",
      response: {
        ...(terminal.response ?? answered.response ?? {}),
        input_answered: answered.response?.status === "working" ||
          answered.response?.status === "input_required" ||
          answered.response?.success === true ||
          answered.response?.input_request_count !== undefined,
      },
      failure_log_delta_count:
        started.failure_log_delta_count +
        (pending.failure_log_delta_count ?? 0) +
        (answered.failure_log_delta_count ?? 0) +
        (terminal.failure_log_delta_count ?? 0),
    };
  }

  if (scenario === "caller-input-exact-retry") {
    const started = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_run",
      args: { cwd, prompt: "REQUEST_INPUT_WAIT" },
    });
    if (!started.response?.run_id) return started;
    const pending = await waitForRun(client, ledgerPath, evidenceClass, scenario, started.response.run_id, (response) =>
      (response?.pending_input_count ?? 0) > 0,
    );
    const getResponse = await client.callTool({ name: "get_run", arguments: { run_id: started.response.run_id } });
    const structured = getResponse.structuredContent && typeof getResponse.structuredContent === "object" ? getResponse.structuredContent : {};
    const requestId = Array.isArray(structured.input_requests)
      ? structured.input_requests.find((request) => request?.status === "pending")?.request_id
      : undefined;
    if (!requestId) return pending;
    const args = { run_id: started.response.run_id, request_id: requestId, answer: "SECRET_CAMPAIGN_INPUT_ANSWER", response_id: "campaign-retry-response-001" };
    const accepted = await runCall(client, ledgerPath, evidenceClass, scenario, { tool: "answer_run_input", args });
    const retried = await runCall(client, ledgerPath, evidenceClass, scenario, { tool: "answer_run_input", args });
    const terminal = await waitForRun(client, ledgerPath, evidenceClass, scenario, started.response.run_id, (response) => response?.status === "completed");
    return {
      ...terminal,
      tool: "answer_run_input",
      response: {
        ...(terminal.response ?? retried.response ?? {}),
        input_exact_retry: isDeepStrictEqual(accepted.response?.input_response_receipt, retried.response?.input_response_receipt) &&
          accepted.response?.input_response_receipt !== undefined,
      },
      failure_log_delta_count: started.failure_log_delta_count + (pending.failure_log_delta_count ?? 0) +
        accepted.failure_log_delta_count + retried.failure_log_delta_count + (terminal.failure_log_delta_count ?? 0),
    };
  }

  if (scenario === "caller-input-wrong-request") {
    const started = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_run",
      args: { cwd, prompt: "REQUEST_INPUT_WAIT" },
    });
    if (!started.response?.run_id) {
      return started;
    }
    const pending = await waitForRun(client, ledgerPath, evidenceClass, scenario, started.response.run_id, (response) =>
      (response?.pending_input_count ?? 0) > 0,
    );
    const answered = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "answer_run_input",
      args: {
        run_id: started.response.run_id,
        request_id: `${started.response.run_id}-000000000000`,
        answer: "wrong request id",
        response_id: "campaign-wrong-response-001",
      },
    });
    const cancelled = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "cancel_run",
      args: { run_id: started.response.run_id },
    });
    const terminal = await waitForRun(client, ledgerPath, evidenceClass, scenario, started.response.run_id, (response) =>
      response?.status === "cancelled",
    );
    return {
      ...answered,
      tool: "answer_run_input",
      response: {
        ...(answered.response ?? {}),
        input_wrong_rejected:
          answered.response?.kind === "operation_rejected" &&
          answered.response?.is_error === false &&
          answered.response?.reason_code === "input_request_not_part_of_run",
        cleanup_status: terminal.response?.status ?? cancelled.response?.status,
      },
      failure_log_delta_count:
        started.failure_log_delta_count +
        (pending.failure_log_delta_count ?? 0) +
        (answered.failure_log_delta_count ?? 0) +
        (cancelled.failure_log_delta_count ?? 0) +
        (terminal.failure_log_delta_count ?? 0),
    };
  }

  if (isRecursiveDelegateScenario(scenario)) {
    const started = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "schedule_run",
      args: {
        cwd,
        prompt: RECURSIVE_DELEGATE_SCENARIO_PROMPTS[scenario],
        wait_ms: 0,
      },
    });
    const terminal = started.response?.run_id
      ? await waitForRun(client, ledgerPath, evidenceClass, scenario, started.response.run_id, (response) =>
          response?.status === "completed",
        )
      : started;
    let delegatedView;
    let parentAfterDelegated;
    let nestedDelegate = {};
    let nestedView;
    if (terminal.response?.delegated_run_id) {
      delegatedView = await waitForRun(client, ledgerPath, evidenceClass, scenario, terminal.response.delegated_run_id, (response) =>
        ["completed", "failed", "cancelled", "timed_out"].includes(response?.status),
      );
      parentAfterDelegated = await runCall(client, ledgerPath, evidenceClass, scenario, {
        tool: "get_run",
        args: { run_id: terminal.response.run_id },
      });
      if (
        (scenario === "recursive-delegate-two-hop" || scenario === "recursive-delegate-depth-boundary") &&
        delegatedView?.response
      ) {
        nestedDelegate = await recursiveDelegateOutputSummary(delegatedView.response);
        if (typeof nestedDelegate.delegated_run_id === "string") {
          nestedView = await waitForRun(client, ledgerPath, evidenceClass, scenario, nestedDelegate.delegated_run_id, (response) =>
            ["completed", "failed", "cancelled", "timed_out"].includes(response?.status),
          );
        }
      }
    }
    const parentView = parentAfterDelegated ?? terminal;
    return {
      ...parentView,
      tool: "schedule_run",
      response: {
        ...(parentView.response ?? terminal.response ?? {}),
        polled: true,
        delegated_view_status: delegatedView?.response?.status,
        delegated_view_parent_run_id: delegatedView?.response?.parent_run_id,
        delegated_view_root_run_id: delegatedView?.response?.root_run_id,
        delegated_view_recursion_depth: delegatedView?.response?.recursion_depth,
        delegated_view_child_run_ids: delegatedView?.response?.child_run_ids,
        nested_child_status: nestedView?.response?.status,
        nested_child_parent_run_id: nestedView?.response?.parent_run_id,
        nested_child_root_run_id: nestedView?.response?.root_run_id,
        nested_child_recursion_depth: nestedView?.response?.recursion_depth,
        nested_delegated_run_id: nestedDelegate.delegated_run_id,
        nested_delegate_reason_code: nestedDelegate.delegated_reason_code,
        nested_child_run_count: nestedDelegate.root_child_run_count,
      },
      failure_log_delta_count:
        started.failure_log_delta_count +
        (terminal.failure_log_delta_count ?? 0) +
        (delegatedView?.failure_log_delta_count ?? 0) +
        (nestedView?.failure_log_delta_count ?? 0) +
        (parentAfterDelegated?.failure_log_delta_count ?? 0),
    };
  }

  if (scenario === "schedule-run-durable-first") {
    const started = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "schedule_run",
      args: {
        cwd,
        prompt: "HEARTBEAT_SLEEP Investigate HORCs and SAFs into an implementation plan",
        wait_ms: 0,
      },
    });
    const terminal = started.response?.run_id
      ? await waitForRun(client, ledgerPath, evidenceClass, scenario, started.response.run_id, (response) =>
          response?.status === "completed",
        )
      : started;
    return {
      ...terminal,
      tool: "schedule_run",
      response: {
        ...(terminal.response ?? {}),
        polled: true,
        scheduled: true,
      },
      failure_log_delta_count: started.failure_log_delta_count + (terminal.failure_log_delta_count ?? 0),
    };
  }

  if (scenario === "get-run-missing") {
    const missing = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "get_run",
      args: { run_id: "missing-run" },
    });
    return {
      ...missing,
      tool: "get_run",
      response: {
        ...(missing.response ?? {}),
        run_not_found_rejected: missing.response?.reason_code === "run_not_found",
      },
    };
  }

  if (scenario === "cancellation") {
    const started = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_run",
      args: { cwd, prompt: "CANCEL_WAIT", timeout_ms: 6000 },
    });
    if (!started.response?.run_id) {
      return started;
    }
    const cancelled = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "cancel_run",
      args: { run_id: started.response.run_id },
    });
    const settled = await waitForRun(client, ledgerPath, evidenceClass, scenario, started.response.run_id, (response) =>
      response?.cancellation_settled === true,
    );
    return {
      ...settled,
      tool: "cancel_run",
      response: settled.response ?? cancelled.response,
      failure_log_delta_count:
        started.failure_log_delta_count +
        cancelled.failure_log_delta_count +
        (settled.failure_log_delta_count ?? 0),
    };
  }

  if (scenario === "cancel-terminal-run") {
    const started = await runCall(client, ledgerPath, evidenceClass, scenario, {
      tool: "start_run",
      args: { cwd, prompt: "FAST" },
    });
    const terminal = started.response?.run_id
      ? await waitForRun(client, ledgerPath, evidenceClass, scenario, started.response.run_id, (response) =>
          response?.status === "completed",
        )
      : started;
    const cancelled = started.response?.run_id
      ? await runCall(client, ledgerPath, evidenceClass, scenario, {
          tool: "cancel_run",
          args: { run_id: started.response.run_id },
        })
      : terminal;
    return {
      ...cancelled,
      tool: "cancel_run",
      response: {
        ...(cancelled.response ?? {}),
        terminal_cancel_idempotent:
          terminal.response?.status === "completed" && cancelled.response?.status === "completed",
      },
      failure_log_delta_count:
        started.failure_log_delta_count +
        (terminal.failure_log_delta_count ?? 0) +
        (cancelled.failure_log_delta_count ?? 0),
    };
  }

  return runCall(client, ledgerPath, evidenceClass, scenario, scenarioCall(scenario, cwd));
}

let parsed;
try {
  assertManifestComplete();
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

try {
  requireScopedDeterministicProbe(parsed.options.mode);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const ledgerPath = campaignLedgerPath();
const evidenceClass = evidenceClassForMode(parsed.options.mode);
const deterministicChild = parsed.options.mode === "protocol-deterministic"
  ? await createDeterministicFakeChild()
  : null;
const serverEnv = {
  ...process.env,
  ...(deterministicChild
    ? {
        SUBAGENT007_PI_CHILD_PATH: deterministicChild.childPath,
        FAKE_PI_LOG_PATH: deterministicChild.logPath,
        SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS: process.env.SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS ?? "1000",
        SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS: process.env.SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS ?? "0",
        SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS: process.env.SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS ?? "100",
        SUBAGENT007_TIMEOUT_KILL_GRACE_MS: process.env.SUBAGENT007_TIMEOUT_KILL_GRACE_MS ?? "50",
        SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: process.env.SUBAGENT007_TIMEOUT_FORCE_GRACE_MS ?? "50",
      }
    : {}),
};

function createTransport(extraEnv = {}) {
  return new StdioClientTransport({
    command: process.execPath,
    args: [parsed.options.server],
    env: { ...serverEnv, ...extraEnv },
  });
}

async function connectClient(extraEnv = {}) {
  const client = new Client({ name: "subagent007-observed-mcp-probe", version: "0.1.0" });
  await client.connect(createTransport(extraEnv));
  return client;
}

async function runRestartDriftScenario(client) {
  const scenario = "restart-drift";
  const started = await runCall(client, ledgerPath, evidenceClass, scenario, {
    tool: "start_run",
    args: { cwd: parsed.options.cwd, prompt: "CANCEL_WAIT", timeout_ms: 6000 },
  });
  if (!started.response?.run_id) {
    return { client, result: started };
  }

  await client.close();
  const restartedClient = await connectClient();
  const drift = await runCall(restartedClient, ledgerPath, evidenceClass, scenario, {
    tool: "get_run",
    args: { run_id: started.response.run_id },
  });
  return {
    client: restartedClient,
    result: {
      ...drift,
      tool: "get_run",
      response: {
        ...(drift.response ?? {}),
        restart_run_id: started.response.run_id,
      },
      failure_log_delta_count: started.failure_log_delta_count + (drift.failure_log_delta_count ?? 0),
    },
  };
}

let client = await connectClient();
const results = [];

try {
  for (const scenario of parsed.options.scenarios) {
    if (scenario === "restart-drift") {
      const restartDrift = await runRestartDriftScenario(client);
      client = restartDrift.client;
      results.push(restartDrift.result);
      continue;
    }
    if (scenario === "recursive-delegate-depth-limit" || scenario === "recursive-delegate-depth-boundary") {
      await client.close();
      const limitedClient = await connectClient({
        SUBAGENT007_MAX_RECURSION_DEPTH: scenario === "recursive-delegate-depth-limit" ? "0" : "1",
      });
      try {
        results.push(
          await runScenario(
            limitedClient,
            ledgerPath,
            evidenceClass,
            scenario,
            parsed.options.cwd,
          ),
        );
      } finally {
        await limitedClient.close();
      }
      client = await connectClient();
      continue;
    }
    if (scenario === "local-capacity-exhaustion" || scenario === "queue-lifecycle") {
      await client.close();
      const capacityClient = await connectClient({
        SUBAGENT007_MAX_ACTIVE_CHILDREN: "1",
        SUBAGENT007_MAX_QUEUED_RUNS: scenario === "local-capacity-exhaustion" ? "0" : "1",
        SUBAGENT007_ACTIVE_CHILDREN_DIR: path.join(path.dirname(ledgerPath), "active-children"),
      });
      try {
        results.push(
          await runScenario(
            capacityClient,
            ledgerPath,
            evidenceClass,
            scenario,
            parsed.options.cwd,
          ),
        );
      } finally {
        await capacityClient.close();
      }
      client = await connectClient();
      continue;
    }
    results.push(
      await runScenario(
        client,
        ledgerPath,
        evidenceClass,
        scenario,
        parsed.options.cwd,
      ),
    );
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
const summary = coverageSummary(parsed.options.scenarios, parsed.options.mode, parsed.options.scenarioSet, results);

if (!parsed.options.quiet) {
  console.log(JSON.stringify(
    {
      campaign_id: process.env.SUBAGENT007_CAMPAIGN_ID ?? null,
      ledger_path: ledgerPath,
      scenario_set: parsed.options.scenarioSet,
      profile: parsed.options.scenarioSet,
      mode: parsed.options.mode,
      scenarios: parsed.options.scenarios,
      coverage_summary: summary,
      calls: results,
      event_counts: eventCounts,
    },
    null,
    2,
  ));
}

if (summary.missing_required_surfaces.length > 0) {
  console.error(`missing required coverage surfaces: ${summary.missing_required_surfaces.join(", ")}`);
  process.exit(1);
}
