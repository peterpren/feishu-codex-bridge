import { describe, expect, it } from 'vitest';
import { buildPrivateCreatedCard, buildPrivateIntroCard } from '../src/card/private-cards';

const participants = [{ openId: 'ou_owner', name: '刘玲' }];

describe('private group cards', () => {
  it('does not promise no-mention mode on private child groups', () => {
    const created = JSON.stringify(
      buildPrivateCreatedCard({
        title: '私密协作',
        projectName: '父项目',
        participants,
      }),
    );
    const intro = JSON.stringify(
      buildPrivateIntroCard({
        title: '私密协作',
        parentProjectName: '父项目',
        participants,
      }),
    );

    expect(created).toContain('默认需要 @机器人');
    expect(created).toContain('后续在私密群里 @机器人 即可');
    expect(intro).toContain('默认需要 @机器人');
    expect(`${created}\n${intro}`).not.toContain('默认免 @');
    expect(`${created}\n${intro}`).not.toContain('直接发消息即可');
  });
});
