import { ValidationError } from "./types.js";

export const KNOWN_MODEL_PROVIDERS = ["openai-codex", "ollama", "openrouter"] as const;
export type KnownModelProvider = (typeof KNOWN_MODEL_PROVIDERS)[number];

export const OPENAI_CODEX_GPT54_PLUS_REF = "openai-codex/gpt-5.4+";
export const OPENAI_CODEX_MIN_GPT5_MINOR = 4;

export const CURATED_EXACT_MODEL_REFS = [
  "ollama/gemma4:12b",
  "openrouter/deepseek/deepseek-v4-flash",
  "openrouter/deepseek/deepseek-v4-pro",
  "openrouter/~anthropic/claude-sonnet-latest",
  "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/moonshotai/kimi-k2.6:free",
] as const;

export function allowedModelChoices(): string[] {
  return [OPENAI_CODEX_GPT54_PLUS_REF, ...CURATED_EXACT_MODEL_REFS];
}

export function formatAllowedModelChoices(): string {
  return allowedModelChoices().join(", ");
}

function normalizeModelRef(modelRef: string): string {
  return modelRef.trim().toLowerCase();
}

export function splitKnownProviderModelRef(modelRef: string): {
  provider?: KnownModelProvider;
  model: string;
} {
  const normalized = normalizeModelRef(modelRef);
  for (const provider of KNOWN_MODEL_PROVIDERS) {
    const prefix = `${provider}/`;
    if (normalized.startsWith(prefix)) {
      return { provider, model: normalized.slice(prefix.length) };
    }
  }
  return { model: normalized };
}

export function isOpenAICodexGpt54OrNewerModelId(modelId: string): boolean {
  const match = /^gpt-5\.(\d+)(?:$|[-.].*)/.exec(normalizeModelRef(modelId));
  return Boolean(match && Number.parseInt(match[1], 10) >= OPENAI_CODEX_MIN_GPT5_MINOR);
}

export function isAllowedModelRef(modelRef: string): boolean {
  const { provider, model } = splitKnownProviderModelRef(repairKnownModelAlias(modelRef));
  if ((provider === undefined || provider === "openai-codex") && isOpenAICodexGpt54OrNewerModelId(model)) {
    return true;
  }

  return CURATED_EXACT_MODEL_REFS.some((allowedRef) => {
    const allowed = splitKnownProviderModelRef(allowedRef);
    return allowed.model === model && (provider === undefined || provider === allowed.provider);
  });
}

export function repairKnownModelAlias(modelRef: string): string {
  const normalized = normalizeModelRef(modelRef);
  if (
    normalized === "openrouter/anthropic/claude-sonnet-4.5" ||
    normalized === "anthropic/claude-sonnet-4.5"
  ) {
    return "openrouter/~anthropic/claude-sonnet-latest";
  }
  return modelRef.trim();
}

export function resolveAllowedModelRef(modelRef: string): string {
  const repaired = repairKnownModelAlias(modelRef);
  if (isAllowedModelRef(repaired)) {
    return repaired;
  }
  throw new ValidationError(
    `model ${JSON.stringify(modelRef)} is not in the curated Subagent007 Pi allowlist; allowed models: ${
      formatAllowedModelChoices()
    }`,
  );
}
