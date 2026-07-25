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

declare const canonicalRunPublicEventBrand: unique symbol;

export type CanonicalRunPublicEvent = RunPublicEvent & {
  readonly [canonicalRunPublicEventBrand]: true;
};

export function canonicalRunPublicEvent(event: RunPublicEvent): CanonicalRunPublicEvent {
  const { metadata, ...eventWithoutMetadata } = event;
  return {
    ...eventWithoutMetadata,
    schema_version: 1,
    text: truncatePublicEventText(redactPublicEventText(event.text)),
    ...(metadata
      ? { metadata: JSON.parse(JSON.stringify(metadata)) as Record<string, unknown> }
      : {}),
  } as CanonicalRunPublicEvent;
}

export function recentEventsProjection(events: RunPublicEvent[]): RunPublicEvent[] {
  if (events.length <= MAX_RECENT_EVENTS) return events;
  const started = events.find((event) => event.event === "run_started");
  const spawned = events.filter((event) =>
    event.kind === "child" && event.event === "child_spawned"
  ).slice(0, 2);
  const anchors = [started, ...spawned].filter((event): event is RunPublicEvent => event !== undefined);
  const anchorSet = new Set(anchors);
  const tail = events
    .filter((event) => !anchorSet.has(event))
    .slice(-(MAX_RECENT_EVENTS - anchors.length));
  const retained = new Set([...anchors, ...tail]);
  return events.filter((event) => retained.has(event));
}

export function terminalEventsProjection(events: RunPublicEvent[]): RunPublicEvent[] {
  return recentEventsProjection(events);
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
