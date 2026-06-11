import { describe, expect, it } from 'vitest';
import {
  enabledProjectMcpServers,
  cloudDocFolderLabel,
  defaultNoMention,
  foodMcpEnabled,
  parseCloudDocFolder,
  withFoodMcpServers,
  withoutFoodMcpServers,
} from '../src/project/registry';

describe('defaultNoMention', () => {
  it('multi-topic groups default 免@ off', () => {
    expect(defaultNoMention({ origin: 'created', kind: 'multi' })).toBe(false);
    expect(defaultNoMention({ origin: 'joined', kind: 'multi' })).toBe(false);
  });

  it('created single-session groups default 免@ on', () => {
    expect(defaultNoMention({ origin: 'created', kind: 'single' })).toBe(true);
  });

  it('joined single-session groups default 免@ off', () => {
    expect(defaultNoMention({ origin: 'joined', kind: 'single' })).toBe(false);
  });

  it('treats missing origin as created and missing kind as multi', () => {
    expect(defaultNoMention({})).toBe(false);
    expect(defaultNoMention({ kind: 'single' })).toBe(true); // created (implied) single → on
    expect(defaultNoMention({ origin: 'joined' })).toBe(false); // joined multi (implied) → off
  });
});

describe('parseCloudDocFolder', () => {
  it('extracts a folder token from a Feishu Drive folder URL', () => {
    const folder = parseCloudDocFolder('https://example.feishu.cn/drive/folder/fldcnABC123?from=space');
    expect(folder).toEqual({
      token: 'fldcnABC123',
      url: 'https://example.feishu.cn/drive/folder/fldcnABC123?from=space',
      createAs: 'user',
    });
    expect(cloudDocFolderLabel(folder)).toBe('fldcnABC123');
  });

  it('accepts a bare folder token and rejects unrelated input', () => {
    expect(parseCloudDocFolder('fldcnXYZ_123')?.token).toBe('fldcnXYZ_123');
    expect(parseCloudDocFolder('')).toBeUndefined();
    expect(() => parseCloudDocFolder('我的空间/项目文档')).toThrow('文件夹 URL');
  });
});

describe('food MCP project helpers', () => {
  it('adds and removes the official Luckin/McDonald servers', () => {
    const enabled = withFoodMcpServers([{ name: 'other', url: 'https://example.com/mcp' }]);

    expect(foodMcpEnabled({ mcpServers: enabled })).toBe(true);
    expect(enabledProjectMcpServers({ mcpServers: enabled }).map((server) => server.name)).toEqual([
      'other',
      'luckin-coffee',
      'mcd-mcp',
    ]);
    expect(withoutFoodMcpServers(enabled)).toEqual([{ name: 'other', url: 'https://example.com/mcp' }]);
  });

  it('keeps token references as environment variable names only', () => {
    const enabled = withFoodMcpServers(undefined);

    expect(enabled.map((server) => server.bearerTokenEnvVar)).toEqual(['LUCKIN_MCP_TOKEN', 'MCD_MCP_TOKEN']);
    expect(enabled.map((server) => server.bearerTokenSecretId)).toEqual(['mcp:LUCKIN_MCP_TOKEN', 'mcp:MCD_MCP_TOKEN']);
    expect(JSON.stringify(enabled)).not.toContain('Bearer ');
  });
});
