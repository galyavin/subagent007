#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createInputRequest, waitForInputAnswer } from "./inputMailbox.js";
import { resolvePiAgentDir } from "./piAgentDir.js";
import { createSkillScopedResourceLoader } from "./skillResources.js";
import { activateAllRegisteredTools } from "./toolProfile.js";
import type { OutputMode, PromptProvenance, ThinkingLevel, ToolProfile } from "./types.js";

interface PiChildRequest {
  prompt: string;
  cwd: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  skill?: string;
  skillFilePath?: string;
  outputMode: OutputMode;
  toolProfile?: ToolProfile;
  outputLastMessagePath?: string;
  promptProvenance?: PromptProvenance;
  mailboxRoot: string;
  runId: string;
  inputTimeoutMs: number;
  sessionMode: "ephemeral" | "fresh" | "resume";
  sessionFile?: string;
  sessionDir?: string;
}

const requestInputParameters = Type.Object({
  question: Type.String({ minLength: 1 }),
  options: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  freeform: Type.Optional(Type.Boolean()),
});

function writeEvent(event: unknown): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function resolveRequestedModel(modelRef: string, registry: ModelRegistry): Model<Api> {
  const available = registry.getAvailable();
  const all = registry.getAll();
  const normalized = modelRef.trim().toLowerCase();
  const exact = (models: Model<Api>[]) => models.filter((model) =>
    model.id.toLowerCase() === normalized ||
    `${model.provider}/${model.id}`.toLowerCase() === normalized
  );

  const availableMatches = exact(available);
  if (availableMatches.length === 1) {
    return availableMatches[0];
  }
  if (availableMatches.length > 1) {
    throw new Error(
      `model ${JSON.stringify(modelRef)} is ambiguous across providers: ${
        availableMatches.map((model) => `${model.provider}/${model.id}`).join(", ")
      }`,
    );
  }

  const allMatches = exact(all);
  if (allMatches.length > 0) {
    throw new Error(
      `model ${JSON.stringify(modelRef)} is known to Pi but auth is not configured; matching models: ${
        allMatches.map((model) => `${model.provider}/${model.id}`).join(", ")
      }`,
    );
  }

  const examples = available.slice(0, 8).map((model) => `${model.provider}/${model.id}`);
  throw new Error(
    `unknown Pi model ${JSON.stringify(modelRef)}${
      examples.length > 0 ? `; available examples: ${examples.join(", ")}` : "; no authenticated Pi models are available"
    }`,
  );
}

function createRequestInputTool(request: PiChildRequest): ToolDefinition<typeof requestInputParameters> {
  return {
    name: "request_input",
    label: "Request Input",
    description:
      "Ask the caller for missing information and wait until the caller answers this run's mailbox request.",
    promptSnippet: "Ask the caller for missing information and wait for the answer.",
    promptGuidelines: [
      "Use request_input when the active task requires caller or operator information that is unavailable in the prompt or workspace.",
      "Use the returned answer directly and continue the same run.",
      "Do not invent unavailable caller or operator information.",
    ],
    parameters: requestInputParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const inputRequest = await createInputRequest({
        mailboxRoot: request.mailboxRoot,
        runId: request.runId,
        sessionId: request.sessionFile ?? null,
        question: params.question,
        choices: params.options ?? [],
        freeform: params.freeform ?? true,
      });
      writeEvent({
        type: "subagent007.input_request",
        request_id: inputRequest.request_id,
        question: params.question,
        option_count: inputRequest.options.length,
        freeform: inputRequest.freeform,
      });
      let answer;
      try {
        answer = await waitForInputAnswer({
          mailboxRoot: request.mailboxRoot,
          runId: request.runId,
          requestId: inputRequest.request_id,
          timeoutMs: request.inputTimeoutMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("timed out")) {
          writeEvent({ type: "subagent007.input_timed_out", request_id: inputRequest.request_id });
        } else if (message.includes("closed")) {
          writeEvent({ type: "subagent007.input_closed", request_id: inputRequest.request_id });
        }
        throw error;
      }
      return {
        content: [{ type: "text", text: answer.answer }],
        details: {
          request_id: inputRequest.request_id,
          answer: answer.answer,
          answered_at: answer.answered_at,
        },
      };
    },
  };
}

function textFromLastAssistantMessage(messages: unknown[]): string {
  const last = messages.at(-1) as
    | { role?: string; content?: Array<{ type?: string; text?: string }>; stopReason?: string; errorMessage?: string }
    | undefined;
  if (!last || last.role !== "assistant") {
    return "";
  }
  if (last.stopReason === "error" || last.stopReason === "aborted") {
    throw new Error(last.errorMessage || `Pi request ${last.stopReason}`);
  }
  return (last.content ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

async function readRequest(): Promise<PiChildRequest> {
  const requestPath = process.argv[2];
  if (!requestPath) {
    throw new Error("missing Pi child request path");
  }
  return JSON.parse(await fs.readFile(requestPath, "utf8")) as PiChildRequest;
}

async function main(): Promise<void> {
  const request = await readRequest();
  const agentDir = resolvePiAgentDir();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const resourceLoader = createSkillScopedResourceLoader({
    cwd: request.cwd,
    agentDir,
    skill: request.skill,
    skillFilePath: request.skillFilePath,
  });
  const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
  const model = resolveRequestedModel(request.model, modelRegistry);
  const sessionManager =
    request.sessionMode === "ephemeral"
      ? SessionManager.inMemory(request.cwd)
      : request.sessionMode === "resume"
        ? SessionManager.open(
            request.sessionFile ?? (() => {
              throw new Error("resume requires sessionFile");
            })(),
            request.sessionDir,
            request.cwd,
          )
        : SessionManager.create(request.cwd, request.sessionDir);

  await resourceLoader.reload();

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: request.cwd,
    agentDir,
    model,
    thinkingLevel: request.thinkingLevel,
    modelRegistry,
    authStorage,
    sessionManager,
    resourceLoader,
    customTools: [createRequestInputTool(request)],
  });
  activateAllRegisteredTools(session);
  if (modelFallbackMessage) {
    writeEvent({ type: "subagent007.warning", message: modelFallbackMessage });
  }

  const sessionFile = session.sessionFile;
  writeEvent({
    type: "subagent007.session",
    session_id: sessionFile ?? null,
    session_file: sessionFile ?? null,
    pi_session_id: session.sessionId,
  });

  const unsubscribe = session.subscribe((event) => writeEvent(event));
  try {
    await session.prompt(request.prompt);
    const finalText = textFromLastAssistantMessage(session.messages);
    if (request.outputLastMessagePath && request.outputMode === "final") {
      await fs.writeFile(request.outputLastMessagePath, finalText, "utf8");
    }
  } finally {
    unsubscribe();
    session.dispose();
  }
}

main().catch((error: unknown) => {
  writeEvent({
    type: "subagent007.error",
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
