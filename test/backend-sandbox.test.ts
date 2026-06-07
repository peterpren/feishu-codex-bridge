import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildThreadSessionParams } from '../src/agent/codex-appserver/backend';

describe('buildThreadSessionParams', () => {
  it('builds thread params with project cwd, permission tier, and cloud-doc guidance', () => {
    const params = buildThreadSessionParams({
      cwd: './project-a',
      model: 'gpt-5.5',
      mode: 'full',
      cloudDocFolder: { token: 'fld_test', createAs: 'user' },
    });
    const root = resolve('./project-a');

    expect(params.cwd).toBe(root);
    expect(params.model).toBe('gpt-5.5');
    expect(params.approvalPolicy).toBe('never');
    expect(params.sandbox).toBe('danger-full-access');
    expect(params.developerInstructions).toContain('fld_test');
    expect(params.developerInstructions).toContain('--parent-token fld_test');
  });
});
