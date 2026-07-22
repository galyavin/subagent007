#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createInputRequest } from "./inputMailbox.js";
import { terminateOwnedProcessGroupOnControlLoss } from "./controlChannel.js";
import { resolvePiAgentDir } from "./piAgentDir.js";
import { createRecursiveDelegateTool } from "./recursiveDelegateTool.js";
import { createSkillScopedResourceLoader } from "./skillResources.js";
import { createTaskRootAuthoringTools } from "./taskRootAuthoringTools.js";
import {
  assertResolvedBoundedControllerPython,
  createBoundedControllerTool,
  type ResolvedBoundedControllerPython,
} from "./boundedController.js";
import {
  activateAllRegisteredTools,
  activateEffectProfileTools,
  assertExactBoundedActivationToolBindings,
  boundedAuthoringActivationReceipt,
  boundedControllerActivationBindings,
  boundedControllerScriptPath,
  boundedEffectProfileSkill,
  effectProfileToolNames,
  explicitWebProviderExtensionPaths,
  isBoundedEffectProfile,
  requestInputImplementationSha256,
  resolveWorkspaceReadOnlyWebProvider,
  skillCreatorAuthoringV1ActivationReceipt,
  skillOnlyActivationReceipt,
  taskRootAuthoringV1ActivationReceipt,
  workspaceReadOnlyActivationReceipt,
} from "./toolProfile.js";
import { MODEL_RUNTIME_FALLBACKS } from "./modelAllowlist.js";
import type {
  ActivationSkillBinding,
  ActivationToolBinding,
  AuthoringEffectScopeBinding,
  EffectProfile,
  FailureReasonCode,
  OutputMode,
  PromptProvenance,
  SkillSnapshotActivationReceipt,
  SkillSnapshotLaunchBinding,
  ThinkingLevel,
} from "./types.js";
import type { RecursiveControlChildConfig } from "./recursiveControl.js";
import { resolveSkillSnapshotLaunchBinding } from "./skillSnapshot.js";
import {
  captureAuthoringEffectScope,
  assertAuthoringEffectScopeBinding,
  isEffectScopedAuthoringProfile,
} from "./authoringEffectScope.js";

interface PiChildRequest {
  prompt: string;
  cwd: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  skill?: string;
  skillFilePath?: string;
  outputMode: OutputMode;
  outputLastMessagePath?: string;
  promptProvenance?: PromptProvenance;
  mailboxRoot: string;
  runId: string;
  inputTimeoutMs: number;
  sessionMode: "ephemeral" | "fresh" | "resume";
  sessionFile?: string;
  sessionDir?: string;
  recursiveControl?: RecursiveControlChildConfig;
  recursiveDelegation: "disabled" | "enabled";
  requestedRecursiveDelegation: "disabled" | "enabled" | null;
  effectProfile?: EffectProfile;
  expectedSkillSha256?: string;
  skillBinding?: ActivationSkillBinding;
  expectedActivationToolBindings?: ActivationToolBinding[];
  controllerPython?: ResolvedBoundedControllerPython;
  skillSnapshotBinding?: SkillSnapshotLaunchBinding;
  expectedSkillSnapshotActivationReceipt?: SkillSnapshotActivationReceipt;
  expectedEffectScopeBinding?: AuthoringEffectScopeBinding;
}

class ChildContractError extends Error {
  constructor(message: string, readonly reasonCode: FailureReasonCode) {
    super(message);
  }
}

function asChildContractError(error: unknown, reasonCode: FailureReasonCode): ChildContractError {
  return error instanceof ChildContractError
    ? error
    : new ChildContractError(error instanceof Error ? error.message : String(error), reasonCode);
}

async function verifiedSkillBinding(request: PiChildRequest): Promise<ActivationSkillBinding | null> {
  if (!request.skillBinding) {
    if (request.expectedSkillSha256) {
      throw new ChildContractError(
        "expected_skill_sha256 was supplied without a resolved skill binding",
        "skill_content_mismatch",
      );
    }
    return null;
  }
  if (!request.skillFilePath) {
    throw new ChildContractError("resolved skill binding is missing its run-owned snapshot", "skill_content_mismatch");
  }
  const resolvedPath = path.resolve(request.skillBinding.path);
  let contentSha256: string;
  try {
    contentSha256 = createHash("sha256").update(await fs.readFile(request.skillFilePath)).digest("hex");
  } catch (error) {
    throw asChildContractError(error, "skill_content_mismatch");
  }
  if (
    request.skillBinding.name !== request.skill ||
    resolvedPath !== request.skillBinding.path ||
    contentSha256 !== request.skillBinding.content_sha256 ||
    (request.expectedSkillSha256 && contentSha256 !== request.expectedSkillSha256)
  ) {
    throw new ChildContractError(
      `resolved skill content does not match the preflight binding for ${JSON.stringify(request.skill)}`,
      "skill_content_mismatch",
    );
  }
  return {
    ...request.skillBinding,
    path: resolvedPath,
    content_sha256: contentSha256,
    expected_content_sha256: request.expectedSkillSha256 ?? null,
  };
}

const requestInputParameters = Type.Object({
  question: Type.String({ minLength: 1 }),
  options: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  freeform: Type.Optional(Type.Boolean()),
});

interface InputResponse {
  requestId: string;
  responseId: string;
  answer: string;
  receivedAt: string;
}

interface InputControl {
  waitForResponse(requestId: string, timeoutMs: number): Promise<InputResponse>;
  dispose(): void;
}

function createInputControl(runId: string): InputControl {
  const buffered = new Map<string, InputResponse>();
  const waiters = new Map<string, (response: InputResponse) => void>();
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let disposed = false;
  reader.on("close", () => {
    if (!disposed) {
      terminateOwnedProcessGroupOnControlLoss();
    }
  });
  reader.on("line", (line) => {
    try {
      const message = JSON.parse(line) as {
        type?: unknown;
        request_id?: unknown;
        response_id?: unknown;
        answer?: unknown;
      };
      if (
        message.type !== "subagent007.input_response" ||
        typeof message.request_id !== "string" ||
        typeof message.response_id !== "string" ||
        typeof message.answer !== "string"
      ) {
        return;
      }
      const response: InputResponse = {
        requestId: message.request_id,
        responseId: message.response_id,
        answer: message.answer,
        receivedAt: new Date().toISOString(),
      };
      const waiter = waiters.get(response.requestId);
      if (waiter) {
        waiters.delete(response.requestId);
        waiter(response);
        return;
      }
      buffered.set(response.requestId, response);
    } catch {
      // The parent owns this private control channel. Malformed frames cannot become tool input.
    }
  });

  return {
    waitForResponse(requestId, timeoutMs) {
      const accept = (response: InputResponse): InputResponse => {
        writeEvent({
          type: "subagent007.input_response_accepted",
          run_id: runId,
          request_id: response.requestId,
          response_id: response.responseId,
        });
        return response;
      };
      const alreadyReceived = buffered.get(requestId);
      if (alreadyReceived) {
        buffered.delete(requestId);
        return Promise.resolve(accept(alreadyReceived));
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(requestId);
          reject(new Error(`input request timed out: ${requestId}`));
        }, timeoutMs);
        waiters.set(requestId, (response) => {
          clearTimeout(timeout);
          resolve(accept(response));
        });
      });
    },
    dispose() {
      disposed = true;
      reader.close();
      waiters.clear();
      buffered.clear();
    },
  };
}

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

  const fallback = MODEL_RUNTIME_FALLBACKS[normalized as keyof typeof MODEL_RUNTIME_FALLBACKS];
  if (fallback) {
    const templateRef = fallback.template.toLowerCase();
    const template = available.find((model) =>
      `${model.provider}/${model.id}`.toLowerCase() === templateRef,
    );
    if (template) {
      return {
        ...template,
        id: normalized.slice("openrouter/".length),
        name: fallback.name,
        contextWindow: fallback.contextWindow,
        maxTokens: fallback.maxTokens,
      };
    }
  }

  const examples = available.slice(0, 8).map((model) => `${model.provider}/${model.id}`);
  throw new Error(
    `unknown Pi model ${JSON.stringify(modelRef)}${
      examples.length > 0 ? `; available examples: ${examples.join(", ")}` : "; no authenticated Pi models are available"
    }`,
  );
}

function createRequestInputTool(
  request: PiChildRequest,
  inputControl: InputControl,
): ToolDefinition<typeof requestInputParameters> {
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
        optionIds: (params.options ?? []).map((_, index) => `option_${index + 1}`),
        maxAnswerChars: 4096,
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
        answer = await inputControl.waitForResponse(inputRequest.request_id, request.inputTimeoutMs);
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
          answered_at: answer.receivedAt,
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
  const inputControl = createInputControl(request.runId);
  writeEvent({ type: "subagent007.lifecycle", event: "child_bridge_started" });
  let expectedSnapshotReceipt: SkillSnapshotActivationReceipt | null = null;
  if (request.skillSnapshotBinding) {
    if (!request.skill) {
      throw new ChildContractError("skill snapshot binding requires canonical skill name", "skill_snapshot_activation_failed");
    }
    try {
      const resolved = await resolveSkillSnapshotLaunchBinding({
        skill_name: request.skill,
        binding: request.skillSnapshotBinding,
      });
      if (request.skillFilePath !== resolved.receipt.resolved_skill_path) {
        throw new Error("skill snapshot path does not match owner-derived activation path");
      }
      expectedSnapshotReceipt = resolved.receipt;
      if (
        !request.expectedSkillSnapshotActivationReceipt ||
        JSON.stringify(request.expectedSkillSnapshotActivationReceipt) !== JSON.stringify(expectedSnapshotReceipt)
      ) {
        throw new Error("skill snapshot parent activation receipt does not match child revalidation");
      }
    } catch (error) {
      throw asChildContractError(error, "skill_snapshot_activation_failed");
    }
  }
  const agentDir = resolvePiAgentDir();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const isWorkspaceReadOnly = request.effectProfile === "workspace_read_only";
  const boundedProfile = isBoundedEffectProfile(request.effectProfile) ? request.effectProfile : undefined;
  const isBounded = boundedProfile !== undefined;
  let effectScopeBinding: AuthoringEffectScopeBinding | undefined;
  if (isEffectScopedAuthoringProfile(request.effectProfile)) {
    if (!request.expectedEffectScopeBinding) {
      throw new ChildContractError("authoring effect scope binding is absent", "effect_profile_activation_failed");
    }
    try {
      assertAuthoringEffectScopeBinding(request.expectedEffectScopeBinding);
      const captured = await captureAuthoringEffectScope({
        taskRoot: request.cwd,
        effectProfile: request.effectProfile,
        recursiveDelegation: request.recursiveDelegation,
        ...(request.expectedEffectScopeBinding.writable_scope.kind === "exact_output_files"
          ? { allowedOutputPaths: request.expectedEffectScopeBinding.writable_scope.paths }
          : {}),
      });
      if (JSON.stringify(captured.binding) !== JSON.stringify(request.expectedEffectScopeBinding)) {
        throw new Error("authoring effect scope changed after parent preflight");
      }
      effectScopeBinding = captured.binding;
    } catch (error) {
      throw asChildContractError(error, "effect_profile_activation_failed");
    }
  } else if (request.expectedEffectScopeBinding) {
    throw new ChildContractError("unexpected authoring effect scope binding", "effect_profile_activation_failed");
  }
  const boundedSkill = boundedProfile ? boundedEffectProfileSkill(boundedProfile) : undefined;
  if (boundedProfile && (!request.skill || request.skill !== boundedSkill || !expectedSnapshotReceipt)) {
    throw new ChildContractError(
      `${request.effectProfile} requires its exact canonical skill and immutable snapshot`,
      "invalid_skill_snapshot_binding",
    );
  }
  const webProvider = isWorkspaceReadOnly || isBounded
    ? await resolveWorkspaceReadOnlyWebProvider(agentDir).catch((error) => {
        throw asChildContractError(error, "effect_profile_activation_failed");
      })
    : undefined;
  const controllerPython = isBounded
    ? await assertResolvedBoundedControllerPython(request.controllerPython, boundedProfile!).catch((error) => {
        throw asChildContractError(error, "effect_profile_activation_failed");
      })
    : undefined;
  const boundedController = isBounded
    ? await boundedControllerScriptPath(
        boundedProfile!,
        request.skill!,
        expectedSnapshotReceipt!.resolved_skill_path,
      ).catch((error) => {
        throw asChildContractError(error, "effect_profile_activation_failed");
      })
    : undefined;
  const boundedBindings = isBounded
    ? await boundedControllerActivationBindings({
        effectProfile: boundedProfile!,
        skillName: request.skill!,
        snapshotSkillFilePath: expectedSnapshotReceipt!.resolved_skill_path,
        childEntrypoint: fileURLToPath(import.meta.url),
        webProvider: webProvider!,
        controllerPython: controllerPython!,
      }).catch((error) => {
        throw asChildContractError(error, "effect_profile_activation_failed");
      })
    : undefined;
  if (boundedBindings) {
    try {
      // The parent receipt is mandatory evidence; child-derived values may only
      // confirm it byte-for-byte and may never replace it.
      assertExactBoundedActivationToolBindings(request.expectedActivationToolBindings, boundedBindings);
    } catch (error) {
      throw asChildContractError(error, "effect_profile_activation_failed");
    }
  }
  const resourceLoader = createSkillScopedResourceLoader({
    cwd: request.cwd,
    agentDir,
    skill: request.skill,
    skillFilePath: request.skillFilePath,
    ...(request.effectProfile
      ? {
          noAmbientExtensions: true,
          explicitExtensionPaths: explicitWebProviderExtensionPaths(request.effectProfile, webProvider),
        }
      : {}),
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

  await resourceLoader.reload().catch((error) => {
    throw asChildContractError(
      error,
      request.effectProfile ? "effect_profile_activation_failed" : "unknown_error",
    );
  });
  const skillBinding = await verifiedSkillBinding(request);
  const customTools: ToolDefinition<any>[] = [
    ...(request.effectProfile === undefined || isWorkspaceReadOnly
      ? [createRequestInputTool(request, inputControl)]
      : []),
    ...(request.effectProfile === "skill_creator_authoring_v1" || request.effectProfile === "task_root_authoring_v1" || isBounded
      ? createTaskRootAuthoringTools(
          request.cwd,
          expectedSnapshotReceipt?.resolved_skill_path,
          request.effectProfile === "task_root_authoring_v1" ? ["read", "write"] : undefined,
          effectScopeBinding,
        )
      : []),
    ...(boundedController
      ? [createBoundedControllerTool(
          request.cwd,
          boundedController.tool,
          boundedController.scriptPath,
          controllerPython!,
          effectScopeBinding,
        )]
      : []),
  ];
  if (!request.effectProfile && request.recursiveDelegation === "enabled") {
    const recursiveDelegateTool = createRecursiveDelegateTool({
      cwd: request.cwd,
      recursiveControl: request.recursiveControl,
    });
    if (recursiveDelegateTool) {
      customTools.push(recursiveDelegateTool);
    }
  }

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: request.cwd,
    agentDir,
    model,
    thinkingLevel: request.thinkingLevel,
    modelRegistry,
    authStorage,
    sessionManager,
    resourceLoader,
    customTools,
    ...(request.effectProfile ? { tools: [...effectProfileToolNames(request.effectProfile)] } : {}),
  });
  if (request.effectProfile) {
    try {
      activateEffectProfileTools(session, request.effectProfile);
    } catch (error) {
      throw asChildContractError(error, "effect_profile_activation_failed");
    }
  } else {
    activateAllRegisteredTools(session, request.recursiveDelegation);
  }
  const delegateToolActive = session.getActiveToolNames().includes("delegate");
  writeEvent({
    type: "subagent007.recursive_delegation_confirmed",
    receipt: {
      schema_version: 1,
      confirmed_before_prompt: true,
      requested_recursive_delegation: request.requestedRecursiveDelegation,
      resolved_recursive_delegation: request.recursiveDelegation,
      delegate_tool_active: delegateToolActive,
    },
  });
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

  if (request.effectProfile === "workspace_read_only") {
    let receipt;
    try {
      receipt = workspaceReadOnlyActivationReceipt({
        webProvider: webProvider!,
        requestInputSha256: await requestInputImplementationSha256(fileURLToPath(import.meta.url)),
        skillBinding,
      });
    } catch (error) {
      throw asChildContractError(error, "effect_profile_activation_failed");
    }
    writeEvent({ type: "subagent007.activation_confirmed", receipt });
  } else if (request.effectProfile === "skill_creator_authoring_v1") {
    writeEvent({ type: "subagent007.activation_confirmed", receipt: skillCreatorAuthoringV1ActivationReceipt(skillBinding) });
  } else if (request.effectProfile === "task_root_authoring_v1") {
    writeEvent({
      type: "subagent007.activation_confirmed",
      receipt: taskRootAuthoringV1ActivationReceipt(skillBinding, effectScopeBinding!),
    });
  } else if (isBounded && boundedBindings) {
    writeEvent({
      type: "subagent007.activation_confirmed",
      receipt: boundedAuthoringActivationReceipt({
        effectProfile: boundedProfile,
        skillBinding,
        toolBindings: boundedBindings,
        effectScopeBinding: effectScopeBinding!,
      }),
    });
  } else if (request.expectedSkillSha256 && skillBinding) {
    writeEvent({
      type: "subagent007.activation_confirmed",
      receipt: skillOnlyActivationReceipt(skillBinding),
    });
  }

  if (request.skillSnapshotBinding && expectedSnapshotReceipt && request.skill) {
    let confirmed: SkillSnapshotActivationReceipt;
    try {
      confirmed = (await resolveSkillSnapshotLaunchBinding({
        skill_name: request.skill,
        binding: request.skillSnapshotBinding,
      })).receipt;
    } catch (error) {
      throw asChildContractError(error, "skill_snapshot_activation_failed");
    }
    if (JSON.stringify(confirmed) !== JSON.stringify(expectedSnapshotReceipt)) {
      throw new ChildContractError("skill snapshot changed during child activation", "skill_snapshot_activation_failed");
    }
    writeEvent({ type: "subagent007.skill_snapshot_activation_confirmed", receipt: confirmed });
  }

  const unsubscribe = session.subscribe((event) => writeEvent(event));
  try {
    writeEvent({ type: "subagent007.lifecycle", event: "child_prompt_submitted" });
    await session.prompt(request.prompt);
    const finalText = textFromLastAssistantMessage(session.messages);
    if (request.outputLastMessagePath && request.outputMode === "final") {
      await fs.writeFile(request.outputLastMessagePath, finalText, "utf8");
    }
  } finally {
    unsubscribe();
    inputControl.dispose();
    session.dispose();
  }
}

main().catch((error: unknown) => {
  writeEvent({
    type: "subagent007.error",
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof ChildContractError ? { reason_code: error.reasonCode } : {}),
  });
  process.exitCode = 1;
});
