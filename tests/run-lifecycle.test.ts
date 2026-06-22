import assert from "node:assert/strict";
import { test } from "node:test";
import {
  terminalRunTaskEventDetails,
  terminalRunTaskStatus,
  type RunTaskTerminalStatusInput,
} from "../src/runLifecycle.js";

function result(overrides: Partial<RunTaskTerminalStatusInput> = {}): RunTaskTerminalStatusInput {
  return {
    success: true,
    timed_out: false,
    stop_reason: "completed",
    ...overrides,
  };
}

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
