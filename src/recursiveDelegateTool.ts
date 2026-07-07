import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  callRecursiveDelegate,
  type RecursiveControlChildConfig,
  type RecursiveDelegateParams,
} from "./recursiveControl.js";
import { MODEL_CLASSES, OUTPUT_MODES } from "./types.js";
import type { ModelClass, OutputMode } from "./types.js";

const recursiveDelegateParameters = Type.Object({
  prompt: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  model_class: Type.Optional(Type.Union(MODEL_CLASSES.map((value) => Type.Literal(value)))),
  skill_name: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  output_mode: Type.Optional(Type.Union(OUTPUT_MODES.map((value) => Type.Literal(value)))),
  wait_ms: Type.Optional(Type.Number({ minimum: 0 })),
  timeout_ms: Type.Optional(Type.Number({ minimum: 1 })),
});

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  return value;
}

function normalizeDelegateParams(
  params: {
    prompt: string;
    cwd?: string;
    model_class?: string;
    skill_name?: string | null;
    output_mode?: string;
    wait_ms?: number;
    timeout_ms?: number;
  },
  defaultCwd: string,
): RecursiveDelegateParams {
  return {
    prompt: params.prompt,
    cwd: params.cwd ?? defaultCwd,
    ...(params.model_class ? { model_class: params.model_class as ModelClass } : {}),
    ...(params.skill_name !== undefined ? { skill_name: params.skill_name } : {}),
    ...(params.output_mode ? { output_mode: params.output_mode as OutputMode } : {}),
    ...(params.wait_ms !== undefined ? { wait_ms: optionalInteger(params.wait_ms, "wait_ms") } : {}),
    ...(params.timeout_ms !== undefined ? { timeout_ms: optionalInteger(params.timeout_ms, "timeout_ms") } : {}),
  };
}

export function createRecursiveDelegateTool(input: {
  cwd: string;
  recursiveControl?: RecursiveControlChildConfig;
}): ToolDefinition<typeof recursiveDelegateParameters> | undefined {
  const recursiveControl = input.recursiveControl;
  if (!recursiveControl) {
    return undefined;
  }
  return {
    name: "delegate",
    label: "Delegate",
    description:
      "Delegate an independent subtask to another Subagent007 child through the original parent server.",
    promptSnippet: "Use delegate to spawn a durable Subagent007 subtask when independent work can proceed in parallel.",
    promptGuidelines: [
      "Use delegate for independent subtasks that benefit from another Subagent007 child.",
      "Omit cwd to use the current run's cwd.",
      "The parent server owns the descendant run; use the returned run_id/status/output details directly.",
      "Do not pass secrets or private control data; the tool already carries the private recursive capability.",
    ],
    parameters: recursiveDelegateParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const result = await callRecursiveDelegate(
        recursiveControl,
        normalizeDelegateParams(params, input.cwd),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}
