import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildThreadSessionParams } from '../src/agent/codex-appserver/backend';
import { mcpServerConfigArgs } from '../src/agent/codex-appserver/app-server-client';

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

  it('adds food-ordering safety guidance when MCP servers are enabled', () => {
    const params = buildThreadSessionParams({
      cwd: './project-a',
      mode: 'full',
      mcpServers: [{ name: 'mcd-mcp', url: 'https://mcp.mcd.cn', bearerTokenEnvVar: 'MCD_MCP_TOKEN' }],
    });

    expect(params.developerInstructions).toContain('餐饮 MCP');
    expect(params.developerInstructions).toContain('创建订单前必须先向用户复述');
    expect(params.developerInstructions).toContain('不要替用户支付');
  });
});

describe('mcpServerConfigArgs', () => {
  it('builds codex -c overrides without exposing token values', () => {
    expect(
      mcpServerConfigArgs([
        { name: 'mcd-mcp', url: 'https://mcp.mcd.cn', bearerTokenEnvVar: 'MCD_MCP_TOKEN', bearerTokenSecretId: 'mcp:MCD_MCP_TOKEN' },
        { name: 'disabled', url: 'https://example.com/mcp', enabled: false },
      ]),
    ).toEqual([
      '-c',
      'mcp_servers.mcd-mcp.url="https://mcp.mcd.cn"',
      '-c',
      'mcp_servers.mcd-mcp.bearer_token_env_var="MCD_MCP_TOKEN"',
    ]);
  });

  it('rejects unsafe MCP server names', () => {
    expect(() => mcpServerConfigArgs([{ name: 'bad.name', url: 'https://example.com/mcp' }])).toThrow('can only contain');
  });
});
