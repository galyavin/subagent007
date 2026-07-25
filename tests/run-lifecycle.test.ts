import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import {
  terminalRunTaskEventDetails,
  terminalRunTaskStatus,
  type RunTaskTerminalStatusInput,
} from "../src/runLifecycle.js";
import { terminalEventsProjection } from "../src/runEvents.js";
import type { RunPublicEvent } from "../src/types.js";

function result(overrides: Partial<RunTaskTerminalStatusInput> = {}): RunTaskTerminalStatusInput {
  return {
    success: true,
    timed_out: false,
    stop_reason: "completed",
    ...overrides,
  };
}

test("current run persistence is one claim without copied public views or an event journal", async () => {
  const [runTaskSource, runEventsSource] = await Promise.all([
    fs.readFile(new URL("../src/runTask.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/runEvents.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(runTaskSource, /RunOwnerRecordV1|public_view:\s*(snapshot|view)|ownerRecordWriteChains/);
  assert.doesNotMatch(runEventsSource, /events\.jsonl|appendFile|removeRunPublicEvents/);
});

test("R19 remains PID plus exact owner-instance process-title live/gone/unknown", async () => {
  const source = await fs.readFile(new URL("../src/clientStartAdmission.ts", import.meta.url), "utf8");
  assert.match(source, /process\.title\s*=\s*title/);
  assert.match(source, /stdout\.trim\(\) === ownerProcessTitle\(admission\.owner_instance_id\) \? "live" : "gone"/);
  assert.match(source, /processIsDefinitelyGone\(admission\.owner_pid\) \? "gone" : "unknown"/);
});

test("terminalRunTaskStatus maps successful and failed process results", () => {
  assert.equal(terminalRunTaskStatus(result({ success: true, stop_reason: "completed" })), "completed");
  assert.equal(terminalRunTaskStatus(result({ success: false, stop_reason: "failed" })), "failed");
});

test("terminalRunTaskStatus gives cancellation and timeout precedence", () => {
  assert.equal(
    terminalRunTaskStatus(result({ success: true, stop_reason: "cancelled", status: "completed" })),
    "cancelled",
  );
  assert.equal(
    terminalRunTaskStatus(result({ success: true, timed_out: true, stop_reason: "completed" })),
    "timed_out",
  );
  assert.equal(
    terminalRunTaskStatus(result({ success: true, timed_out: false, stop_reason: "completed", status: "timed_out" })),
    "timed_out",
  );
});

test("terminalRunTaskEventDetails preserves terminal event projection", () => {
  assert.deepEqual(terminalRunTaskEventDetails(result({ stop_reason: "cancelled" })), {
    phase: "cancelled",
    event: "cancellation_settled",
    text: "[cancellation_settled] run cancelled",
    progressMessage: "run cancelled",
  });
  assert.deepEqual(terminalRunTaskEventDetails(result({ stop_reason: "timeout" })), {
    phase: "timed_out",
    event: "timeout",
    text: "[timeout] run timed out",
    progressMessage: "run timed out",
  });
  assert.deepEqual(terminalRunTaskEventDetails(result({ success: true, stop_reason: "completed" })), {
    phase: "completed",
    event: "completed",
    text: "[completed] run completed",
    progressMessage: "run completed",
  });
  assert.deepEqual(terminalRunTaskEventDetails(result({ success: false, stop_reason: "failed" })), {
    phase: "failed",
    event: "failed",
    text: "[failed] run failed",
    progressMessage: "run failed",
  });
});

test("terminal event projection preserves exact event multiplicity and retains claim-bearing anchors within its bound", () => {
  const occurredAt = (offset: number) => new Date(Date.parse("2026-07-22T00:00:00.000Z") + offset).toISOString();
  const started: RunPublicEvent = {
    kind: "task",
    event: "run_started",
    text: "started",
    occurred_at: occurredAt(0),
  };
  const spawned: RunPublicEvent = {
    kind: "child",
    event: "child_spawned",
    text: "spawned",
    occurred_at: occurredAt(1),
  };
  const later = Array.from({ length: 30 }, (_, index): RunPublicEvent => ({
    kind: "warning",
    event: "message",
    text: `warning ${index}`,
    occurred_at: occurredAt(index + 2),
  }));
  const terminal: RunPublicEvent = {
    kind: "terminal",
    event: "completed",
    text: "completed",
    occurred_at: occurredAt(32),
  };

  const projectedExact = terminalEventsProjection([
    started,
    spawned,
    structuredClone(spawned),
    ...later,
    terminal,
  ]);
  const projectedDistinct = terminalEventsProjection([
    started,
    spawned,
    { ...spawned, occurred_at: occurredAt(2) },
    ...later,
    terminal,
  ]);
  assert.equal(projectedExact.length <= 25, true);
  assert.equal(projectedExact.filter((event) => event.event === "child_spawned").length, 2);
  assert.equal(projectedExact.includes(started), true);
  assert.equal(projectedExact.includes(terminal), true);
  assert.equal(projectedDistinct.length <= 25, true);
  assert.equal(projectedDistinct.filter((event) => event.event === "child_spawned").length, 2);
});

test("terminal event projection preserves byte-identical general lifecycle observations", () => {
  const lifecycle: RunPublicEvent = {
    kind: "child",
    event: "child_bridge_started",
    text: "[child_bridge_started] Pi child bridge started",
    occurred_at: "2026-07-22T00:00:00.000Z",
    schema_version: 1,
  };

  const projected = terminalEventsProjection([
    lifecycle,
    structuredClone(lifecycle),
  ]);

  assert.equal(projected.length, 2);
  assert.deepEqual(projected[0], projected[1]);
});
