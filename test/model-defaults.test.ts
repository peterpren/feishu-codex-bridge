import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../src/agent/types';
import { pickBridgeDefaults } from '../src/bot/model-defaults';

function model(id: string, partial: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    displayName: id,
    description: '',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    serviceTiers: [],
    isDefault: false,
    hidden: false,
    ...partial,
  };
}

describe('pickBridgeDefaults', () => {
  it('defaults new sessions to GPT-5.5, medium reasoning, and standard speed', () => {
    const defaults = pickBridgeDefaults([
      model('gpt-6', { isDefault: true, defaultEffort: 'high' }),
      model('gpt-5.5'),
    ]);

    expect(defaults).toEqual({
      model: 'gpt-5.5',
      effort: 'medium',
      serviceTier: 'standard',
    });
  });

  it('falls back cleanly if GPT-5.5 is not in the local model list', () => {
    const defaults = pickBridgeDefaults([model('gpt-6')]);

    expect(defaults).toEqual({
      model: 'gpt-6',
      effort: 'medium',
      serviceTier: 'standard',
    });
  });

  it('uses the project default model when it is available', () => {
    const defaults = pickBridgeDefaults(
      [
        model('gpt-5.5'),
        model('gpt-6', { supportedEfforts: ['high'], defaultEffort: 'high' }),
      ],
      { defaultModel: 'gpt-6', defaultEffort: 'high', defaultServiceTier: 'fast' },
    );

    expect(defaults).toEqual({
      model: 'gpt-6',
      effort: 'high',
      serviceTier: 'fast',
    });
  });

  it('falls back to the selected model default effort if the project effort is unsupported', () => {
    const defaults = pickBridgeDefaults(
      [model('gpt-5.5'), model('gpt-6', { supportedEfforts: ['high'], defaultEffort: 'high' })],
      { defaultModel: 'gpt-6', defaultEffort: 'xhigh' },
    );

    expect(defaults).toMatchObject({
      model: 'gpt-6',
      effort: 'high',
      serviceTier: 'standard',
    });
  });

  it('falls back to the bridge default when the project default is unavailable', () => {
    const defaults = pickBridgeDefaults([model('gpt-5.5'), model('gpt-6')], { defaultModel: 'missing-model' });

    expect(defaults.model).toBe('gpt-5.5');
  });
});
