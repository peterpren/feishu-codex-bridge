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
    missingJoinScopes: [], // healthy baseline: 加入存量群 scopes granted too
    joinScopeGrantUrl: 'https://open.feishu.cn/app/cli_x/auth?q=join',
    missingCloudDocFolderScopes: [],
    cloudDocFolderScopeGrantUrl: 'https://open.feishu.cn/app/cli_x/auth?q=cloud-doc-folder',
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
    expect(json).toContain('feishu-codex bridge v0.1.2');
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
    expect(prompt).toContain('https://github.com/peterpren/feishu-codex-bridge');
    expect(prompt).toContain('https://github.com/peterpren/feishu-codex-bridge/issues');
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
    expect(urls).toContain('https://github.com/peterpren/feishu-codex-bridge');
    expect(urls).toContain('https://github.com/peterpren/feishu-codex-bridge/issues');
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

  it('labels the image-upload scope so a missing im:resource reads as 图片, not a raw token', () => {
    const json = JSON.stringify(buildDoctorCard(info({ missingScopes: ['im:resource'], scopeGrantUrl: GRANT })));
    expect(json).toContain('图片'); // friendly label surfaces the capability
    expect(json).toContain('im:resource'); // raw token still shown for the console
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

describe('buildDoctorCard — 事件订阅自检', () => {
  const EVENT_URL = 'https://open.feishu.cn/app/cli_x/event';

  it('surfaces event diagnosis and carries it into the copy-paste prompt', () => {
    const card = buildDoctorCard(
      info({
        eventDiagnosis: {
          state: 'missing',
          version: '1.0.0',
          events: ['application.bot.menu_v6'],
          missingRequired: ['im.message.receive_v1'],
          missingOptional: ['drive.notice.comment_add_v1'],
        },
        eventConfigUrl: EVENT_URL,
      }),
    );
    const json = JSON.stringify(card);
    expect(json).toContain('事件订阅');
    expect(json).toContain('im.message.receive_v1');
    expect(json).toContain('drive.notice.comment_add_v1');
    expect(collectUrls(card)).toContain(EVENT_URL);
    expect(codeBlock(card)).toContain('事件订阅');
  });
});

describe('buildDoctorCard — 加入存量群（opt-in scope 提示）', () => {
  const JOIN_GRANT = 'https://open.feishu.cn/app/cli_x/auth?q=im%3Achat%3Areadonly%2Cim%3Achat.members%3Awrite_only';

  it('always reminds about the two un-checkable bot member events', () => {
    // events have no query API → surfaced as a note regardless of scope state
    const json = JSON.stringify(buildDoctorCard(info()));
    expect(json).toContain('im.chat.member.bot.added_v1');
    expect(json).toContain('im.chat.member.bot.deleted_v1');
  });

  it('surfaces the missing join scopes with a one-click grant button', () => {
    const card = buildDoctorCard(
      info({ missingJoinScopes: ['im:chat:readonly', 'im:chat.members:write_only'], joinScopeGrantUrl: JOIN_GRANT }),
    );
    const json = JSON.stringify(card);
    expect(json).toContain('加入存量群');
    expect(json).toContain('缺 2 项');
    expect(json).toContain('im:chat:readonly');
    expect(collectUrls(card)).toContain(JOIN_GRANT);
    // opt-in: a missing join scope must NOT escalate the header to orange
    expect((card as { header: { template: string } }).header.template).toBe('blue');
  });

  it('shows 已开通 (no button) when join scopes are all granted', () => {
    const card = buildDoctorCard(info({ missingJoinScopes: [], joinScopeGrantUrl: JOIN_GRANT }));
    expect(JSON.stringify(card)).toContain('已开通');
    expect(collectUrls(card)).not.toContain(JOIN_GRANT);
  });

  it('says 未能自动检查 with a button when the scope check could not run', () => {
    const card = buildDoctorCard(info({ missingJoinScopes: undefined, joinScopeGrantUrl: JOIN_GRANT }));
    expect(JSON.stringify(card)).toContain('未能自动检查');
    expect(collectUrls(card)).toContain(JOIN_GRANT);
  });
});

describe('buildDoctorCard — 飞书云文档目录（opt-in scope 提示）', () => {
  const CLOUD_GRANT =
    'https://open.feishu.cn/app/cli_x/auth?q=drive%3Afile%2Cdocs%3Apermission.member%3Acreate%2Cdocs%3Apermission.member%3Adelete';

  it('surfaces missing cloud-doc folder scopes with a one-click grant button', () => {
    const card = buildDoctorCard(
      info({
        missingCloudDocFolderScopes: ['drive:file', 'docs:permission.member:create', 'docs:permission.member:delete'],
        cloudDocFolderScopeGrantUrl: CLOUD_GRANT,
      }),
    );
    const json = JSON.stringify(card);
    expect(json).toContain('飞书云文档目录');
    expect(json).toContain('权限隔离');
    expect(json).toContain('docs:permission.member:delete');
    expect(collectUrls(card)).toContain(CLOUD_GRANT);
    expect((card as { header: { template: string } }).header.template).toBe('blue');
  });

  it('shows 已开通 when cloud-doc folder scopes are granted', () => {
    const card = buildDoctorCard(info({ missingCloudDocFolderScopes: [], cloudDocFolderScopeGrantUrl: CLOUD_GRANT }));
    expect(JSON.stringify(card)).toContain('可创建话题子文件夹');
    expect(collectUrls(card)).not.toContain(CLOUD_GRANT);
  });
});
