import { MODEL_CLASSES, ValidationError, type ModelClass, type ThinkingLevel } from "./types.js";

const KNOWN_MODEL_PROVIDERS = ["openai-codex", "ollama", "openrouter"] as const;
export type KnownModelProvider = (typeof KNOWN_MODEL_PROVIDERS)[number];

export const OPENAI_CODEX_GPT54_PLUS_REF = "openai-codex/gpt-5.4+";
const OPENAI_CODEX_MIN_GPT5_MINOR = 4;

export const CURATED_EXACT_MODEL_REFS = [
  "ollama/qwen3.5:9b-mlx",
  "openrouter/deepseek/deepseek-v4-flash",
  "openrouter/deepseek/deepseek-v4-pro",
] as const;

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
    model: "ollama/qwen3.5:9b-mlx",
    thinkingLevel: "high",
    description: "Best local/offline class for narrow, low-risk tasks and concise first-pass judgment.",
  },
  B: {
    model: "openrouter/deepseek/deepseek-v4-flash",
    thinkingLevel: "high",
    description: "Simple coding, review, or search tasks with limited ambiguity.",
  },
  C: {
    model: "openrouter/deepseek/deepseek-v4-pro",
    thinkingLevel: "high",
    description: "Default class for ordinary software engineering and technical reasoning.",
  },
  D: {
    model: "openai-codex/gpt-5.5",
    thinkingLevel: "high",
    description: "Complex multi-file debugging, planning, synthesis, and high-abstraction work.",
  },
  E: {
    model: "openai-codex/gpt-5.5",
    thinkingLevel: "xhigh",
    description: "Highest-abstraction, highest-difficulty work requiring the deepest technical judgment.",
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
  );
}
