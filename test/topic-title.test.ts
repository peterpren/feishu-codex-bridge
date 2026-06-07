import { describe, expect, it } from 'vitest';
import { deriveTopicTitle, formatTopicTitleMessage, normalizeManualTopicTitle } from '../src/bot/topic-title';

describe('deriveTopicTitle', () => {
  it('keeps the concrete part after a generic feature prefix', () => {
    const title = deriveTopicTitle('我想加一个功能：在创建了飞书云文档的保存文件夹目录且生成群之后，能够自动将该飞书文件夹的编辑权限给到这个群组');
    expect(title).toContain('飞书');
    expect(title).toContain('编辑权限');
    expect([...title].length).toBeLessThanOrEqual(28);
  });

  it('strips mention and polite opening words', () => {
    expect(deriveTopicTitle('@任鹏的Codex 帮我看一下这个 Bridge 该怎么实现？')).toBe('这个 Bridge 该怎么实现');
  });

  it('falls back when the prompt is empty', () => {
    expect(deriveTopicTitle('   ')).toBe('新任务');
  });

  it('truncates long titles by character count', () => {
    const title = deriveTopicTitle('请帮我分析一下海外 TikTok 消费品牌 Tideway 小家电品牌未来六个月的经营改善重点');
    expect([...title].length).toBeLessThanOrEqual(28);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('normalizeManualTopicTitle', () => {
  it('trims quotes and collapses whitespace for manual rename', () => {
    expect(normalizeManualTopicTitle('  “ 新  话题 名 ”  ')).toBe('新 话题 名');
  });

  it('returns empty for blank manual title', () => {
    expect(normalizeManualTopicTitle('   ')).toBe('');
  });

  it('caps manual title length', () => {
    const title = normalizeManualTopicTitle('x'.repeat(100));
    expect([...title].length).toBe(60);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('formatTopicTitleMessage', () => {
  it('appends the requester mention to the title', () => {
    expect(formatTopicTitleMessage('短标题', { openId: 'ou_abc123', name: '张三' })).toBe(
      '短标题 · <at user_id="ou_abc123">张三</at>',
    );
  });

  it('falls back to a plain title when open_id is unavailable', () => {
    expect(formatTopicTitleMessage('短标题', { openId: 'bad', name: '张三' })).toBe('短标题');
  });

  it('uses a generic mention label when the name is unavailable', () => {
    expect(formatTopicTitleMessage('短标题', { openId: 'ou_abc123' })).toBe(
      '短标题 · <at user_id="ou_abc123">提问人</at>',
    );
  });
});
