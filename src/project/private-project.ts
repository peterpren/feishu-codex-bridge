import { join, resolve } from 'node:path';
import type { MentionInfo } from '@larksuiteoapi/node-sdk';
import type { Project } from './registry';
import { safeTopicWorkspaceName } from './topic-workspace';

const PRIVATE_TITLE_MAX = 34;
const PRIVATE_PARENT_MAX = 32;

export interface PrivateParticipant {
  openId: string;
  name?: string;
}

export function mentionedPrivateParticipants(senderOpenId: string, mentions: MentionInfo[]): PrivateParticipant[] {
  const out = new Map<string, PrivateParticipant>();
  for (const m of mentions) {
    if (m.isBot || !m.openId || m.openId === senderOpenId) continue;
    out.set(m.openId, { openId: m.openId, name: m.name });
  }
  return [...out.values()];
}

export function parsePrivateTaskText(text: string, mentions: MentionInfo[]): string {
  let body = text.replace(/^\/private\b/i, '').trim();
  const labels = mentions
    .map((m) => (m.name ? `@${m.name}` : undefined))
    .filter((x): x is string => Boolean(x))
    .sort((a, b) => b.length - a.length);
  for (const label of labels) {
    body = body.split(label).join(' ');
  }
  return body.replace(/\s+/g, ' ').trim();
}

export function privateWorkspacePath(parent: Pick<Project, 'cwd'>, sourceId: string): string {
  return join(resolve(parent.cwd), '.feishu-codex', 'private', safeTopicWorkspaceName(sourceId));
}

export function privateProjectName(parent: Pick<Project, 'name'>, title: string, sourceId: string): string {
  const parentName = truncateClean(parent.name, PRIVATE_PARENT_MAX) || '项目';
  const shortTitle = truncateClean(title, PRIVATE_TITLE_MAX) || '私密协作';
  const suffix = safeTopicWorkspaceName(sourceId).slice(-8) || 'private';
  return `${parentName} · 私密 · ${shortTitle} · ${suffix}`;
}

export function privateSourcePrompt(opts: {
  taskText: string;
  parentProjectName: string;
  parentChatId: string;
  sourceThreadId?: string;
  sourceMessageId: string;
  participants: PrivateParticipant[];
}): string {
  const task = opts.taskText.trim() || '我们开始一个私密协作任务。请先结合来源上下文，询问我下一步要做什么。';
  const participants = opts.participants.map((p) => p.name || `…${p.openId.slice(-6)}`).join('、') || '仅发起人';
  const lines = [
    '[Bridge 私密协作来源]',
    `父项目：${opts.parentProjectName}`,
    `父群 chat_id：${opts.parentChatId}`,
    opts.sourceThreadId ? `来源话题 thread_id：${opts.sourceThreadId}` : '',
    `来源消息 message_id：${opts.sourceMessageId}`,
    `私密群参与者：${participants}`,
    '请把这个私密群视为该项目下的独立会话；不要把回答发回父群，除非用户明确要求。',
    '[/Bridge 私密协作来源]',
  ].filter(Boolean);
  return `${lines.join('\n')}\n\n${task}`;
}

function truncateClean(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
