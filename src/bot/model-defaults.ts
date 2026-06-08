import type { ModelInfo, ReasoningEffort, ServiceTier } from '../agent/types';

export const BRIDGE_DEFAULT_MODEL_ID = 'gpt-5.5';
export const BRIDGE_DEFAULT_EFFORT: ReasoningEffort = 'medium';
export const BRIDGE_DEFAULT_SERVICE_TIER: ServiceTier = 'standard';

export function pickBridgeDefaults(models: ModelInfo[]): {
  model: string;
  effort: ReasoningEffort;
  serviceTier: ServiceTier;
} {
  const visible = models.filter((m) => !m.hidden);
  const def = visible.find((m) => m.id === BRIDGE_DEFAULT_MODEL_ID) ?? visible[0] ?? models[0];
  const supportsDefaultEffort = !def?.supportedEfforts.length || def.supportedEfforts.includes(BRIDGE_DEFAULT_EFFORT);
  return {
    model: def?.id ?? BRIDGE_DEFAULT_MODEL_ID,
    effort: supportsDefaultEffort ? BRIDGE_DEFAULT_EFFORT : (def?.defaultEffort ?? BRIDGE_DEFAULT_EFFORT),
    serviceTier: BRIDGE_DEFAULT_SERVICE_TIER,
  };
}
