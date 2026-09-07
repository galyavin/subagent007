import { MODEL_CLASSES, ValidationError, type ModelClass, type ThinkingLevel } from "./types.js";

const KNOWN_MODEL_PROVIDERS = ["openai-codex", "ollama", "openrouter"] as const;
export type KnownModelProvider = (typeof KNOWN_MODEL_PROVIDERS)[number];

export const OPENAI_CODEX_GPT54_PLUS_REF = "openai-codex/gpt-5.4+";
const OPENAI_CODEX_MIN_GPT5_MINOR = 4;

export const CURATED_EXACT_MODEL_REFS = [
  "openai-codex/gpt-5.3-codex-spark",
  "openai-codex/gpt-6-astra",
  "openrouter/deepseek/deepseek-v4-flash",
  "openrouter/deepseek/deepseek-v4-pro-0813",
  "openrouter/anthropic/claude-sonnet-5",
  "openrouter/google/gemini-3.7-flash",
  "openrouter/qwen/qwen3.8-2.4t-a95b",
  "openrouter/x-ai/grok-4.6",
  "openrouter/z-ai/glm-5.3-flash",
] as const;

/**
 * Runtime-only fallbacks for exact models that may arrive in a provider
 * catalog before the bundled Pi model registry ships a native definition.
 * The fallback supplies transport metadata; the request still uses the exact
 * target model id and remains gated by the configured provider auth.
 */
export const MODEL_RUNTIME_FALLBACKS = {
  "openrouter/deepseek/deepseek-v4-pro-0813": {
    template: "openrouter/deepseek/deepseek-v4-pro",
    name: "DeepSeek: DeepSeek V4 Pro 0813",
    contextWindow: 1_048_576,
    maxTokens: 384_000,
  },
  "openrouter/google/gemini-3.7-flash": {
    template: "openrouter/google/gemini-3.5-flash",
    name: "Google: Gemini 3.7 Flash",
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  "openrouter/qwen/qwen3.8-2.4t-a95b": {
    template: "openrouter/z-ai/glm-5.2",
    name: "Qwen: Qwen3.8 2.4T A95B",
    contextWindow: 1_048_576,
    maxTokens: 262_144,
  },
  "openrouter/x-ai/grok-4.6": {
    template: "openrouter/x-ai/grok-4.5",
    name: "SpaceXAI: Grok 4.6",
    contextWindow: 500_000,
    maxTokens: 450_000,
  },
  "openrouter/z-ai/glm-5.3-flash": {
    template: "openrouter/z-ai/glm-5.2",
    name: "Z.ai: GLM 5.3 Flash",
    contextWindow: 1_310_720,
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
    model: "openai-codex/gpt-5.3-codex-spark",
    thinkingLevel: "medium",
    description: "Lowest-complexity class for narrow read-only audits, low-risk probes, and concise first-pass judgment.",
  },
  B: {
    model: "openai-codex/gpt-5.3-codex-spark",
    thinkingLevel: "xhigh",
    description: "Simple coding, review, or search tasks with limited ambiguity.",
  },
  C: {
    model: "openai-codex/gpt-5.6-terra",
    thinkingLevel: "xhigh",
    description: "Default class for bounded implementation, repo-grounded fixes, and ordinary technical reasoning.",
  },
  D: {
    model: "openai-codex/gpt-5.6-sol",
    thinkingLevel: "medium",
    description: "Complex multi-file debugging, planning, synthesis, and high-abstraction work.",
  },
  E: {
    model: "openai-codex/gpt-6-astra",
    thinkingLevel: "low",
    description: "Highest-abstraction, highest-difficulty work requiring the deepest technical judgment.",
  },
  Z1: {
    model: "openrouter/deepseek/deepseek-v4-pro-0813",
    thinkingLevel: "xhigh",
    description: "External expert class for maximum-difficulty work requiring an independent frontier-model perspective.",
  },
  Z2: {
    model: "openrouter/z-ai/glm-5.3-flash",
    thinkingLevel: "xhigh",
    description: "External expert class for maximum-difficulty work requiring an independent technical perspective.",
  },
  Z3: {
    model: "openrouter/qwen/qwen3.8-2.4t-a95b",
    thinkingLevel: "xhigh",
    description: "External expert class for maximum-difficulty work requiring deep synthesis and independent judgment.",
  },
  Z4: {
    model: "openrouter/x-ai/grok-4.6",
    thinkingLevel: "xhigh",
    description: "External expert class for maximum-difficulty work requiring an independent frontier-model perspective.",
  },
  Z5: {
    model: "openrouter/google/gemini-3.7-flash",
    thinkingLevel: "xhigh",
    description: "External expert class for maximum-difficulty work requiring the deepest independent synthesis.",
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
