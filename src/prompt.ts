import type { PromptProvenance, SessionPacketPolicy } from "./types.js";

export function composePrompt({
  prompt,
  skill,
}: {
  prompt: string;
  skill?: string;
}): string {
  if (skill) {
    return [`/skill:${skill}`, "", "<prompt>", prompt, "</prompt>"].join("\n");
  }

  return prompt;
}

export function compactSkillMarker(skill: string): string {
  return `[server_contract] skill_name=${skill}`;
}

export function compactPacketMarker(packetPolicy: SessionPacketPolicy): string {
  return `[server_contract] packet_policy=${packetPolicy} contract_packet_v1 instruction applied`;
}

export function createPromptProvenance({
  publicPrompt,
  childPrompt,
  skill,
  packetPolicy,
}: {
  publicPrompt: string;
  childPrompt?: string;
  skill?: string;
  packetPolicy?: SessionPacketPolicy;
}): PromptProvenance {
  const promptForChild = childPrompt ?? publicPrompt;
  return {
    public_prompt: publicPrompt,
    ...(skill ? { skill_name: skill, skill_marker: compactSkillMarker(skill) } : {}),
    ...(packetPolicy && packetPolicy !== "none"
      ? { packet_policy: packetPolicy, packet_marker: compactPacketMarker(packetPolicy) }
      : {}),
    composed_child_prompt: composePrompt({ prompt: promptForChild, skill }),
  };
}
