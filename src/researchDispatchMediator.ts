import { createHash } from "node:crypto";
import type {
  ExtensionFactory,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { ResearchDispatchController } from "./boundedController.js";

const RESEARCH_WEB_TOOLS = new Set(["web_search", "web_read"]);

interface ControllerEnvelope {
  success: boolean;
  stdout?: string;
  stderr?: string;
}

interface ResearchDispatchMediatorOptions {
  controller: ResearchDispatchController;
  jobPath: string;
}

interface ClaimInput {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface ResultInput {
  toolCallId: string;
  toolName: string;
  content: ToolResultEvent["content"];
  isError: boolean;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("web tool arguments must be JSON-serializable");
  return encoded;
}

function controllerEnvelope(result: Awaited<ReturnType<ResearchDispatchController["execute"]>>): ControllerEnvelope {
  const text = result.content.find((item) => item.type === "text");
  if (!text || text.type !== "text") throw new Error("researchctl returned no text envelope");
  const value = JSON.parse(text.text) as Partial<ControllerEnvelope>;
  if (typeof value.success !== "boolean") throw new Error("researchctl returned an invalid envelope");
  return value as ControllerEnvelope;
}

export class ResearchDispatchMediator {
  private readonly claimed = new Set<string>();
  private readonly recording = new Set<string>();

  constructor(private readonly options: ResearchDispatchMediatorOptions) {}

  async claim(input: ClaimInput): Promise<ToolCallEventResult | undefined> {
    if (!RESEARCH_WEB_TOOLS.has(input.toolName)) return undefined;
    const argumentsJson = canonicalJson(input.input);
    try {
      const result = await this.options.controller.execute("claim-dispatch", [
        this.options.jobPath,
        "--tool-call-id",
        input.toolCallId,
        "--tool",
        input.toolName,
        "--arguments-json",
        argumentsJson,
      ]);
      const envelope = controllerEnvelope(result);
      if (!envelope.success) {
        return {
          block: true,
          reason: envelope.stderr?.trim() || "research web dispatch reservation was rejected",
        };
      }
      this.claimed.add(input.toolCallId);
      return undefined;
    } catch (error) {
      return {
        block: true,
        reason: `research web dispatch reservation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async record(input: ResultInput): Promise<void> {
    if (!RESEARCH_WEB_TOOLS.has(input.toolName)) return;
    if (!this.claimed.has(input.toolCallId) || this.recording.has(input.toolCallId)) {
      throw new Error(`research web dispatch ${input.toolCallId} was not claimed`);
    }
    this.recording.add(input.toolCallId);
    try {
      const resultBytes = canonicalJson(input.content);
      const result = await this.options.controller.execute("record-dispatch-result", [
        this.options.jobPath,
        "--tool-call-id",
        input.toolCallId,
        "--result",
        input.isError ? "error" : "returned",
        "--result-sha256",
        createHash("sha256").update(resultBytes, "utf8").digest("hex"),
      ]);
      const envelope = controllerEnvelope(result);
      if (!envelope.success) {
        throw new Error(envelope.stderr?.trim() || "research web dispatch result was rejected");
      }
      this.claimed.delete(input.toolCallId);
    } finally {
      this.recording.delete(input.toolCallId);
    }
  }
}

export function createResearchDispatchExtension(
  options: ResearchDispatchMediatorOptions,
): ExtensionFactory {
  const mediator = new ResearchDispatchMediator(options);
  return (pi) => {
    pi.on("tool_call", (event) =>
      mediator.claim({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
      }));
    pi.on("tool_result", async (event) => {
      if (!RESEARCH_WEB_TOOLS.has(event.toolName)) return undefined;
      try {
        await mediator.record({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          content: event.content,
          isError: event.isError,
        });
        return undefined;
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Research dispatch accounting failed: ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    });
  };
}
