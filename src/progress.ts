import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { safeIntegerFromEnv } from "./env.js";

export type ServerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
export type HeartbeatNotify = (beat: number, message?: string) => void | Promise<void>;

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
export const DEFAULT_HEARTBEAT_MESSAGE = "running";
export const HEARTBEAT_INTERVAL_ENV = "SUBAGENT007_HEARTBEAT_INTERVAL_MS";

export function heartbeatIntervalMsFromEnv(): number {
  return safeIntegerFromEnv(HEARTBEAT_INTERVAL_ENV, DEFAULT_HEARTBEAT_INTERVAL_MS, 1);
}

export function heartbeatFromExtra(extra: ServerExtra): HeartbeatNotify | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) {
    return undefined;
  }

  return async (beat: number, message?: string) => {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: beat,
        message: message ?? DEFAULT_HEARTBEAT_MESSAGE,
      },
    });
  };
}
