import { describe, expect, it } from 'vitest';
import type { MentionInfo } from '@larksuiteoapi/node-sdk';
import {
  mentionedPrivateParticipants,
  parsePrivateTaskText,
  privateProjectName,
  privateSourcePrompt,
  privateWorkspacePath,
} from '../src/project/private-project';

const mentions: MentionInfo[] = [
  { key: 'ou_bot_key', openId: 'ou_bot', name: '任鹏的Codex', isBot: true },
  { key: 'ou_a_key', openId: 'ou_a', name: '张三', isBot: false },
  { key: 'ou_b_key', openId: 'ou_b', name: '李四', isBot: false },
];

describe('private project helpers', () => {
  it('extracts non-bot mentioned participants and excludes the sender', () => {
    expect(mentionedPrivateParticipants('ou_a', mentions)).toEqual([{ openId: 'ou_b', name: '李四' }]);
  });

  it('removes slash command and mention labels from the private task text', () => {
    expect(parsePrivateTaskText('/private @张三 @李四 帮我复盘这段需求', mentions)).toBe('帮我复盘这段需求');
  });

  it('creates inspectable child project names and isolated local workspace paths', () => {
    const parent = { name: '项目协同', cwd: '/tmp/demo' };
    expect(privateProjectName(parent, '天气查询', 'omt_abcdef123456')).toContain('项目协同 · 私密 · 天气查询');
    expect(privateWorkspacePath(parent, 'omt_abcdef123456')).toBe('/tmp/demo/.feishu-codex/private/omt_abcdef123456');
  });

  it('builds a source prompt with parent association and source ids', () => {
    const prompt = privateSourcePrompt({
      taskText: '帮我看这个问题',
      parentProjectName: '项目协同',
      parentChatId: 'oc_parent',
      sourceThreadId: 'omt_source',
      sourceMessageId: 'om_source',
      participants: [{ openId: 'ou_a', name: '张三' }],
    });
    expect(prompt).toContain('父项目：项目协同');
    expect(prompt).toContain('来源话题 thread_id：omt_source');
    expect(prompt).toContain('来源消息 message_id：om_source');
    expect(prompt).toContain('帮我看这个问题');
  });
});
