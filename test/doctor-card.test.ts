import { describe, expect, it } from 'vitest';
import { buildDoctorCard, type DoctorInfo } from '../src/card/dm-cards';

function info(over: Partial<DoctorInfo> = {}): DoctorInfo {
  return {
    codexOk: true,
    codexVer: 'codex-cli 0.45.0',
    conn: 'connected',
    bridgeVer: '0.1.2',
    node: 'v20.11.0',
    platform: 'darwin-arm64',
    logStdout: '/Users/me/.feishu-codex-bridge/service.log',
    logStderr: '/Users/me/.feishu-codex-bridge/service.err.log',
    configFile: '/Users/me/.feishu-codex-bridge/bots/cli_x/config.json',
    missingScopes: [], // healthy baseline: all required scopes granted
    scopeGrantUrl: 'https://open.feishu.cn/app/cli_x/auth?q=',
    ...over,
  };
}

/** The copy-paste prompt the card renders into a fenced code block. */
function codeBlock(card: object): string {
  const json = JSON.stringify(card);
  const m = json.match(/```\\n([\s\S]*?)\\n```/);
  if (!m) throw new Error('no fenced code block in doctor card');
  // unescape the JSON string back into the literal prompt text
  return JSON.parse(`"${m[1]}"`) as string;
}

/** Every open_url default_url anywhere in the card tree. */
function collectUrls(card: object): string[] {
  const urls: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      if (o.type === 'open_url' && typeof o.default_url === 'string') urls.push(o.default_url);
      Object.values(o).forEach(walk);
    }
  };
  walk(card);
  return urls;
}

describe('buildDoctorCard', () => {
  it('renders an initial diagnosis with codex + connection state', () => {
    const json = JSON.stringify(buildDoctorCard(info()));
    expect(json).toContain('初步诊断');
    expect(json).toContain('✅ 可用');
    expect(json).toContain('codex-cli 0.45.0');
    expect(json).toContain('✅ 已连接'); // connected → friendly label
    expect(json).toContain('bridge v0.1.2');
    expect(json).toContain('darwin-arm64');
  });

  it('shows both daemon log paths and the foreground hint', () => {
    const json = JSON.stringify(buildDoctorCard(info()));
    expect(json).toContain('/Users/me/.feishu-codex-bridge/service.log');
    expect(json).toContain('/Users/me/.feishu-codex-bridge/service.err.log');
    expect(json).toContain('终端窗口'); // foreground run logs live in the terminal
  });

  it('embeds a copy-paste prompt carrying repo link, version, log paths and config', () => {
    const prompt = codeBlock(buildDoctorCard(info()));
    expect(prompt).toContain('https://github.com/modelzen/feishu-codex-bridge');
    expect(prompt).toContain('https://github.com/modelzen/feishu-codex-bridge/issues');
    expect(prompt).toContain('v0.1.2');
    expect(prompt).toContain('codex-cli 0.45.0');
    expect(prompt).toContain('v20.11.0');
    expect(prompt).toContain('darwin-arm64');
    expect(prompt).toContain('/Users/me/.feishu-codex-bridge/service.log');
    expect(prompt).toContain('/Users/me/.feishu-codex-bridge/service.err.log');
    expect(prompt).toContain('/Users/me/.feishu-codex-bridge/bots/cli_x/config.json');
    // no nested fence that would break the outer code block
    expect(prompt).not.toContain('```');
  });

  it('reflects an unavailable codex: warning header + ❌ + "未找到" in the prompt', () => {
    const card = buildDoctorCard(info({ codexOk: false, codexVer: null, conn: 'disconnected' }));
    const json = JSON.stringify(card);
    expect((card as { header: { template: string } }).header.template).toBe('orange');
    expect(json).toContain('❌ 不可用');
    expect(json).toContain('❌ 已断开');
    expect(codeBlock(card)).toContain('未找到');
  });

  it('uses a blue header when codex is available', () => {
    const card = buildDoctorCard(info());
    expect((card as { header: { template: string } }).header.template).toBe('blue');
  });

  it('shows an unknown connection state verbatim', () => {
    const json = JSON.stringify(buildDoctorCard(info({ conn: 'unknown' })));
    expect(json).toContain('飞书长连接：unknown');
  });

  it('links to the repo and issues via buttons', () => {
    const urls: string[] = [];
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>;
        if (o.type === 'open_url' && typeof o.default_url === 'string') urls.push(o.default_url);
        Object.values(o).forEach(walk);
      }
    };
    walk(buildDoctorCard(info()));
    expect(urls).toContain('https://github.com/modelzen/feishu-codex-bridge');
    expect(urls).toContain('https://github.com/modelzen/feishu-codex-bridge/issues');
  });
});

describe('buildDoctorCard — 飞书权限自检', () => {
  const GRANT = 'https://open.feishu.cn/app/cli_x/auth?q=im%3Amessage.group_msg%2Ccardkit%3Acard%3Awrite';

  it('lists missing scopes with an orange header and a one-click grant button', () => {
    const card = buildDoctorCard(
      info({ missingScopes: ['im:message.group_msg', 'cardkit:card:write'], scopeGrantUrl: GRANT }),
    );
    const json = JSON.stringify(card);
    expect((card as { header: { template: string } }).header.template).toBe('orange');
    expect(json).toContain('缺 2 项');
    expect(json).toContain('im:message.group_msg');
    expect(json).toContain('cardkit:card:write');
    expect(collectUrls(card)).toContain(GRANT); // grant button → developer-console auth page
  });

  it('confirms all granted (no grant button, stays blue) when missingScopes is empty', () => {
    const card = buildDoctorCard(info({ missingScopes: [], scopeGrantUrl: GRANT }));
    expect((card as { header: { template: string } }).header.template).toBe('blue');
    expect(JSON.stringify(card)).toContain('必需权限已全部开通');
    expect(collectUrls(card)).not.toContain(GRANT); // nothing to grant → no button
  });

  it('says 无法自动检查 with a verify button, header stays blue, when the check could not run', () => {
    const card = buildDoctorCard(info({ missingScopes: undefined, scopeGrantUrl: GRANT }));
    expect(JSON.stringify(card)).toContain('无法自动检查');
    // undefined = "couldn't check", NOT a hard failure → header stays blue (codex still ok)
    expect((card as { header: { template: string } }).header.template).toBe('blue');
    expect(collectUrls(card)).toContain(GRANT);
  });

  it('carries the scope status into the copy-paste codex prompt (all three states)', () => {
    expect(codeBlock(buildDoctorCard(info({ missingScopes: ['im:resource'] })))).toContain('缺失 1 项');
    expect(codeBlock(buildDoctorCard(info({ missingScopes: [] })))).toContain('必需权限齐全');
    expect(codeBlock(buildDoctorCard(info({ missingScopes: undefined })))).toContain('未能自动检查');
  });
});
