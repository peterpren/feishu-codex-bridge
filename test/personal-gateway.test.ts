import { describe, expect, it } from 'vitest';
import { detectPersonalDataIntent, parsePersonalDataCommand, formatPersonalDataForPrompt } from '../src/personal/gateway';
import { parsePersonalAuthCallback, personalAuthBaseUrl } from '../src/personal/oauth';
import type { AppConfig } from '../src/config/schema';

describe('personal auth and data gateway helpers', () => {
  it('parses OAuth callback URLs and pasted code/state snippets', () => {
    expect(parsePersonalAuthCallback('http://127.0.0.1:9768/callback?code=abc123&state=st456')).toEqual({
      code: 'abc123',
      state: 'st456',
    });
    expect(parsePersonalAuthCallback('code=abc123 state=st456')).toEqual({ code: 'abc123', state: 'st456' });
  });

  it('uses the tenant-specific Feishu open platform base URL', () => {
    const cfg = (tenant: 'feishu' | 'lark'): AppConfig => ({
      accounts: { app: { id: 'cli_x', secret: 's', tenant } },
    });
    expect(personalAuthBaseUrl(cfg('feishu'))).toBe('https://open.feishu.cn');
    expect(personalAuthBaseUrl(cfg('lark'))).toBe('https://open.larksuite.com');
  });

  it('parses /me docs and /me minutes commands', () => {
    expect(parsePersonalDataCommand('/me docs 预算复盘')).toEqual({ kind: 'docs', query: '预算复盘' });
    expect(parsePersonalDataCommand('/me minutes 周会')).toEqual({ kind: 'minutes', query: '周会' });
    expect(parsePersonalDataCommand('/me 状态')).toEqual({ kind: 'status', query: '' });
  });

  it('detects natural language personal data intent conservatively', () => {
    expect(detectPersonalDataIntent('帮我查一下我飞书里有没有玉豆相关资料')).toEqual({
      kind: 'docs',
      query: '帮我查一下我飞书里有没有玉豆相关资料',
    });
    expect(detectPersonalDataIntent('基于我上周的会议纪要，整理一下待办')).toEqual({
      kind: 'minutes',
      query: '基于我上周的会议纪要，整理一下待办',
    });
    expect(detectPersonalDataIntent('帮我写一个需求说明')).toBeNull();
    expect(detectPersonalDataIntent('生成一份飞书文档并保存')).toBeNull();
  });

  it('formats personal data without exposing tokens', () => {
    const prompt = formatPersonalDataForPrompt({
      kind: 'docs',
      query: '预算',
      results: [{ title: '预算说明', url: 'https://example.feishu.cn/docx/xxx', docType: 'DOCX', content: '正文' }],
    });
    expect(prompt).toContain('当前发言人的个人飞书授权');
    expect(prompt).toContain('预算说明');
    expect(prompt).not.toContain('access_token');
  });
});
