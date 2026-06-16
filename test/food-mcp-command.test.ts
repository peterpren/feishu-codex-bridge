import { describe, expect, it } from 'vitest';
import { foodMcpReady, formatFoodMcpProbe, formatFoodMcpStatus, type FoodMcpProbeReport, type FoodMcpStatusReport } from '../src/cli/commands/food-mcp';

function report(overrides: Partial<FoodMcpStatusReport> = {}): FoodMcpStatusReport {
  return {
    tokens: [
      {
        title: '瑞幸咖啡',
        url: 'https://gwmcp.lkcoffee.com/order/user/mcp',
        envVar: 'LUCKIN_MCP_TOKEN',
        secretId: 'mcp:LUCKIN_MCP_TOKEN',
        configuredByEnv: false,
        configuredBySecret: false,
      },
      {
        title: '麦当劳',
        url: 'https://mcp.mcd.cn',
        envVar: 'MCD_MCP_TOKEN',
        secretId: 'mcp:MCD_MCP_TOKEN',
        configuredByEnv: false,
        configuredBySecret: false,
      },
    ],
    bots: [{ botName: 'default', appId: 'cli_default', active: true, auth: 'ok', authDetail: '任鹏的Codex', enabledProjects: ['Bridge Debug'], totalProjects: 1 }],
    ...overrides,
  };
}

describe('food-mcp status', () => {
  it('requires both brand tokens before reporting ready', () => {
    const status = report();

    expect(foodMcpReady(status)).toBe(false);
    expect(formatFoodMcpStatus(status)).toContain('状态：还没就绪');
    expect(formatFoodMcpStatus(status)).toContain('瑞幸咖啡：未配置');
    expect(formatFoodMcpStatus(status)).toContain('授权正常');
    expect(formatFoodMcpStatus(status)).toContain('feishu-codex-bridge food-mcp set-token luckin');
    expect(formatFoodMcpStatus(status)).not.toContain("printf '%s'");
  });

  it('reports ready only when tokens and an active enabled project exist', () => {
    const status = report({
      tokens: report().tokens.map((token) => ({ ...token, configuredBySecret: true })),
    });

    expect(foodMcpReady(status)).toBe(true);
    expect(formatFoodMcpStatus(status)).toContain('状态：可开始在已启用项目里测试菜单/门店查询。');
  });

  it('does not report ready when the active bot is unauthorized', () => {
    const status = report({
      tokens: report().tokens.map((token) => ({ ...token, configuredBySecret: true })),
      bots: [{ botName: 'default', appId: 'cli_default', active: true, auth: 'failed', authDetail: 'code=10014 msg=app unauthorized', enabledProjects: ['Bridge Debug'], totalProjects: 1 }],
    });

    expect(foodMcpReady(status)).toBe(false);
    expect(formatFoodMcpStatus(status)).toContain('授权失败：code=10014 msg=app unauthorized');
  });
});

describe('food-mcp probe', () => {
  it('formats connected MCP servers without exposing token values', () => {
    const probe: FoodMcpProbeReport = {
      tokenReady: true,
      servers: [
        { name: 'luckin-coffee', title: '瑞幸咖啡', authStatus: 'bearerToken', toolNames: ['menu_search', 'store_search'] },
        { name: 'mcd-mcp', title: '麦当劳', authStatus: 'bearerToken', toolNames: ['product_list'] },
      ],
    };

    const text = formatFoodMcpProbe(probe);

    expect(text).toContain('餐饮 MCP 探测');
    expect(text).toContain('瑞幸咖啡：Bearer Token');
    expect(text).toContain('menu_search');
    expect(text).toContain('MCP 可连接');
    expect(text).not.toContain('Bearer abc');
  });

  it('reports missing tokens before probing app-server', () => {
    const probe: FoodMcpProbeReport = {
      tokenReady: false,
      servers: [{ name: 'LUCKIN_MCP_TOKEN', title: '瑞幸咖啡', authStatus: 'missing', toolNames: [], error: 'Token 未配置' }],
    };

    const text = formatFoodMcpProbe(probe);

    expect(text).toContain('瑞幸咖啡：未连接（Token 未配置）');
    expect(text).toContain('状态：Token 未配置，先写入 Token。');
  });
});
