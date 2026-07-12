import fs from "node:fs/promises";
import path from "node:path";
import type { RunPublicEvent } from "./types.js";

const MAX_RECENT_EVENTS = 25;
const MAX_PUBLIC_OUTPUT_EXCERPT_CHARS = 1000;
const MAX_PUBLIC_EVENT_TEXT_CHARS = 4000;

const REDACTED_PATTERNS = [
  /<subagent007_contract_packet>[\s\S]*?<\/subagent007_contract_packet>/gi,
  /```[ \t]*contract_packet_v1[\s\S]*?```/gi,
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /\braw thinking\b[\s\S]{0,200}/gi,
];

function runEventFilePath(runTasksDir: string, runId: string): string {
  return path.join(runTasksDir, `${runId}.events.jsonl`);
}

function redactPublicEventText(text: string): string {
  let next = text;
  for (const pattern of REDACTED_PATTERNS) {
    next = next.replace(pattern, "[redacted]");
  }
  return next;
}

function truncatePublicEventText(text: string): string {
  if (text.length <= MAX_PUBLIC_EVENT_TEXT_CHARS) {
    return text;
  }
  return `${text.slice(0, Math.max(0, MAX_PUBLIC_EVENT_TEXT_CHARS - 15))}[truncated]`;
}

function sanitizePublicEvent(event: RunPublicEvent): RunPublicEvent {
  return {
    ...event,
    schema_version: 1,
    text: truncatePublicEventText(redactPublicEventText(event.text)),
    metadata: event.metadata ? JSON.parse(JSON.stringify(event.metadata)) as Record<string, unknown> : undefined,
  };
}

export async function appendRunPublicEvent(
  runTasksDir: string,
  runId: string,
  event: RunPublicEvent,
): Promise<RunPublicEvent> {
  const sanitized = sanitizePublicEvent(event);
  await fs.mkdir(runTasksDir, { recursive: true });
  await fs.appendFile(runEventFilePath(runTasksDir, runId), `${JSON.stringify(sanitized)}\n`, "utf8");
  return sanitized;
}

export async function readRunPublicEvents(
  runTasksDir: string,
  runId: string,
): Promise<RunPublicEvent[]> {
  let text: string;
  try {
    text = await fs.readFile(runEventFilePath(runTasksDir, runId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const events: RunPublicEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as RunPublicEvent;
      if (
        parsed &&
        typeof parsed.kind === "string" &&
        typeof parsed.text === "string" &&
        typeof parsed.occurred_at === "string"
      ) {
        events.push(sanitizePublicEvent(parsed));
      }
    } catch {
      return [];
    }
  }
  return events;
}

export async function removeRunPublicEvents(runTasksDir: string, runId: string): Promise<void> {
  await fs.rm(runEventFilePath(runTasksDir, runId), { force: true });
}

export function recentEventsProjection(events: RunPublicEvent[]): RunPublicEvent[] {
  return events.slice(-MAX_RECENT_EVENTS);
}

export function terminalEventsProjection(events: RunPublicEvent[]): RunPublicEvent[] {
  const unique: RunPublicEvent[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const key = JSON.stringify(event);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(event);
    }
  }
  const recent = recentEventsProjection(unique);
  const started = unique.find((event) => event.event === "run_started");
  if (!started || recent.includes(started)) {
    return recent;
  }
  return [started, ...recent.slice(-(MAX_RECENT_EVENTS - 1))];
}

export function publicOutputExcerptProjection(events: RunPublicEvent[]): string | undefined {
  const text = events.map((event) => event.text).filter((value) => value.trim() !== "").join("\n\n");
  if (text === "") {
    return undefined;
  }
  return text.length <= MAX_PUBLIC_OUTPUT_EXCERPT_CHARS
    ? text
    : text.slice(text.length - MAX_PUBLIC_OUTPUT_EXCERPT_CHARS);
}
