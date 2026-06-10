export const DEFAULT_TIMEOUT_RESPONSE_HEADROOM_MS = 5000;
export const DEFAULT_TIMEOUT_KILL_GRACE_MS = 1000;
export const DEFAULT_TIMEOUT_FORCE_GRACE_MS = 1000;
export const DEFAULT_MIN_REQUESTED_TIMEOUT_MS = 0;
const MIN_EFFECTIVE_TIMEOUT_MS = 1;

export interface TimeoutBudget {
  requestedTimeoutMs: number | null;
  resolvedTimeoutMs: number | null;
  minRequestedTimeoutMs: number;
  effectiveTimeoutMs: number | null;
  responseHeadroomMs: number;
  killGraceMs: number;
  forceGraceMs: number;
}

export interface TimeoutBudgetOptions {
  minRequestedTimeoutMs?: number;
  responseHeadroomMs?: number;
  killGraceMs?: number;
  forceGraceMs?: number;
}

function nonnegativeIntegerFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function resolveOptions(options: TimeoutBudgetOptions = {}): Required<TimeoutBudgetOptions> {
  return {
    minRequestedTimeoutMs:
      options.minRequestedTimeoutMs ??
      nonnegativeIntegerFromEnv(
        "SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS",
        DEFAULT_MIN_REQUESTED_TIMEOUT_MS,
      ),
    responseHeadroomMs:
      options.responseHeadroomMs ??
      nonnegativeIntegerFromEnv(
        "SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS",
        DEFAULT_TIMEOUT_RESPONSE_HEADROOM_MS,
      ),
    killGraceMs:
      options.killGraceMs ??
      nonnegativeIntegerFromEnv("SUBAGENT007_TIMEOUT_KILL_GRACE_MS", DEFAULT_TIMEOUT_KILL_GRACE_MS),
    forceGraceMs:
      options.forceGraceMs ??
      nonnegativeIntegerFromEnv(
        "SUBAGENT007_TIMEOUT_FORCE_GRACE_MS",
        DEFAULT_TIMEOUT_FORCE_GRACE_MS,
      ),
  };
}

export function computeTimeoutBudget(
  requestedTimeoutMs: number | undefined,
  options: TimeoutBudgetOptions = {},
): TimeoutBudget {
  const resolved = resolveOptions(options);
  if (requestedTimeoutMs === undefined) {
    return {
      requestedTimeoutMs: null,
      resolvedTimeoutMs: null,
      minRequestedTimeoutMs: resolved.minRequestedTimeoutMs,
      effectiveTimeoutMs: null,
      responseHeadroomMs: resolved.responseHeadroomMs,
      killGraceMs: resolved.killGraceMs,
      forceGraceMs: resolved.forceGraceMs,
    };
  }

  const resolvedTimeoutMs = Math.max(requestedTimeoutMs, resolved.minRequestedTimeoutMs);
  const reservedMs = resolved.responseHeadroomMs + resolved.killGraceMs + resolved.forceGraceMs;
  return {
    requestedTimeoutMs,
    resolvedTimeoutMs,
    minRequestedTimeoutMs: resolved.minRequestedTimeoutMs,
    effectiveTimeoutMs: Math.max(MIN_EFFECTIVE_TIMEOUT_MS, resolvedTimeoutMs - reservedMs),
    responseHeadroomMs: resolved.responseHeadroomMs,
    killGraceMs: resolved.killGraceMs,
    forceGraceMs: resolved.forceGraceMs,
  };
}

export function minimumRequestedTimeoutMs(options: TimeoutBudgetOptions = {}): number {
  const resolved = resolveOptions(options);
  const reservedMs = resolved.responseHeadroomMs + resolved.killGraceMs + resolved.forceGraceMs;
  return Math.max(resolved.minRequestedTimeoutMs, reservedMs + MIN_EFFECTIVE_TIMEOUT_MS);
}
