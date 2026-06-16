import { describe, expect, it } from 'vitest';
import {
  buildHelpCard,
  buildModelCard,
  buildResumeCard,
  buildWelcomeCard,
  type ModelCardState,
  type ResumeCardState,
} from '../src/card/command-cards';
import type { ThreadSummary } from '../src/agent/types';

function buttons(node: unknown, acc: any[] = []): any[] {
  if (Array.isArray(node)) node.forEach((n) => buttons(n, acc));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.tag === 'button') acc.push(o);
    for (const k of Object.keys(o)) buttons(o[k], acc);
  }
  return acc;
}

function state(threads: ThreadSummary[]): ResumeCardState {
  return { chatId: 'oc_x', originalMsgId: 'om_x', requesterOpenId: 'ou_x', cwd: '/x', threads, createdAt: Date.now() };
}

const NOW = Math.floor(Date.now() / 1000);

describe('buildResumeCard', () => {
  it('renders one labeled button per session (time · title), unambiguous', () => {
    const longTitle = 'X-Alimail-AntiSpam:AC=CONTINUE;BC=-1|1;BR=01201311R271S09ruler050_05242_201210;CH=green';
    const threads: ThreadSummary[] = [
      { codexThreadId: 'c1', preview: '查看功能', name: '查看功能', createdAt: NOW - 1500, updatedAt: NOW - 1500 },
      { codexThreadId: 'c2', preview: longTitle, name: '', createdAt: NOW - 20 * 86400, updatedAt: NOW - 20 * 86400 },
      // two same-title sessions, different times → must get different labels
      { codexThreadId: 'c3', preview: '分析 SLS 告警', name: '分析 SLS 告警', createdAt: NOW - 20 * 86400, updatedAt: NOW - 20 * 86400 },
      { codexThreadId: 'c4', preview: '分析 SLS 告警', name: '分析 SLS 告警', createdAt: NOW - 20 * 86400 - 4000, updatedAt: NOW - 20 * 86400 - 4000 },
    ];
    const card = buildResumeCard(state(threads));
    const btns = buttons(card);

    // exactly one button per session, each carrying its codexThreadId
    expect(btns.length).toBe(4);
    expect(btns.map((b) => b.behaviors[0].value.t)).toEqual(['c1', 'c2', 'c3', 'c4']);
    // every label is the time·title button (no bare "恢复" buttons)
    for (const b of btns) expect(b.text.content).toMatch(/^↩️ .+ · /);
    // long/garbage title is truncated to one line with …
    const longLabel = btns[1].text.content as string;
    expect(longLabel).toContain('…');
    expect(longLabel.length).toBeLessThan(60); // bounded, not the full ~90-char title
    expect(longLabel).not.toContain('\n');
    // same-title sessions are disambiguated by the timestamp
    expect(btns[2].text.content).not.toBe(btns[3].text.content);
  });

  it('shows an empty-state hint and no buttons when there is no history', () => {
    const card = buildResumeCard(state([]));
    expect(buttons(card).length).toBe(0);
    expect(JSON.stringify(card)).toContain('还没有历史会话');
  });
});

describe('buildModelCard', () => {
  it('uses Codex Chinese labels for reasoning and speed', () => {
    const modelState: ModelCardState = {
      chatId: 'oc_x',
      threadId: 'omt_x',
      requesterOpenId: 'ou_x',
      models: [
        {
          id: 'gpt-5.5',
          displayName: 'GPT-5.5',
          description: '',
          supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultEffort: 'medium',
          serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }],
          isDefault: true,
          hidden: false,
        },
      ],
      model: 'gpt-5.5',
      effort: 'xhigh',
      serviceTier: 'fast',
      createdAt: Date.now(),
      note: '✅ 已设置推理，下一轮生效',
    };
    const json = JSON.stringify(buildModelCard(modelState));

    expect(json).toContain('模型 / 推理 / 速度');
    expect(json).toContain('推理：超高');
    expect(json).toContain('速度：标准');
    expect(json).toContain('速度：快速');
    expect(json).not.toContain('速度：Fast');
    expect(json).not.toContain('effort：');
    expect(json).not.toContain('极高');
  });
});

describe('buildHelpCard 权限过滤', () => {
  it('主群区：非管理员看不到 owner-only 命令(/resume、/settings)，但对话类命令仍在', () => {
    const json = JSON.stringify(buildHelpCard('main', true, false));
    expect(json).not.toContain('/resume');
    expect(json).not.toContain('/settings');
    expect(json).toContain('/model'); // 对话类命令对所有人开放
    expect(json).toContain('/help');
  });

  it('主群区：管理员能看到全部命令', () => {
    const json = JSON.stringify(buildHelpCard('main', true, true));
    expect(json).toContain('/resume');
    expect(json).toContain('/settings');
    expect(json).toContain('/model');
  });

  it('单会话群：/settings 仅管理员可见，/model 始终可见', () => {
    expect(JSON.stringify(buildHelpCard('single', true, false))).not.toContain('/settings');
    expect(JSON.stringify(buildHelpCard('single', true, true))).toContain('/settings');
    expect(JSON.stringify(buildHelpCard('single', true, false))).toContain('/model');
    expect(JSON.stringify(buildHelpCard('single', true, false))).not.toContain('/rename');
  });

  it('私密协作群：发起人或管理员可以看到 /rename 和 /settings', () => {
    const json = JSON.stringify(buildHelpCard('private', false, true));
    expect(json).toContain('/rename 新群名');
    expect(json).toContain('/settings');
    expect(json).toContain('/connect');
    expect(json).toContain('自然语言提需求');
    expect(json).toContain('/me status');
    expect(json).not.toContain('/me docs');
    expect(json).not.toContain('/me minutes');
    expect(json).toContain('本群默认需 @');
  });

  it('多话题群：主群区和话题内都会提示 /rename 的使用位置', () => {
    expect(JSON.stringify(buildHelpCard('main', true, false))).toContain('/rename 新标题');
    expect(JSON.stringify(buildHelpCard('topic', true, false))).toContain('/rename 新标题');
  });

  it('多话题群：主群区和话题内都会提示 /private', () => {
    expect(JSON.stringify(buildHelpCard('main', true, false))).toContain('/private [@参与者] 内容');
    expect(JSON.stringify(buildHelpCard('topic', true, false))).toContain('/private [@参与者] 内容');
  });

  it('多话题群：话题内默认不承诺免@', () => {
    const json = JSON.stringify(buildHelpCard('topic'));
    expect(json).toContain('@我 + 内容');
    expect(json).not.toContain('直接发消息（免@）→ 继续当前会话');
  });

  it('欢迎卡：多话题群提示 /rename，单会话群不提示', () => {
    const multiJson = JSON.stringify(buildWelcomeCard('multi'));
    expect(multiJson).toContain('/rename 新标题');
    expect(multiJson).toContain('/private [@参与者] 内容');
    expect(multiJson).toContain('@我 + 内容');
    expect(multiJson).not.toContain('直接发消息（免@）→ 继续当前会话');
    expect(JSON.stringify(buildWelcomeCard('single'))).not.toContain('/rename');
  });
});
