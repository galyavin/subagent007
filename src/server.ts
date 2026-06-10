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
  allowedModelChoices,
  exactModelChoices,
  formatAllowedModelChoices,
  isAllowedModelRef,
  modelPatternChoices,
  repairKnownModelAlias,
  resolveAllowedModelRef,
  SUGGESTED_DEFAULT_MODEL_REF,
} from "./modelAllowlist.js";
import { loadConfig } from "./config.js";
import { heartbeatFromExtra, heartbeatIntervalMsFromEnv, type ServerExtra } from "./progress.js";
import { runSubagent } from "./runSubagent.js";
import { answerRunTaskInput, cancelRunTask, getRunTask, startRunTask } from "./runTask.js";
import { SERVER_VERSION } from "./runtimeMetadata.js";
import { runSubagentSession } from "./session.js";
import {
  OUTPUT_MODES,
  RESUME_MODES,
  SESSION_PACKET_POLICIES,
  THINKING_LEVELS,
  TOOL_PROFILES,
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
  z.object({ mode: z.literal("ephemeral") }),
  z.object({ mode: z.literal("fresh") }),
  z.object({ mode: z.literal("resume"), session_id: z.string().min(1) }),
]);

const modelSchema = z
  .string()
  .describe(`Curated Pi model only. Allowed values: ${formatAllowedModelChoices()}`)
  .refine(isAllowedModelRef, {
    message: `model must be one of: ${formatAllowedModelChoices()}`,
  })
  .optional();

const skillInputSchema = z
  .string()
  .nullable()
  .optional()
  .describe("Bare skill name only, such as pda-lite or plugin:skill-name; null means no skill.");

const runInputSchema = {
  prompt: z.string().min(1),
  cwd: z.string().min(1),
  continuity: continuitySchema.optional(),
  model: modelSchema,
  thinking_level: z.enum(THINKING_LEVELS).optional(),
  skill_name: skillInputSchema,
  skill: skillInputSchema,
  output_mode: z.enum(OUTPUT_MODES).optional(),
  tool_profile: z.enum(TOOL_PROFILES).optional(),
  timeout_ms: z
    .never({
      error: "timeout_ms is not supported by run_subagent; use start_run for timed work",
    })
    .optional(),
};

const startRunInputSchema = {
  ...runInputSchema,
  timeout_ms: z.number().int().positive().optional(),
};

server.registerTool(
  "list_allowed_models",
  {
    title: "List Allowed Models",
    description: "List the curated Pi model options accepted by this MCP server.",
    inputSchema: {},
  },
  withFailureLogging("list_allowed_models", async () => {
    const config = await loadConfig();
    const repairedDefaultModel = config.default_model ? repairKnownModelAlias(config.default_model) : null;
    const defaultModelAllowed = repairedDefaultModel ? isAllowedModelRef(repairedDefaultModel) : null;
    const defaultModelResolved = repairedDefaultModel && defaultModelAllowed
      ? resolveAllowedModelRef(repairedDefaultModel)
      : repairedDefaultModel;
    const result = {
      allowed_models: allowedModelChoices(),
      exact_models: exactModelChoices(),
      model_patterns: modelPatternChoices(),
      default_model: config.default_model ?? null,
      default_model_resolved: defaultModelResolved,
      default_model_allowed: defaultModelAllowed,
      default_model_repaired: Boolean(config.default_model && repairedDefaultModel !== config.default_model),
      default_thinking_level: config.default_thinking_level ?? null,
      suggested_default_model:
        defaultModelAllowed === false ? SUGGESTED_DEFAULT_MODEL_REF : null,
    };
    return jsonToolResult(result, result);
  }),
);

server.registerTool(
  "start_run",
  {
    title: "Start Run",
    description:
      "Start one Pi-backed child run as a run-scoped task and return immediately with status and input mailbox metadata.",
    inputSchema: startRunInputSchema,
  },
  withFailureLogging("start_run", async (request, extra) => {
    const result = await startRunTask(request, {
      heartbeat: heartbeatFromExtra(extra),
      heartbeatIntervalMs: heartbeatIntervalMsFromEnv(),
    });
    return jsonToolResult(result, { ...result });
  }),
);

server.registerTool(
  "get_run",
  {
    title: "Get Run",
    description:
      "Read the current status, pending input requests, and terminal result for a run started with start_run.",
    inputSchema: {
      run_id: z.string().min(1),
    },
  },
  withFailureLogging("get_run", async (request) => {
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
  withFailureLogging("answer_run_input", async (request) => {
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
  withFailureLogging("cancel_run", async (request) => {
    const result = await cancelRunTask(request.run_id);
    return jsonToolResult(result, { ...result });
  }),
);

server.registerTool(
  "run_subagent",
  {
    title: "Run Subagent",
    description:
      "Run one non-interactive Pi-backed subagent invocation in an absolute cwd, write cleaned final or transcript output to Markdown, and return metadata.",
    inputSchema: runInputSchema,
  },
  withFailureLogging("run_subagent", async (request, extra) => {
    const result = await runSubagent(request, {
      heartbeat: heartbeatFromExtra(extra),
      heartbeatIntervalMs: heartbeatIntervalMsFromEnv(),
    });
    return jsonToolResult(result, { ...result });
  }),
);

server.registerTool(
  "run_subagent_session",
  {
    title: "Run Subagent Session",
    description:
      "Run or resume a named persistent Pi-backed subagent session in an absolute cwd, write output and append an auditable session ledger.",
    inputSchema: {
      prompt: z.string().min(1),
      cwd: z.string().min(1),
      session_key: z.string().min(1),
      resume_mode: z.enum(RESUME_MODES).optional(),
      model: modelSchema,
      thinking_level: z.enum(THINKING_LEVELS).optional(),
      timeout_ms: z.number().int().positive().optional(),
      skill_name: skillInputSchema,
      skill: skillInputSchema,
      output_mode: z.enum(OUTPUT_MODES).optional(),
      tool_profile: z.enum(TOOL_PROFILES).optional(),
      packet_policy: z.enum(SESSION_PACKET_POLICIES).optional(),
    },
  },
  withFailureLogging("run_subagent_session", async (request, extra) => {
    const result = await runSubagentSession(request, {
      heartbeat: heartbeatFromExtra(extra),
      heartbeatIntervalMs: heartbeatIntervalMsFromEnv(),
    });
    return jsonToolResult(result, { ...result });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
