import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildThreadSessionParams } from '../src/agent/codex-appserver/backend';

describe('buildThreadSessionParams', () => {
  it('builds thread params with project cwd, permission tier, and cloud-doc guidance', () => {
    const params = buildThreadSessionParams({
      cwd: './project-a',
      model: 'gpt-5.5',
      serviceTier: 'fast',
      mode: 'full',
      cloudDocFolder: { token: 'fld_test', createAs: 'user' },
    });
    const root = resolve('./project-a');

    expect(params.cwd).toBe(root);
    expect(params.model).toBe('gpt-5.5');
    expect(params.serviceTier).toBe('fast');
    expect(params.approvalPolicy).toBe('never');
    expect(params.sandbox).toBe('danger-full-access');
    expect(params.developerInstructions).toContain('fld_test');
    expect(params.developerInstructions).toContain('--parent-token fld_test');
  });

  it('maps standard speed to Codex default service tier', () => {
    const params = buildThreadSessionParams({
      cwd: './project-a',
      model: 'gpt-5.5',
      serviceTier: 'standard',
      mode: 'full',
    });

    expect(params.serviceTier).toBeNull();
  });
});
