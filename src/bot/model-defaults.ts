import type { ModelInfo, ReasoningEffort, ServiceTier } from '../agent/types';

export const BRIDGE_DEFAULT_MODEL_ID = 'gpt-5.5';
export const BRIDGE_DEFAULT_EFFORT: ReasoningEffort = 'medium';
export const BRIDGE_DEFAULT_SERVICE_TIER: ServiceTier = 'standard';

export function pickBridgeDefaults(
  models: ModelInfo[],
  project?: { defaultModel?: string; defaultEffort?: ReasoningEffort; defaultServiceTier?: ServiceTier },
): {
  model: string;
  effort: ReasoningEffort;
  serviceTier: ServiceTier;
} {
  const visible = models.filter((m) => !m.hidden);
  const requested = project?.defaultModel?.trim();
  const requestedEffort = project?.defaultEffort ?? BRIDGE_DEFAULT_EFFORT;
  const def = (requested ? visible.find((m) => m.id === requested) : undefined)
    ?? visible.find((m) => m.id === BRIDGE_DEFAULT_MODEL_ID)
    ?? visible[0]
    ?? models[0];
  const supportsRequestedEffort = !def?.supportedEfforts.length || def.supportedEfforts.includes(requestedEffort);
  return {
    model: def?.id ?? BRIDGE_DEFAULT_MODEL_ID,
    effort: supportsRequestedEffort ? requestedEffort : (def?.defaultEffort ?? BRIDGE_DEFAULT_EFFORT),
    serviceTier: project?.defaultServiceTier ?? BRIDGE_DEFAULT_SERVICE_TIER,
  };
}
