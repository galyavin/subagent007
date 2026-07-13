#!/usr/bin/env node
import { acquireBuildReleaseLease } from "./buildReleaseLease.js";
import { reconcileOwnedTemporaryArtifacts } from "./ownedTemporaryArtifact.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  cwdFromRequest,
  failureClassForToolHandlerError,
  failureReasonCodeForError,
  logFailure,
  type FailureLogTool,
} from "./failureLog.js";
import {
  DEFAULT_MODEL_CLASS,
  MODEL_CLASS_CALIBRATIONS,
  modelClassChoices,
} from "./modelAllowlist.js";
import { modelHealthForClass, modelHealthProbeCommand } from "./modelHealth.js";
import { loadConfigRecord, normalizeConfigRecord } from "./config.js";
import { heartbeatFromExtra, heartbeatIntervalMsFromEnv, type ServerExtra } from "./progress.js";
import { durableRunContractView } from "./durableRunContract.js";
import {
  runtimeReadinessSnapshot,
  SOURCE_STATE_POLICIES,
} from "./runtimeReadiness.js";
import { assertConfiguredChildEntrypointAvailable } from "./childEntrypoint.js";
import {
  answerRunTaskInput,
  cancelRunTask,
  getRunTask,
  lineageForRecursiveDelegate,
  resolveRunOperationContext,
  runSubagentSessionTaskAndWait,
  scheduleRunTask,
  runSubagentOneShotTask,
  reconcilePersistedActiveRunTasks,
  startSessionRunTask,
  startRunTask,
} from "./runTask.js";
import { startRecursiveControlServer } from "./recursiveControl.js";
import {
  LEGACY_SKILL_INPUT_DESCRIPTION,
  SKILL_NAME_INPUT_DESCRIPTION,
} from "./skillBinding.js";
import { SERVER_VERSION } from "./runtimeMetadata.js";
import {
  type FailureReasonCode,
  OUTPUT_MODES,
  MODEL_CLASSES,
  type OperationRejectedResult,
  type PreflightRejectedResult,
  RESUME_MODES,
  RUN_KINDS,
  SESSION_PACKET_POLICIES,
  TOOL_PROFILES,
  ValidationError,
} from "./types.js";

acquireBuildReleaseLease(import.meta.url);
void reconcileOwnedTemporaryArtifacts().catch((error: unknown) => {
  console.error(
    `[subagent007 temp reconciliation warning] ${error instanceof Error ? error.message : String(error)}`,
  );
});
void reconcilePersistedActiveRunTasks().catch((error: unknown) => {
  console.error(
    `[subagent007 restart reconciliation warning] ${error instanceof Error ? error.message : String(error)}`,
  );
});

const server = new McpServer({
  name: "subagent007-pi",
  version: SERVER_VERSION,
});

const TIMEOUT_UNDERBUDGET_GUIDANCE =
  "Use wait_ms for the initial scheduler wait. For long durable work, omit timeout_ms or set timeout_ms to at least the reported minimum.";

function withFailureLogging<TRequest, TResult>(
  tool: FailureLogTool,
  handler: (request: TRequest, extra: ServerExtra) => Promise<TResult>,
): (request: TRequest, extra: ServerExtra) => Promise<TResult> {
  return async (request, extra) => {
    try {
      return await handler(request, extra);
    } catch (error) {
      await logFailure({
        tool,
        failure_class: failureClassForToolHandlerError(tool, error),
        reason_code: failureReasonCodeForError(error),
        cwd: cwdFromRequest(request),
        success: false,
      });
      throw error;
    }
  };
}

function runIdFromRequest(request: unknown): string | undefined {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  const runId = (request as { run_id?: unknown }).run_id;
  return typeof runId === "string" && runId.trim() !== "" ? runId.trim() : undefined;
}

function withRunFailureLogging<TRequest, TResult>(
  tool: Extract<FailureLogTool, "get_run" | "answer_run_input" | "cancel_run">,
  handler: (request: TRequest, extra: ServerExtra) => Promise<TResult>,
): (
  request: TRequest,
  extra: ServerExtra,
) => Promise<TResult | ReturnType<typeof jsonToolResult<Record<string, unknown>>>> {
  return async (request, extra) => {
    const runId = runIdFromRequest(request);
    const context = runId ? await resolveRunOperationContext(runId) : undefined;
    try {
      return await handler(request, extra);
    } catch (error) {
      const reasonCode = failureReasonCodeForError(error);
      await logFailure({
        tool,
        failure_class: failureClassForToolHandlerError(tool, error),
        reason_code: reasonCode,
        cwd: context?.cwd,
        run_id: runId,
        task_kind: context?.taskKind,
        session_key: context?.sessionKey,
        success: false,
      });
      if (error instanceof ValidationError) {
        return jsonObjectToolResult(operationRejectedResult(runId, error, reasonCode));
      }
      throw error;
    }
  };
}

async function preflightRejectedResult(
  tool: FailureLogTool,
  request: unknown,
  error: ValidationError,
): Promise<PreflightRejectedResult> {
  const reasonCode = failureReasonCodeForError(error);
  const retryGuidance = error.message.includes("timeout_ms is not supported by run_subagent")
    ? "Use schedule_run or start_run for timed work."
    : error.message.includes("timeout_ms under budget for deadline-risk workload")
      ? TIMEOUT_UNDERBUDGET_GUIDANCE
    : reasonCode === "local_capacity_exhausted"
      ? "Retry after an active child run completes or raise SUBAGENT007_MAX_ACTIVE_CHILDREN."
    : reasonCode === "local_queue_exhausted"
      ? "Retry after queued work advances or raise SUBAGENT007_MAX_QUEUED_RUNS."
    : reasonCode === "disk_reserve_exhausted"
      ? "Free local disk space or lower SUBAGENT007_MIN_FREE_DISK_BYTES only if the host reserve is intentionally smaller."
    : undefined;
  if (reasonCode !== "timeout_underbudget_for_deadline_risk") {
    await logFailure({
      tool,
      failure_class: "validation_error",
      reason_code: reasonCode,
      cwd: cwdFromRequest(request),
      success: false,
    });
  }
  return {
    status: "rejected",
    kind: "preflight_rejected",
    success: false,
    child_started: false,
    error_class: "validation_error",
    reason_code: reasonCode,
    message: error.message,
    ...(retryGuidance ? { retry_guidance: retryGuidance } : {}),
  };
}

function operationRejectedResult(
  runId: string | undefined,
  error: ValidationError,
  reasonCode: FailureReasonCode,
): OperationRejectedResult {
  return {
    status: "rejected",
    kind: "operation_rejected",
    success: false,
    error_class: "validation_error",
    reason_code: reasonCode,
    message: error.message,
    ...(runId ? { run_id: runId } : {}),
  };
}

function withPreflightRejection<TRequest, TResult extends object>(
  tool: FailureLogTool,
  handler: (request: TRequest, extra: ServerExtra) => Promise<TResult>,
): (request: TRequest, extra: ServerExtra) => Promise<ReturnType<typeof jsonToolResult<Record<string, unknown>>>> {
  return async (request, extra) => {
    try {
      const result = await handler(request, extra);
      return jsonObjectToolResult(result);
    } catch (error) {
      if (error instanceof ValidationError) {
        const result = await preflightRejectedResult(tool, request, error);
        return jsonObjectToolResult(result);
      }
      await logFailure({
        tool,
        failure_class: failureClassForToolHandlerError(tool, error),
        reason_code: failureReasonCodeForError(error),
        cwd: cwdFromRequest(request),
        success: false,
      });
      throw error;
    }
  };
}

function withChildEntrypointPreflight<TRequest, TResult extends object>(
  tool: FailureLogTool,
  handler: (request: TRequest, extra: ServerExtra) => Promise<TResult>,
): (request: TRequest, extra: ServerExtra) => Promise<ReturnType<typeof jsonToolResult<Record<string, unknown>>>> {
  return withPreflightRejection(tool, async (request, extra) => {
    await assertConfiguredChildEntrypointAvailable();
    return handler(request, extra);
  });
}

function jsonObjectToolResult<TResult extends object>(
  result: TResult,
): ReturnType<typeof jsonToolResult<Record<string, unknown>>> {
  const publicResult = publicResultProjection(result);
  return jsonToolResult(publicResult, publicResult);
}

function publicResultProjection(value: unknown): Record<string, unknown> {
  return sanitizePublicResultValue(value) as Record<string, unknown>;
}

function sanitizePublicResultValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizePublicResultValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      key === "input_requests_dir" || key === "pi_session_id"
        ? []
        : [[key, sanitizePublicResultValue(child)]],
    ),
  );
}

function jsonToolResult<TStructured extends Record<string, unknown>>(
  textValue: unknown,
  structuredContent: TStructured,
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: TStructured;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(textValue, null, 2),
      },
    ],
    structuredContent,
  };
}

function taskHeartbeatOptions(extra: ServerExtra) {
  return {
    heartbeat: heartbeatFromExtra(extra),
    heartbeatIntervalMs: heartbeatIntervalMsFromEnv(),
  };
}

const continuitySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("ephemeral") }),
  z.strictObject({ mode: z.literal("fresh") }),
  z.strictObject({ mode: z.literal("resume"), session_id: z.string().min(1) }),
]);

const modelClassSchema = z
  .enum(MODEL_CLASSES)
  .optional()
  .describe("Capability class A-E. A is simplest; E is highest-abstraction/deepest technical work.");

const skillNameInputSchema = z
  .string()
  .nullable()
  .optional()
  .describe(SKILL_NAME_INPUT_DESCRIPTION);

const legacySkillInputSchema = z
  .string()
  .nullable()
  .optional()
  .describe(LEGACY_SKILL_INPUT_DESCRIPTION);

const runKindSchema = z
  .enum(RUN_KINDS, {
    error: "run_kind must be quick_noninteractive; use schedule_run or start_run for longer, cancellable, polling, or caller-input work",
  })
  .describe("Required contract for run_subagent: this call is quick, non-interactive, and deadline-compatible.");

const baseRunInputSchema = {
  prompt: z.string().min(1),
  cwd: z.string().min(1),
  model_class: modelClassSchema,
  skill_name: skillNameInputSchema,
  skill: legacySkillInputSchema,
  output_mode: z.enum(OUTPUT_MODES).optional(),
  tool_profile: z
    .enum(TOOL_PROFILES)
    .optional()
    .describe("Legacy compatibility field; accepted values are validated and ignored; all registered child tools are active."),
};

const runInputSchema = z.strictObject({
  ...baseRunInputSchema,
  run_kind: runKindSchema,
  continuity: continuitySchema.optional(),
}, {
  error: (issue) => unrecognizedKeySchemaError(
    issue,
    "timeout_ms",
    "timeout_ms is not supported by run_subagent; use schedule_run or start_run for timed work",
  ),
});

const timedRunInputSchema = {
  ...baseRunInputSchema,
  continuity: continuitySchema.optional(),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional hard child-process kill cap. For long durable work, omit this; use wait_ms on schedule_run for the initial response wait."),
};

const timedSessionInputSchema = {
  ...baseRunInputSchema,
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional hard child-process kill cap. For long durable session work, omit this unless the run must be stopped by a deadline."),
};

function unrecognizedKeySchemaError(
  issue: { code: string; keys?: string[] },
  key: string,
  message: string,
): string | undefined {
  return issue.code === "unrecognized_keys" && issue.keys?.includes(key)
    ? message
    : undefined;
}

function rawSessionIdSchemaError(
  toolName: "start_run" | "schedule_run",
  issue: { code: string; keys?: string[] },
): string | undefined {
  return unrecognizedKeySchemaError(
    issue,
    "session_id",
    `session_id is not a ${toolName} input; use continuity.mode fresh or continuity.mode resume with continuity.session_id`,
  );
}

const startRunInputSchema = z.strictObject(timedRunInputSchema, {
  error: (issue) => rawSessionIdSchemaError("start_run", issue),
});

const scheduleRunInputSchema = z.strictObject({
  ...timedRunInputSchema,
  wait_ms: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("How long the scheduler should wait for immediate completion before returning the durable run view."),
}, {
  error: (issue) => rawSessionIdSchemaError("schedule_run", issue),
});

const runSessionInputSchema = z.strictObject({
  ...timedSessionInputSchema,
  session_key: z.string().min(1),
  resume_mode: z.enum(RESUME_MODES).optional(),
  packet_policy: z.enum(SESSION_PACKET_POLICIES).optional(),
}, {
  error: (issue) => unrecognizedKeySchemaError(
    issue,
    "continuity",
    "continuity is not supported by run_subagent_session; use session_key and resume_mode",
  ),
});

async function listModelClassesResult(): Promise<ReturnType<typeof jsonToolResult<Record<string, unknown>>>> {
  const configRecord = await loadConfigRecord();
  const config = normalizeConfigRecord(configRecord);
  const rawDefaultModelClass = typeof configRecord.default_model_class === "string"
    ? configRecord.default_model_class
    : null;
  const defaultModelClass = config.default_model_class ?? DEFAULT_MODEL_CLASS;
  const defaultOneShotHealth = await modelHealthForClass(defaultModelClass);
  const legacyConfigDetected =
    configRecord.default_model !== undefined || configRecord.default_thinking_level !== undefined;
  const configMigration =
    (rawDefaultModelClass !== null && rawDefaultModelClass !== defaultModelClass) || legacyConfigDetected
    ? {
        needed: true,
        field: "default_model_class",
        from: rawDefaultModelClass,
        to: defaultModelClass,
        command: "npm run config:migrate",
      }
    : null;
  const result = {
    model_classes: await Promise.all(modelClassChoices().map(async (modelClass) => ({
      class: modelClass,
      description: MODEL_CLASS_CALIBRATIONS[modelClass].description,
      one_shot_health: await modelHealthForClass(modelClass),
    }))),
    default_model_class: defaultModelClass,
    default_model_class_configured: rawDefaultModelClass,
    default_model_class_effective: defaultModelClass,
    default_model_class_repaired: rawDefaultModelClass !== null && rawDefaultModelClass !== defaultModelClass,
    config_migration: configMigration,
    default_one_shot_health_status: defaultOneShotHealth.status,
    default_one_shot_health_basis: defaultOneShotHealth.health_basis,
    model_health_probe_command: modelHealthProbeCommand(defaultModelClass),
  };
  return jsonObjectToolResult(result);
}

function registerModelClassListTool(
  name: Extract<FailureLogTool, "list_model_classes" | "list_allowed_models">,
  description: string,
): void {
  server.registerTool(
    name,
    {
      title: "List Model Classes",
      description,
      inputSchema: {},
    },
    withFailureLogging(name, async () => listModelClassesResult()),
  );
}

registerModelClassListTool(
  "list_model_classes",
  "List the Subagent007 capability classes accepted by this MCP server.",
);
registerModelClassListTool("list_allowed_models", "Compatibility alias for list_model_classes.");

server.registerTool(
  "get_run_contract",
  {
    title: "Get Run Contract",
    description: "Return the versioned durable run lifecycle contract and capabilities supported by this server.",
    inputSchema: {},
  },
  async () => jsonObjectToolResult(durableRunContractView()),
);

server.registerTool(
  "get_runtime_readiness",
  {
    title: "Get Runtime Readiness",
    description:
      "Return a Subagent007 runtime/build/source/capability readiness snapshot with typed actionable block classes.",
    inputSchema: {
      expected_contract_name: z
        .string()
        .min(1)
        .optional()
        .describe("Optional durable-run contract name the caller requires, such as subagent007.durable_run."),
      expected_contract_version: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Optional durable-run contract version the caller requires."),
      source_state_policy: z
        .enum(SOURCE_STATE_POLICIES)
        .optional()
        .describe("How strictly to gate git source state. Defaults to require_clean."),
    },
  },
  async (request) => jsonObjectToolResult(await runtimeReadinessSnapshot(request)),
);

server.registerTool(
  "schedule_run",
  {
    title: "Schedule Run",
    description:
      "Create a durable Pi-backed run task, queue top-level work when local child capacity is full, then return a terminal result only if it completes within wait_ms. Use wait_ms for the initial response wait; timeout_ms starts at child launch and is a hard child kill cap.",
    inputSchema: scheduleRunInputSchema,
  },
  withChildEntrypointPreflight("schedule_run", async (request, extra) =>
    scheduleRunTask(request, taskHeartbeatOptions(extra)),
  ),
);

server.registerTool(
  "start_run",
  {
    title: "Start Run",
    description:
      "Create one durable Pi-backed run and return immediately; top-level work may report active_phase queued until local child capacity is available. Omit timeout_ms for long work unless the child must be stopped by a hard post-launch deadline.",
    inputSchema: startRunInputSchema,
  },
  withChildEntrypointPreflight("start_run", async (request, extra) =>
    startRunTask(request, taskHeartbeatOptions(extra)),
  ),
);

server.registerTool(
  "get_run",
  {
    title: "Get Run",
    description:
      "Read the current status, pending input requests, and terminal result for a durable run. A working run is authoritative non-terminal work: running_silent can normally last many minutes. Elapsed time, no public output, live heartbeats, or recursive child activity do not make a run stale and do not authorize cancellation; keep polling unless explicit user intent or a real caller-owned stop condition requires cancellation.",
    inputSchema: {
      run_id: z.string().min(1),
    },
  },
  withRunFailureLogging("get_run", async (request) => {
    const result = await getRunTask(request.run_id);
    return jsonObjectToolResult(result);
  }),
);

server.registerTool(
  "answer_run_input",
  {
    title: "Answer Run Input",
    description:
      "Answer one pending input request that belongs to a specific active run. Use a stable response_id: a receipt means the child accepted that exact response, an exact live retry replays that receipt without redelivery, and a changed answer with the same ID rejects.",
    inputSchema: {
      run_id: z.string().min(1),
      request_id: z.string().min(1),
      answer: z.string().min(1),
      response_id: z.string().min(1),
    },
  },
  withRunFailureLogging("answer_run_input", async (request) => {
    const result = await answerRunTaskInput({
      runId: request.run_id,
      requestId: request.request_id,
      answer: request.answer,
      responseId: request.response_id,
    });
    return jsonObjectToolResult({
      ...result.view,
      input_response_id: result.responseId,
      input_response_receipt: result.receipt,
      input_response_outcome: result.outcome,
    });
  }),
);

server.registerTool(
  "cancel_run",
  {
    title: "Cancel Run",
    description:
      "Request cancellation only for explicit user intent or a real caller-owned stop condition, then return the updated run view. Silence, running_silent, elapsed time, no public output, live heartbeats, and recursive child activity do not authorize cancellation.",
    inputSchema: {
      run_id: z.string().min(1),
    },
  },
  withRunFailureLogging("cancel_run", async (request) => {
    const result = await cancelRunTask(request.run_id);
    return jsonObjectToolResult(result);
  }),
);

server.registerTool(
  "run_subagent",
  {
    title: "Run Subagent",
    description:
      "Run one quick, non-interactive Pi-backed subagent invocation in an absolute cwd, write cleaned final or transcript output to Markdown, and return metadata.",
    inputSchema: runInputSchema,
  },
  withChildEntrypointPreflight("run_subagent", async (request, extra) =>
    runSubagentOneShotTask(request, taskHeartbeatOptions(extra)),
  ),
);

server.registerTool(
  "start_session_run",
  {
    title: "Start Session Run",
    description:
      "Start or resume a named persistent Pi-backed subagent session as a durable, pollable task. resume_mode defaults to resume_or_new; session_key is scoped to cwd and locks its skill binding. Use this tool for async polling.",
    inputSchema: runSessionInputSchema,
  },
  withChildEntrypointPreflight("start_session_run", async (request, extra) =>
    startSessionRunTask(request, taskHeartbeatOptions(extra)),
  ),
);

server.registerTool(
  "run_subagent_session",
  {
    title: "Run Subagent Session",
    description:
      "Synchronous compatibility wrapper for a named persistent Pi-backed session in an absolute cwd. resume_mode defaults to resume_or_new; session_key is scoped to cwd and locks its skill binding. Prefer start_session_run for async polling.",
    inputSchema: runSessionInputSchema,
  },
  withChildEntrypointPreflight("run_subagent_session", async (request, extra) =>
    runSubagentSessionTaskAndWait(request, taskHeartbeatOptions(extra)),
  ),
);

await startRecursiveControlServer(async ({ caller, params }) => {
  const view = await scheduleRunTask(
    {
      prompt: params.prompt,
      cwd: params.cwd,
      ...(params.model_class ? { model_class: params.model_class } : {}),
      ...(params.skill_name !== undefined ? { skill_name: params.skill_name } : {}),
      ...(params.output_mode ? { output_mode: params.output_mode } : {}),
      ...(params.timeout_ms !== undefined ? { timeout_ms: params.timeout_ms } : {}),
      ...(params.wait_ms !== undefined ? { wait_ms: params.wait_ms } : {}),
    },
    {
      lineage: lineageForRecursiveDelegate({
        parentRunId: caller.parent_run_id,
        rootRunId: caller.root_run_id,
        recursionDepth: caller.recursion_depth,
      }),
    },
  );
  return { ...view };
});

const transport = new StdioServerTransport();
await server.connect(transport);
