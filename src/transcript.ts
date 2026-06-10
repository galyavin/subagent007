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
    .filter((part): part is { type?: string; text?: string } =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    )
    .map((part) => part.text ?? "")
    .filter((text) => text.trim() !== "");
}

function eventMessageText(event: Record<string, unknown>): string | null {
  const message = event.message;
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const role = (message as { role?: unknown }).role;
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const text = textPartsFromContent((message as { content?: unknown }).content).join("");
  if (text.trim() === "") {
    return null;
  }
  return role === "user" ? `[user]\n${text}` : `[assistant]\n${text}`;
}

function publicLineForEvent(event: Record<string, unknown>): string | null {
  switch (event.type) {
    case "subagent007.error": {
      const error = typeof event.error === "string" ? event.error : "unknown error";
      return `[subagent007 error] ${error}`;
    }
    case "subagent007.warning": {
      const message = typeof event.message === "string" ? event.message : "warning";
      return `[subagent007 warning] ${message}`;
    }
    case "message_end":
      return eventMessageText(event);
    default:
      return null;
  }
}

function publicMarkerLine(line: string): string | null {
  const trimmed = line.trim();
  return trimmed.startsWith("[subagent007 timeout]") || trimmed === "[subagent007 cancelled]"
    ? trimmed
    : null;
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

export function publicTranscriptFromProcessOutput(rawOutput: string): string {
  const publicLines: string[] = [];
  const rawLines: string[] = [];
  let sawStructuredEvent = false;

  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    const markerLine = publicMarkerLine(line);
    if (markerLine) {
      publicLines.push(markerLine);
      rawLines.push(markerLine);
      continue;
    }
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (typeof parsed === "object" && parsed !== null) {
          sawStructuredEvent = true;
          const publicLine = publicLineForEvent(parsed as Record<string, unknown>);
          if (publicLine) {
            publicLines.push(publicLine);
          }
          continue;
        }
      } catch {
        // Fall through and keep non-JSON text below.
      }
    }
    if (line.trim() !== "") {
      rawLines.push(line);
    }
  }

  const text = sawStructuredEvent
    ? publicLines.join("\n\n")
    : rawLines.join("\n");
  const fallback = sawStructuredEvent && text.trim() === ""
    ? "[subagent007 transcript unavailable: no public events captured]"
    : text;
  return truncateUtf8(fallback, maxTranscriptBytes());
}
