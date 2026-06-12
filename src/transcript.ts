import type { PromptProvenance, RunPublicEventKind, RunPublicEventName } from "./types.js";

const DEFAULT_MAX_TRANSCRIPT_BYTES = 256 * 1024;

function maxTranscriptBytes(): number {
  const raw = process.env.SUBAGENT007_MAX_TRANSCRIPT_BYTES;
  if (!raw || raw.trim() === "") {
    return DEFAULT_MAX_TRANSCRIPT_BYTES;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TRANSCRIPT_BYTES;
}

function textPartsFromContent(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    )
    .map((part) => part.text)
    .filter((text) => text.trim() !== "");
}

export interface PublicOutputLine {
  text: string;
  kind: RunPublicEventKind;
  event?: RunPublicEventName;
}

export interface PublicTranscript {
  text: string;
  hasAssistantText: boolean;
  hasSubagentWarning: boolean;
  hasSubagentError: boolean;
}

function removeTrailingTruncationMarker(value: string): string {
  return value.replace(/\n\n\[subagent007 transcript truncated at \d+ bytes\]\n$/, "");
}

function renderedHasLabeledContent(text: string, label: string): boolean {
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf(label, offset);
    if (index === -1) {
      return false;
    }
    const remainder = removeTrailingTruncationMarker(text.slice(index + label.length));
    if (remainder.trim() !== "") {
      return true;
    }
    offset = index + label.length;
  }
  return false;
}

export function publicTranscriptContentFlags(text: string): Omit<PublicTranscript, "text"> {
  return {
    hasAssistantText: renderedHasLabeledContent(text, "[assistant]\n"),
    hasSubagentWarning: renderedHasLabeledContent(text, "[subagent007 warning] "),
    hasSubagentError: renderedHasLabeledContent(text, "[subagent007 error] "),
  };
}

function eventMessageLine(event: Record<string, unknown>): PublicOutputLine | null {
  const message = event.message;
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const role = (message as { role?: unknown }).role;
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const text = textPartsFromContent((message as { content?: unknown }).content).join("");
  if (text === "") {
    return null;
  }
  return {
    text: role === "user" ? `[user]\n${text}` : `[assistant]\n${text}`,
    kind: role,
  };
}

function eventRequestId(event: Record<string, unknown>): string {
  return typeof event.request_id === "string" ? event.request_id : "unknown";
}

function publicLineForEvent(event: Record<string, unknown>): PublicOutputLine | null {
  switch (event.type) {
    case "subagent007.input_request": {
      const requestId = eventRequestId(event);
      const question = typeof event.question === "string" ? event.question : "";
      const suffix = question.trim() === "" ? "" : ` ${question.trim()}`;
      return { text: `[input_required] ${requestId}${suffix}`, kind: "input", event: "input_required" };
    }
    case "subagent007.input_timed_out": {
      const requestId = eventRequestId(event);
      return { text: `[input_timed_out] ${requestId}`, kind: "input", event: "input_timed_out" };
    }
    case "subagent007.input_closed": {
      const requestId = eventRequestId(event);
      return { text: `[input_closed] ${requestId}`, kind: "input", event: "input_closed" };
    }
    case "subagent007.error": {
      const error = typeof event.error === "string" ? event.error : "unknown error";
      return { text: `[subagent007 error] ${error}`, kind: "error", event: "failed" };
    }
    case "subagent007.warning": {
      const message = typeof event.message === "string" ? event.message : "warning";
      return { text: `[subagent007 warning] ${message}`, kind: "warning", event: "message" };
    }
    case "message_end":
      return eventMessageLine(event);
    default:
      return null;
  }
}

function publicMarkerLine(line: string): PublicOutputLine | null {
  const trimmed = line.trim();
  return trimmed.startsWith("[subagent007 timeout]") || trimmed === "[subagent007 cancelled]"
    ? {
        text: trimmed,
        kind: "terminal",
        event: trimmed.startsWith("[subagent007 timeout]") ? "timeout" : "cancellation_settled",
      }
    : null;
}

function eventObjectFromJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return value;
  }
  const marker = `\n\n[subagent007 transcript truncated at ${maxBytes} bytes]\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  return `${buffer.subarray(0, Math.max(0, maxBytes - markerBytes)).toString("utf8")}${marker}`;
}

function provenancePublicLines(promptProvenance?: PromptProvenance): PublicOutputLine[] {
  if (!promptProvenance) {
    return [];
  }
  return [
    { kind: "user", event: "message", text: `[user]\n${promptProvenance.public_prompt}` },
    ...(promptProvenance.skill_marker
      ? [{ kind: "task" as const, event: "message" as const, text: promptProvenance.skill_marker }]
      : []),
    ...(promptProvenance.packet_marker
      ? [{ kind: "packet" as const, event: "message" as const, text: promptProvenance.packet_marker }]
      : []),
  ];
}

export function preparePublicTranscriptFromProcessOutput(
  rawOutput: string,
  options: { promptProvenance?: PromptProvenance } = {},
): PublicTranscript {
  const initialPublicLines = provenancePublicLines(options.promptProvenance);
  const publicLines: PublicOutputLine[] = [...initialPublicLines];
  const rawLines: string[] = [];
  let sawStructuredEvent = false;

  for (const line of rawOutput.split(/\r?\n/)) {
    const markerLine = publicMarkerLine(line);
    if (markerLine) {
      publicLines.push(markerLine);
      rawLines.push(markerLine.text);
      continue;
    }
    const parsedEvent = eventObjectFromJsonLine(line);
    if (parsedEvent) {
      sawStructuredEvent = true;
      const publicLine = publicLineForEvent(parsedEvent);
      if (publicLine) {
        if (options.promptProvenance && publicLine.kind === "user") {
          continue;
        }
        publicLines.push(publicLine);
      }
      continue;
    }
    if (line.trim() !== "") {
      rawLines.push(line);
    }
  }

  const text = sawStructuredEvent
    ? publicLines.map((line) => line.text).join("\n\n")
    : [...initialPublicLines.map((line) => line.text), ...rawLines].join("\n\n");
  const fallback = sawStructuredEvent && text.trim() === ""
    ? "[subagent007 transcript unavailable: no public events captured]"
    : text;
  const renderedText = truncateUtf8(fallback, maxTranscriptBytes());
  return {
    text: renderedText,
    ...publicTranscriptContentFlags(renderedText),
  };
}

export function publicTranscriptFromProcessOutput(rawOutput: string): string {
  return preparePublicTranscriptFromProcessOutput(rawOutput).text;
}

export function publicOutputLineFromProcessLine(line: string): PublicOutputLine | null {
  const parsedEvent = eventObjectFromJsonLine(line);
  return parsedEvent ? publicLineForEvent(parsedEvent) : null;
}
