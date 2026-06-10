import { z } from "zod";
import type { ContractPacketV1, PacketParseStatus } from "./types.js";

export const CONTRACT_PACKET_FENCE = "contract_packet_v1";

const packetFindingSchema = z.object({
  severity: z.enum(["high", "medium", "low"]),
  claim: z.string(),
  evidence: z.string(),
  required_repair: z.string().optional(),
});

const packetSchema = z
  .object({
    verdict: z.enum(["ready", "needs_repair", "blocked", "inconclusive"]),
    summary: z.string(),
    findings: z.array(packetFindingSchema),
    blockers: z.array(z.string()),
    next_step: z.string(),
    closure: z
      .object({
        canonical_closure_source: z.string().optional(),
        artifact_roles: z.array(z.object({ path: z.string(), role: z.string() })).optional(),
        validation: z.array(z.string()).optional(),
        claim_ceiling: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

export interface PacketExtractionResult {
  status: PacketParseStatus;
  packet: ContractPacketV1 | null;
  error?: string;
}

export function appendContractPacketInstruction(prompt: string): string {
  return [
    prompt.trimEnd(),
    "",
    "<subagent007_contract_packet>",
    `End your final response with one fenced code block whose info string is exactly \`${CONTRACT_PACKET_FENCE}\`.`,
    "The JSON is a model-authored claimed handoff packet, not authoritative task evidence.",
    "Allowed verdict values: ready, needs_repair, blocked, inconclusive.",
    "Allowed finding severity values: high, medium, low.",
    "Use this JSON shape and no comments inside the JSON:",
    `\`\`\`${CONTRACT_PACKET_FENCE}`,
    JSON.stringify(
      {
        verdict: "inconclusive",
        summary: "One concise sentence.",
        findings: [
          {
            severity: "low",
            claim: "Claim being made.",
            evidence: "Evidence or source basis for that claim.",
            required_repair: "Optional repair when applicable.",
          },
        ],
        blockers: ["Concrete blocker, or use an empty array."],
        next_step: "Smallest useful next action.",
      },
      null,
      2,
    ),
    "```",
    "Optional closure fields may be added under `closure`: canonical_closure_source, artifact_roles, validation, claim_ceiling.",
    "</subagent007_contract_packet>",
  ].join("\n");
}

export function extractContractPacket(output: string): PacketExtractionResult {
  const fencePattern = CONTRACT_PACKET_FENCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [
    ...output.matchAll(new RegExp(`\`\`\`[ \\t]*${fencePattern}[^\\n]*\\n([\\s\\S]*?)\`\`\``, "g")),
  ];
  const match = matches.at(-1);
  if (!match) {
    return { status: "missing", packet: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch (error) {
    return {
      status: "invalid",
      packet: null,
      error: `${CONTRACT_PACKET_FENCE} is not valid JSON: ${(error as Error).message}`,
    };
  }

  const result = packetSchema.safeParse(parsed);
  if (!result.success) {
    return {
      status: "invalid",
      packet: null,
      error: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    };
  }

  return { status: "valid", packet: result.data };
}
