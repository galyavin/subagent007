import type {
  EffectProfile,
  ResearchControllerTerminalReceipt,
  RunOutputReference,
  RunStatus,
} from "./types.js";

export type TerminalActivationClass =
  | "other"
  | "researcher_v3_legacy"
  | "researcher_v4_strict";

export interface TerminalProjectionInput {
  requestedEffectProfile?: EffectProfile;
  activationClass: TerminalActivationClass;
  status: Extract<RunStatus, "completed" | "failed" | "cancelled" | "timed_out">;
  outputReferences: readonly RunOutputReference[];
  controllerTerminalReceipt?: ResearchControllerTerminalReceipt;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactLegacyReceipt(value: unknown): boolean {
  const receipt = record(value);
  return Boolean(
    receipt &&
    exactKeys(receipt, [
      "schema_version",
      "controller",
      "state",
      "validation",
      "job_sha256",
      "render_profile",
      "render_sha256",
    ]) &&
    receipt.schema_version === 1 &&
    receipt.controller === "researchctl" &&
    receipt.state === "complete" &&
    receipt.validation === "passed" &&
    typeof receipt.job_sha256 === "string" &&
    SHA256_PATTERN.test(receipt.job_sha256) &&
    receipt.render_profile === "full" &&
    typeof receipt.render_sha256 === "string" &&
    SHA256_PATTERN.test(receipt.render_sha256),
  );
}

function exactStrictReceipt(
  value: unknown,
  primary: RunOutputReference,
  packet: RunOutputReference,
): boolean {
  const receipt = record(value);
  return Boolean(
    receipt &&
    exactKeys(receipt, [
      "schema_version",
      "controller",
      "state",
      "validation",
      "dispatch_protocol",
      "job_sha256",
      "primary_profile",
      "primary_sha256",
      "packet_profile",
      "packet_sha256",
    ]) &&
    receipt.schema_version === 2 &&
    receipt.controller === "researchctl" &&
    receipt.state === "complete" &&
    receipt.validation === "passed" &&
    receipt.dispatch_protocol === "research_web_dispatch_v1" &&
    typeof receipt.job_sha256 === "string" &&
    SHA256_PATTERN.test(receipt.job_sha256) &&
    receipt.primary_profile === "primary" &&
    receipt.primary_sha256 === primary.content_sha256 &&
    receipt.packet_profile === "bendum" &&
    receipt.packet_sha256 === packet.content_sha256,
  );
}

function exactOutputRoles(outputReferences: readonly RunOutputReference[]): {
  primary?: RunOutputReference;
  packet?: RunOutputReference;
  valid: boolean;
} {
  const primary = outputReferences.filter((reference) => reference.name === "primary");
  const packet = outputReferences.filter((reference) => reference.name === "packet");
  return {
    primary: primary[0],
    packet: packet[0],
    valid:
      outputReferences.length >= 1 &&
      outputReferences.length <= 2 &&
      primary.length === 1 &&
      packet.length === outputReferences.length - 1 &&
      new Set(outputReferences.map((reference) => reference.relative_path)).size === outputReferences.length &&
      packet.every((reference) => reference.output_mode === "final") &&
      (packet.length === 0 || primary.every((reference) => reference.output_mode === "final")),
  };
}

/**
 * Structural/projection consistency only. This does not prove that controller
 * execution ran; callers must pass already-validated activation observations
 * and already-decoded exact output references.
 */
export function terminalProjectionIsValid(input: TerminalProjectionInput): boolean {
  const roles = exactOutputRoles(input.outputReferences);
  if (!roles.valid || !roles.primary) return false;
  const hasPacket = roles.packet !== undefined;
  const hasReceipt = input.controllerTerminalReceipt !== undefined;

  if (input.requestedEffectProfile !== "researcher_bounded_v1") {
    return input.activationClass === "other" && !hasPacket && !hasReceipt;
  }
  if (input.activationClass === "researcher_v3_legacy") {
    return !hasPacket && (
      !hasReceipt || exactLegacyReceipt(input.controllerTerminalReceipt)
    );
  }
  if (input.activationClass === "other") {
    return input.status !== "completed" && !hasPacket && !hasReceipt;
  }
  if (input.activationClass !== "researcher_v4_strict") return false;
  if (!hasPacket && !hasReceipt) {
    return input.status !== "completed";
  }
  if (!hasPacket || !hasReceipt) return false;
  if (!exactStrictReceipt(input.controllerTerminalReceipt, roles.primary, roles.packet!)) return false;
  return true;
}
