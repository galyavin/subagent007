import type { DurableRunStatus } from "./durableRunContract.js";
import type { RunStopReason } from "./types.js";

export type RunTaskActivePhase =
  | "starting"
  | "queued"
  | "awaiting_child_event"
  | "running_silent"
  | "running"
  | "input_required"
  | "cancelling"
  | "timed_out"
  | "cancelled"
  | "completed"
  | "failed";

export type RunTaskTerminalEventName = "cancellation_settled" | "timeout" | "completed" | "failed";
export type RunTaskTerminalStatus = Extract<DurableRunStatus, "completed" | "failed" | "cancelled" | "timed_out">;

export interface RunTaskTerminalStatusInput {
  success: boolean;
  timed_out: boolean;
  stop_reason: RunStopReason;
  status?: DurableRunStatus;
}

export interface RunTaskTerminalEventDetails {
  phase: RunTaskActivePhase;
  event: RunTaskTerminalEventName;
  text: string;
  progressMessage: string;
}

export function terminalRunTaskStatus(result: RunTaskTerminalStatusInput): RunTaskTerminalStatus {
  if (result.stop_reason === "cancelled" || result.status === "cancelled") {
    return "cancelled";
  }
  if (result.timed_out || result.stop_reason === "timeout" || result.status === "timed_out") {
    return "timed_out";
  }
  return result.success ? "completed" : "failed";
}

export function terminalRunTaskEventDetails(
  result: Pick<RunTaskTerminalStatusInput, "success" | "stop_reason">,
): RunTaskTerminalEventDetails {
  if (result.stop_reason === "cancelled") {
    return {
      phase: "cancelled",
      event: "cancellation_settled",
      text: "[cancellation_settled] run cancelled",
      progressMessage: "run cancelled",
    };
  }
  if (result.stop_reason === "timeout") {
    return {
      phase: "timed_out",
      event: "timeout",
      text: "[timeout] run timed out",
      progressMessage: "run timed out",
    };
  }
  if (result.success) {
    return {
      phase: "completed",
      event: "completed",
      text: "[completed] run completed",
      progressMessage: "run completed",
    };
  }
  return {
    phase: "failed",
    event: "failed",
    text: "[failed] run failed",
    progressMessage: "run failed",
  };
}
