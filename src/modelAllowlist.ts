import { ValidationError } from "./types.js";

export const KNOWN_MODEL_PROVIDERS = ["openai-codex", "ollama", "openrouter"] as const;
export type KnownModelProvider = (typeof KNOWN_MODEL_PROVIDERS)[number];

export const OPENAI_CODEX_GPT54_PLUS_REF = "openai-codex/gpt-5.4+";
export const SUGGESTED_DEFAULT_MODEL_REF = "openai-codex/gpt-5.4-mini";
export const OPENAI_CODEX_MIN_GPT5_MINOR = 4;

export const CURATED_EXACT_MODEL_REFS = [
  "ollama/gemma4:12b",
  "openrouter/deepseek/deepseek-v4-flash",
  "openrouter/deepseek/deepseek-v4-pro",
  "openrouter/~anthropic/claude-sonnet-latest",
  "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/moonshotai/kimi-k2.6",
] as const;

export function modelPatternChoices(): string[] {
  return [OPENAI_CODEX_GPT54_PLUS_REF];
}

export function exactModelChoices(): string[] {
  return [...CURATED_EXACT_MODEL_REFS];
}

export function allowedModelChoices(): string[] {
  return [...modelPatternChoices(), ...exactModelChoices()];
}

export function formatAllowedModelChoices(): string {
  return [
    `exact models: ${exactModelChoices().join(", ")}`,
    `patterns: ${modelPatternChoices().join(", ")} (pass a matching literal model, not the pattern)`,
  ].join("; ");
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

function canonicalAllowedModelRef(modelRef: string): string | null {
  const { provider, model } = splitKnownProviderModelRef(repairKnownModelAlias(modelRef));
  if ((provider === undefined || provider === "openai-codex") && isOpenAICodexGpt54OrNewerModelId(model)) {
    return `openai-codex/${model}`;
  }

  for (const allowedRef of CURATED_EXACT_MODEL_REFS) {
    const allowed = splitKnownProviderModelRef(allowedRef);
    if (allowed.model === model && (provider === undefined || provider === allowed.provider)) {
      return allowedRef;
    }
  }

  return null;
}

export function isAllowedModelRef(modelRef: string): boolean {
  return canonicalAllowedModelRef(modelRef) !== null;
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
  const resolved = canonicalAllowedModelRef(modelRef);
  if (resolved) {
    return resolved;
  }
  throw new ValidationError(
    `model ${JSON.stringify(modelRef)} is not in the curated Subagent007 Pi allowlist; allowed models: ${
      formatAllowedModelChoices()
    }`,
  );
}
