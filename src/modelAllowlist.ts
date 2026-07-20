import { MODEL_CLASSES, ValidationError, type ModelClass, type ThinkingLevel } from "./types.js";

const KNOWN_MODEL_PROVIDERS = ["openai-codex", "ollama", "openrouter"] as const;
export type KnownModelProvider = (typeof KNOWN_MODEL_PROVIDERS)[number];

export const OPENAI_CODEX_GPT54_PLUS_REF = "openai-codex/gpt-5.4+";
const OPENAI_CODEX_MIN_GPT5_MINOR = 4;

export const CURATED_EXACT_MODEL_REFS = [
  "openrouter/deepseek/deepseek-v4-flash",
  "openrouter/deepseek/deepseek-v4-pro",
  "openrouter/moonshotai/kimi-k3",
  "openrouter/anthropic/claude-opus-4.8",
  "openrouter/z-ai/glm-5.2",
] as const;

/**
 * Runtime-only fallbacks for exact models that may arrive in a provider
 * catalog before the bundled Pi model registry ships a native definition.
 * The fallback supplies transport metadata; the request still uses the exact
 * target model id and remains gated by the configured provider auth.
 */
export const MODEL_RUNTIME_FALLBACKS = {
  "openrouter/moonshotai/kimi-k3": {
    template: "openrouter/z-ai/glm-5.2",
    name: "MoonshotAI: Kimi K3",
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  },
} as const;

function modelPatternChoices(): string[] {
  return [OPENAI_CODEX_GPT54_PLUS_REF];
}

function exactModelChoices(): string[] {
  return [...CURATED_EXACT_MODEL_REFS];
}

export const DEFAULT_MODEL_CLASS: ModelClass = "C";

export const MODEL_CLASS_CALIBRATIONS: Record<ModelClass, {
  model: string;
  thinkingLevel: ThinkingLevel;
  description: string;
}> = {
  A: {
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "low",
    description: "Lowest-complexity class for narrow read-only audits, low-risk probes, and concise first-pass judgment.",
  },
  B: {
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "medium",
    description: "Simple coding, review, or search tasks with limited ambiguity.",
  },
  C: {
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "xhigh",
    description: "Default class for bounded implementation, repo-grounded fixes, and ordinary technical reasoning.",
  },
  D: {
    model: "openai-codex/gpt-5.6-terra",
    thinkingLevel: "high",
    description: "Complex multi-file debugging, planning, synthesis, and high-abstraction work.",
  },
  E: {
    model: "openai-codex/gpt-5.6-sol",
    thinkingLevel: "high",
    description: "Highest-abstraction, highest-difficulty work requiring the deepest technical judgment.",
  },
  Z1: {
    model: "openrouter/moonshotai/kimi-k3",
    thinkingLevel: "xhigh",
    description: "External expert class for maximum-difficulty work requiring an independent frontier-model perspective.",
  },
  Z2: {
    model: "openrouter/anthropic/claude-opus-4.8",
    thinkingLevel: "xhigh",
    description: "External expert class for maximum-difficulty work requiring deep synthesis and independent judgment.",
  },
  Z3: {
    model: "openrouter/z-ai/glm-5.2",
    thinkingLevel: "xhigh",
    description: "External expert class for maximum-difficulty work requiring an independent technical perspective.",
  },
};

export function modelClassChoices(): ModelClass[] {
  return [...MODEL_CLASSES];
}

export function resolveModelClass(modelClass: ModelClass): {
  model: string;
  thinkingLevel: ThinkingLevel;
} {
  const calibration = MODEL_CLASS_CALIBRATIONS[modelClass];
  return {
    model: resolveAllowedModelRef(calibration.model),
    thinkingLevel: calibration.thinkingLevel,
  };
}

export function modelClassForResolvedPair(
  modelRef: string,
  thinkingLevel: ThinkingLevel,
): ModelClass | null {
  let resolvedModel: string;
  try {
    resolvedModel = resolveAllowedModelRef(modelRef);
  } catch {
    return null;
  }
  for (const modelClass of modelClassChoices()) {
    const calibration = MODEL_CLASS_CALIBRATIONS[modelClass];
    if (
      resolveAllowedModelRef(calibration.model) === resolvedModel &&
      calibration.thinkingLevel === thinkingLevel
    ) {
      return modelClass;
    }
  }
  return null;
}

function formatAllowedModelChoices(): string {
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
  const { provider, model } = splitKnownProviderModelRef(modelRef);
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

export function resolveAllowedModelRef(modelRef: string): string {
  const resolved = canonicalAllowedModelRef(modelRef);
  if (resolved) {
    return resolved;
  }
  throw new ValidationError(
    `model ${JSON.stringify(modelRef)} is not in the curated Subagent007 Pi allowlist; allowed models: ${
      formatAllowedModelChoices()
    }`,
    "invalid_model",
  );
}
