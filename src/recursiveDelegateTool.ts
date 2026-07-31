import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  callRecursiveDelegate,
  callRecursiveRejoin,
  type RecursiveControlChildConfig,
  type RecursiveDelegateParams,
  type RecursiveRejoinParams,
} from "./recursiveControl.js";
import { MODEL_CLASSES, OUTPUT_MODES } from "./types.js";
import type { ModelClass, OutputMode } from "./types.js";

const DEFAULT_RECURSIVE_DELEGATE_WAIT_MS = 30_000;

const recursiveDelegateParameters = Type.Object({
  prompt: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  model_class: Type.Optional(Type.Union(MODEL_CLASSES.map((value) => Type.Literal(value)))),
  skill_name: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  output_mode: Type.Optional(Type.Union(OUTPUT_MODES.map((value) => Type.Literal(value)))),
  wait_ms: Type.Optional(Type.Number({ minimum: 0 })),
  timeout_ms: Type.Optional(Type.Number({ minimum: 1 })),
});

const recursiveRejoinParameters = Type.Object({
  run_id: Type.String({ minLength: 1 }),
  wait_ms: Type.Optional(Type.Number({ minimum: 0 })),
});

function integer(value: unknown, field: string): number {
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
    wait_ms: params.wait_ms === undefined
      ? DEFAULT_RECURSIVE_DELEGATE_WAIT_MS
      : integer(params.wait_ms, "wait_ms"),
    ...(params.timeout_ms !== undefined ? { timeout_ms: integer(params.timeout_ms, "timeout_ms") } : {}),
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
      "Delegate a bounded subtask through the original parent server. Omission waits up to 30,000 ms for a usable result, subject to any lower server wait ceiling; wait_ms:0 returns immediately.",
    promptSnippet: "Use delegate to spawn a durable Subagent007 subtask and consume its returned result.",
    promptGuidelines: [
      "Use delegate for independent subtasks that benefit from another Subagent007 child.",
      "Omit cwd to use the current run's cwd.",
      "When you need the child's answer before concluding, omit wait_ms and use the returned terminal result directly.",
      "Set wait_ms:0 only when you intentionally want the parent to continue other work in parallel; the parent server still owns the descendant and waits for its subtree before terminal publication, so use the returned run_id/status/output details directly.",
      "If the bounded wait returns status working, do not claim the child answered or retry the same work; use rejoin with the returned run_id to wait again or retrieve its later terminal result.",
      "timeout_ms is the descendant's hard kill cap, not the response wait.",
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

export function createRecursiveRejoinTool(input: {
  recursiveControl?: RecursiveControlChildConfig;
}): ToolDefinition<typeof recursiveRejoinParameters> | undefined {
  const recursiveControl = input.recursiveControl;
  if (!recursiveControl) {
    return undefined;
  }
  return {
    name: "rejoin",
    label: "Rejoin Descendant",
    description:
      "Wait again for, or retrieve, an existing recursive descendant result by its run_id. The run_id must have been returned by delegate within this caller's descendant lineage. Omission waits up to 30,000 ms; wait_ms:0 returns the current truthful state.",
    promptSnippet: "Use rejoin with a prior delegate run_id when its bounded wait returned working.",
    promptGuidelines: [
      "Pass only a run_id returned by delegate in this recursive subtree.",
      "When delegate returned status working, use rejoin to wait again rather than delegate the same work again.",
      "Use wait_ms:0 only to retrieve the current state; a terminal result includes the existing output references.",
      "Do not use rejoin for arbitrary or ancestor run IDs; the server rejects IDs outside this caller's descendant lineage.",
    ],
    parameters: recursiveRejoinParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const result = await callRecursiveRejoin(recursiveControl, {
        run_id: params.run_id.trim(),
        ...(params.wait_ms === undefined
          ? { wait_ms: DEFAULT_RECURSIVE_DELEGATE_WAIT_MS }
          : { wait_ms: integer(params.wait_ms, "wait_ms") }),
      } satisfies RecursiveRejoinParams);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}
