import { describe, expect, it } from 'vitest';
import { buildProjectListCard, buildProjectSettingsCard } from '../src/card/dm-cards';
import { withFoodMcpServers } from '../src/project/registry';
import type { Project } from '../src/project/registry';

function project(i: number): Project {
  return {
    name: `项目 ${i}`,
    chatId: `oc_${i}`,
    cwd: `/tmp/project-${i}`,
    blank: false,
    createdAt: i,
    kind: 'multi',
    origin: 'created',
  };
}

describe('DM project list card', () => {
  it('caps visible projects to avoid Feishu CardKit element limits', () => {
    const card = buildProjectListCard(
      Array.from({ length: 25 }, (_, i) => project(i + 1)),
      new Map(),
    );
    const json = JSON.stringify(card);

    expect(json).toContain('项目 1');
    expect(json).toContain('项目 20');
    expect(json).not.toContain('项目 21');
    expect(json).toContain('共 25 个项目');
    expect(json).toContain('本卡显示前 20 个');
  });
});

describe('DM project settings card', () => {
  it('shows the food MCP toggle and token env var names', () => {
    const card = buildProjectSettingsCard({
      ...project(1),
      mcpServers: withFoodMcpServers(undefined),
    });
    const json = JSON.stringify(card);

    expect(json).toContain('餐饮 MCP');
    expect(json).toContain('停用瑞幸/麦当劳');
    expect(json).toContain('LUCKIN_MCP_TOKEN');
    expect(json).toContain('MCD_MCP_TOKEN');
    expect(json).toContain('mcp:LUCKIN_MCP_TOKEN');
    expect(json).toContain('mcp:MCD_MCP_TOKEN');
  });
});
