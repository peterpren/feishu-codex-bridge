import { card, hr, md, note, type CardObject } from './cards';

export interface PrivateGroupCardParticipant {
  openId: string;
  name?: string;
}

export function buildPrivateCreatedCard(opts: {
  title: string;
  projectName: string;
  participants: PrivateGroupCardParticipant[];
  failedParticipants?: PrivateGroupCardParticipant[];
}): CardObject {
  const names = participantNames(opts.participants);
  const failed = participantNames(opts.failedParticipants ?? []);
  const lines = [`· 归属项目：${escapeMd(opts.projectName)}`, `· 已加入成员：${names}`, '· 这个私密群是独立 Codex 会话，默认免 @。'];
  if (opts.failedParticipants?.length) lines.push(`· 未加入成员：${failed}`);
  return card(
    [
      md(`✅ 已创建私密协作群：**${escapeMd(opts.title)}**`),
      hr(),
      md(lines.join('\n')),
      note(opts.failedParticipants?.length ? '未加入的人通常是因为机器人对该用户不可见；可让对方先私聊机器人或检查应用可用范围。' : '后续在私密群里直接发消息即可；父群不会收到具体执行结果。'),
    ],
    { header: { title: '🔒 私密协作已创建', template: 'green' }, summary: '私密协作已创建' },
  );
}

export function buildPrivateIntroCard(opts: {
  title: string;
  parentProjectName: string;
  participants: PrivateGroupCardParticipant[];
  failedParticipants?: PrivateGroupCardParticipant[];
  sourceThreadId?: string;
}): CardObject {
  const names = participantNames(opts.participants);
  const source = opts.sourceThreadId ? `来源：父项目中的一个话题` : '来源：父项目主群区';
  const failed = participantNames(opts.failedParticipants ?? []);
  const lines = [
    `· 父项目：${escapeMd(opts.parentProjectName)}`,
    `· ${source}`,
    `· 已加入成员：${names}`,
    '· 默认免 @，整群共用一个独立 Codex 会话。',
  ];
  if (opts.failedParticipants?.length) lines.push(`· 未加入成员：${failed}`);
  return card(
    [
      md(`🔒 **${escapeMd(opts.title)}**`),
      hr(),
      md(lines.join('\n')),
      note(opts.failedParticipants?.length ? '部分参与者未加入；需要加入时，让对方先私聊机器人或由管理员检查应用可用范围。' : '本群只保留私密协作上下文；需要回到项目主群同步结论时，请明确告诉我。'),
    ],
    { header: { title: '私密协作群', template: 'turquoise' }, summary: '私密协作群' },
  );
}

function participantNames(participants: PrivateGroupCardParticipant[]): string {
  return participants.map((p) => p.name || `…${p.openId.slice(-6)}`).join('、') || '仅发起人';
}

function escapeMd(value: string): string {
  return value.replace(/([*_`[\]])/g, '\\$1');
}
