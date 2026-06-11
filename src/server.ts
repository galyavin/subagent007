#!/usr/bin/env node
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
  resolveModelClass,
} from "./modelAllowlist.js";
import { modelHealthForClass } from "./modelHealth.js";
import { loadConfigRecord, normalizeConfigRecord } from "./config.js";
import { heartbeatFromExtra, heartbeatIntervalMsFromEnv, type ServerExtra } from "./progress.js";
import {
  answerRunTaskInput,
  cancelRunTask,
  getRunTask,
  resolveRunOperationContext,
  runSubagentSessionTaskAndWait,
  runSubagentOneShotTask,
  startSessionRunTask,
  startRunTask,
} from "./runTask.js";
import { SERVER_VERSION } from "./runtimeMetadata.js";
import {
  OUTPUT_MODES,
  MODEL_CLASSES,
  type PreflightRejectedResult,
  RESUME_MODES,
  RUN_KINDS,
  SESSION_PACKET_POLICIES,
  TOOL_PROFILES,
  ValidationError,
} from "./types.js";

const server = new McpServer({
  name: "subagent007-pi",
  version: SERVER_VERSION,
});

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
): (request: TRequest, extra: ServerExtra) => Promise<TResult> {
  return async (request, extra) => {
    const runId = runIdFromRequest(request);
    const context = runId ? await resolveRunOperationContext(runId) : undefined;
    try {
      return await handler(request, extra);
    } catch (error) {
      await logFailure({
        tool,
        failure_class: failureClassForToolHandlerError(tool, error),
        reason_code: failureReasonCodeForError(error),
        cwd: context?.cwd,
        run_id: runId,
        task_kind: context?.taskKind,
        session_key: context?.sessionKey,
        success: false,
      });
      throw error;
    }
  };
}

function preflightRetryGuidance(message: string): string | undefined {
  if (message.includes("incompatible with run_subagent's quick_noninteractive contract")) {
    return "Use start_run with explicit timeout_ms for broad, exploratory, skill-bound, cancellable, polling, or long-running work.";
  }
  if (message.includes("timeout_ms is not supported by run_subagent")) {
    return "Use start_run for timed work.";
  }
  return undefined;
}

async function preflightRejectedResult(
  tool: FailureLogTool,
  request: unknown,
  error: ValidationError,
): Promise<PreflightRejectedResult> {
  const reasonCode = failureReasonCodeForError(error);
  await logFailure({
    tool,
    failure_class: "validation_error",
    reason_code: reasonCode,
    cwd: cwdFromRequest(request),
    success: false,
  });
  return {
    status: "rejected",
    kind: "preflight_rejected",
    success: false,
    child_started: false,
    error_class: "validation_error",
    reason_code: reasonCode,
    message: error.message,
    ...(preflightRetryGuidance(error.message)
      ? { retry_guidance: preflightRetryGuidance(error.message) }
      : {}),
  };
}

function withPreflightRejection<TRequest, TResult extends object>(
  tool: FailureLogTool,
  handler: (request: TRequest, extra: ServerExtra) => Promise<TResult>,
): (request: TRequest, extra: ServerExtra) => Promise<ReturnType<typeof jsonToolResult<Record<string, unknown>>>> {
  return async (request, extra) => {
    try {
      const result = await handler(request, extra);
      return jsonToolResult(result, { ...result } as Record<string, unknown>);
    } catch (error) {
      if (error instanceof ValidationError) {
        const result = await preflightRejectedResult(tool, request, error);
        return jsonToolResult(result, { ...result });
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

const continuitySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("ephemeral") }),
  z.strictObject({ mode: z.literal("fresh") }),
  z.strictObject({ mode: z.literal("resume"), session_id: z.string().min(1) }),
]);

const modelClassSchema = z
  .enum(MODEL_CLASSES)
  .optional()
  .describe("Capability class A-E. A is simplest; E is highest-abstraction/deepest technical work.");

const skillInputSchema = z
  .string()
  .nullable()
  .optional()
  .describe("Bare skill name only, such as pda-lite or plugin:skill-name; null means no skill.");

const runKindSchema = z
  .enum(RUN_KINDS, {
    error: "run_kind must be quick_noninteractive; use start_run for longer, cancellable, polling, or caller-input work",
  })
  .describe("Required contract for run_subagent: this call is quick, non-interactive, and deadline-compatible.");

const baseRunInputSchema = {
  prompt: z.string().min(1),
  cwd: z.string().min(1),
  model_class: modelClassSchema,
  skill_name: skillInputSchema,
  skill: skillInputSchema,
  output_mode: z.enum(OUTPUT_MODES).optional(),
  tool_profile: z.enum(TOOL_PROFILES).optional(),
};

const runInputSchema = z.strictObject({
  ...baseRunInputSchema,
  run_kind: runKindSchema,
  continuity: continuitySchema.optional(),
}, {
  error: (issue) =>
    issue.code === "unrecognized_keys" && issue.keys.includes("timeout_ms")
      ? "timeout_ms is not supported by run_subagent; use start_run for timed work"
      : undefined,
});

const timedRunInputSchema = {
  ...baseRunInputSchema,
  continuity: continuitySchema.optional(),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional(),
};

const timedSessionInputSchema = {
  ...baseRunInputSchema,
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional(),
};

const startRunInputSchema = z.strictObject(timedRunInputSchema, {
  error: (issue) =>
    issue.code === "unrecognized_keys" && issue.keys.includes("session_id")
      ? "session_id is not a start_run input; use continuity.mode fresh or continuity.mode resume with continuity.session_id"
      : undefined,
});

const runSessionInputSchema = z.strictObject({
  ...timedSessionInputSchema,
  session_key: z.string().min(1),
  resume_mode: z.enum(RESUME_MODES).optional(),
  packet_policy: z.enum(SESSION_PACKET_POLICIES).optional(),
}, {
  error: (issue) =>
    issue.code === "unrecognized_keys" && issue.keys.includes("continuity")
      ? "continuity is not supported by run_subagent_session; use session_key and resume_mode"
      : undefined,
});

async function listModelClassesResult(): Promise<ReturnType<typeof jsonToolResult<Record<string, unknown>>>> {
  const configRecord = await loadConfigRecord();
  const config = normalizeConfigRecord(configRecord);
  const rawDefaultModelClass = typeof configRecord.default_model_class === "string"
    ? configRecord.default_model_class
    : null;
  const defaultModelClass = config.default_model_class ?? DEFAULT_MODEL_CLASS;
  const defaultResolution = resolveModelClass(defaultModelClass);
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
    resolved_default_model: defaultResolution.model,
    resolved_default_thinking_level: defaultResolution.thinkingLevel,
  };
  return jsonToolResult(result, result);
}

server.registerTool(
  "list_model_classes",
  {
    title: "List Model Classes",
    description: "List the Subagent007 capability classes accepted by this MCP server.",
    inputSchema: {},
  },
  withFailureLogging("list_model_classes", async () => listModelClassesResult()),
);

server.registerTool(
  "list_allowed_models",
  {
    title: "List Model Classes",
    description: "Compatibility alias for list_model_classes.",
    inputSchema: {},
  },
  withFailureLogging("list_allowed_models", async () => listModelClassesResult()),
);

server.registerTool(
  "start_run",
  {
    title: "Start Run",
    description:
      "Start one Pi-backed child run as a run-scoped task and return immediately with status and input mailbox metadata.",
    inputSchema: startRunInputSchema,
  },
  withPreflightRejection("start_run", async (request, extra) =>
    startRunTask(request, {
      heartbeat: heartbeatFromExtra(extra),
      heartbeatIntervalMs: heartbeatIntervalMsFromEnv(),
    }),
  ),
);

server.registerTool(
  "get_run",
  {
    title: "Get Run",
    description:
      "Read the current status, pending input requests, and terminal result for a durable run created by run_subagent, start_run, start_session_run, or run_subagent_session.",
    inputSchema: {
      run_id: z.string().min(1),
    },
  },
  withRunFailureLogging("get_run", async (request) => {
    const result = await getRunTask(request.run_id);
    return jsonToolResult(result, { ...result });
  }),
);

server.registerTool(
  "answer_run_input",
  {
    title: "Answer Run Input",
    description:
      "Answer one pending input request that belongs to a specific active run, then return the updated run view.",
    inputSchema: {
      run_id: z.string().min(1),
      request_id: z.string().min(1),
      answer: z.string().min(1),
    },
  },
  withRunFailureLogging("answer_run_input", async (request) => {
    const result = await answerRunTaskInput({
      runId: request.run_id,
      requestId: request.request_id,
      answer: request.answer,
    });
    return jsonToolResult(result, { ...result });
  }),
);

server.registerTool(
  "cancel_run",
  {
    title: "Cancel Run",
    description: "Request cancellation for an active run and return the updated run view.",
    inputSchema: {
      run_id: z.string().min(1),
    },
  },
  withRunFailureLogging("cancel_run", async (request) => {
    const result = await cancelRunTask(request.run_id);
    return jsonToolResult(result, { ...result });
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
  withPreflightRejection("run_subagent", async (request, extra) =>
    runSubagentOneShotTask(request, {
      heartbeat: heartbeatFromExtra(extra),
      heartbeatIntervalMs: heartbeatIntervalMsFromEnv(),
    }),
  ),
);

server.registerTool(
  "start_session_run",
  {
    title: "Start Session Run",
    description:
      "Start or resume a named persistent Pi-backed subagent session as a durable, pollable task.",
    inputSchema: runSessionInputSchema,
  },
  withPreflightRejection("start_session_run", async (request, extra) =>
    startSessionRunTask(request, {
      heartbeat: heartbeatFromExtra(extra),
      heartbeatIntervalMs: heartbeatIntervalMsFromEnv(),
    }),
  ),
);

server.registerTool(
  "run_subagent_session",
  {
    title: "Run Subagent Session",
    description:
      "Run or resume a named persistent Pi-backed subagent session in an absolute cwd, write output and append an auditable session ledger.",
    inputSchema: runSessionInputSchema,
  },
  withPreflightRejection("run_subagent_session", async (request, extra) =>
    runSubagentSessionTaskAndWait(request, {
      heartbeat: heartbeatFromExtra(extra),
      heartbeatIntervalMs: heartbeatIntervalMsFromEnv(),
    }),
  ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
