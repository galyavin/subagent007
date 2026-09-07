import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * The Pi transport reads `model.maxTokens` for each provider completion. Keep
 * capability metadata intact unless this individual run explicitly opts into
 * a lower ceiling.
 */
export function modelWithOutputTokenCap(model: Model<Api>, maxOutputTokens?: number): Model<Api> {
  if (maxOutputTokens === undefined) return model;
  return {
    ...model,
    maxTokens: Math.min(model.maxTokens, maxOutputTokens),
  };
}
