import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

const QUOTE_MAX = 800;
const LINE_MAX = 280;
const THREAD_WEAVE_MAX = 20;
const THREAD_PAGE_SIZE = 50;

export interface ContextMessage {
  messageId: string;
  senderName: string;
  text: string;
  fromUser: boolean;
  createTime: number;
}

interface RawMsgItem {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  deleted?: boolean;
  sender?: { id?: string; sender_type?: string; sender_name?: string };
  body?: { content?: string };
  mentions?: { key?: string; name?: string }[];
}

export async function fetchQuotedMessage(
  channel: LarkChannel,
  messageId: string,
): Promise<ContextMessage | undefined> {
  try {
    const res = await channel.rawClient.im.v1.message.get({ path: { message_id: messageId } });
    const items = (res.data as { items?: RawMsgItem[] } | undefined)?.items ?? [];
    const item = items[0];
    if (!item || item.deleted) return undefined;
    const cm = toContextMessage(item);
    return cm.text.trim() ? cm : undefined;
  } catch (err) {
    log.warn('intake', 'quote-fetch-failed', { messageId, err: String(err) });
    return undefined;
  }
}

export async function fetchThreadContext(
  channel: LarkChannel,
  threadId: string,
  opts: { sinceTime?: number; excludeMessageId?: string; limit?: number } = {},
): Promise<ContextMessage[]> {
  const limit = opts.limit ?? THREAD_WEAVE_MAX;
  const since = opts.sinceTime ?? 0;
  try {
    const res = await channel.rawClient.im.v1.message.list({
      params: {
        container_id_type: 'thread',
        container_id: threadId,
        sort_type: 'ByCreateTimeDesc',
        page_size: THREAD_PAGE_SIZE,
      },
    });
    const items = (res.data as { items?: RawMsgItem[] } | undefined)?.items ?? [];
    const picked = items
      .filter((it) => !it.deleted)
      .map(toContextMessage)
      .filter(
        (m) =>
          m.fromUser &&
          m.messageId !== opts.excludeMessageId &&
          (since === 0 || m.createTime > since) &&
          m.text.trim().length > 0,
      );
    picked.sort((a, b) => a.createTime - b.createTime);
    const out = picked.slice(-limit);
    if (picked.length > out.length) {
      log.info('intake', 'thread-context-truncated', { threadId, kept: out.length, total: picked.length });
    }
    return out;
  } catch (err) {
    log.warn('intake', 'thread-context-failed', { threadId, err: String(err) });
    return [];
  }
}

function toContextMessage(item: RawMsgItem): ContextMessage {
  const id = item.sender?.id ?? '';
  const name = item.sender?.sender_name || (id ? `用户${id.slice(-4)}` : '某人');
  return {
    messageId: item.message_id ?? '',
    senderName: name,
    text: extractMessageText(item.msg_type, item.body?.content, item.mentions),
    fromUser: item.sender?.sender_type === 'user',
    createTime: Number(item.create_time) || 0,
  };
}

export function extractMessageText(
  msgType: string | undefined,
  content: string | undefined,
  mentions?: { key?: string; name?: string }[],
): string {
  if (!content) return placeholderFor(msgType);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return placeholderFor(msgType);
  }
  switch (msgType) {
    case 'text':
      return replaceMentions((parsed as { text?: string } | null)?.text ?? '', mentions);
    case 'post':
      return replaceMentions(extractPostText(parsed), mentions);
    case 'image':
      return '[图片]';
    case 'audio':
      return '[语音]';
    case 'media':
      return '[视频]';
    case 'file': {
      const name = (parsed as { file_name?: string } | null)?.file_name;
      return name ? `[文件：${name}]` : '[文件]';
    }
    case 'sticker':
      return '[表情]';
    case 'interactive':
      return '[卡片消息]';
    case 'share_chat':
      return '[分享群名片]';
    case 'share_user':
      return '[分享个人名片]';
    case 'merge_forward':
    case 'forward':
      return '[合并转发消息]';
    default:
      return placeholderFor(msgType);
  }
}

function placeholderFor(msgType: string | undefined): string {
  return msgType ? `[${msgType} 消息]` : '[消息]';
}

function extractPostText(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const obj = parsed as Record<string, unknown>;
  let title = obj.title;
  let blocks = obj.content;
  if (!Array.isArray(blocks)) {
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && Array.isArray((v as { content?: unknown }).content)) {
        title = (v as { title?: unknown }).title;
        blocks = (v as { content?: unknown }).content;
        break;
      }
    }
  }
  const parts: string[] = [];
  if (typeof title === 'string' && title.trim()) parts.push(title.trim());
  if (Array.isArray(blocks)) {
    for (const line of blocks) {
      if (!Array.isArray(line)) continue;
      const lineText = line.map(nodeToText).join('');
      if (lineText) parts.push(lineText);
    }
  }
  return parts.join('\n');
}

function nodeToText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;
  switch (n.tag) {
    case 'text':
      return typeof n.text === 'string' ? n.text : '';
    case 'a':
      return typeof n.text === 'string' ? n.text : typeof n.href === 'string' ? n.href : '';
    case 'at': {
      const name = typeof n.user_name === 'string' ? n.user_name : '';
      return name ? `@${name}` : '@某人';
    }
    case 'img':
      return '[图片]';
    case 'media':
      return '[视频]';
    case 'emotion':
      return '[表情]';
    default:
      return typeof n.text === 'string' ? n.text : '';
  }
}

function replaceMentions(text: string, mentions?: { key?: string; name?: string }[]): string {
  if (!text || !mentions?.length) return text;
  let out = text;
  for (const m of mentions) {
    if (!m.key) continue;
    out = out.split(m.key).join(m.name ? `@${m.name}` : '@某人');
  }
  return out;
}

export function sanitizeContext(s: string, maxLen: number, oneLine: boolean): string {
  if (!s) return '';
  let out = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n?/g, '\n');
  out = oneLine ? out.replace(/\s+/g, ' ') : out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  out = out.trim();
  return out.length > maxLen ? `${out.slice(0, maxLen)}…` : out;
}

export function weaveQuote(text: string, quoted: ContextMessage | undefined): string {
  if (!quoted) return text;
  const who = sanitizeContext(quoted.senderName, 40, true) || '某人';
  const body = sanitizeContext(quoted.text, QUOTE_MAX, true);
  if (!body) return text;
  const block = `[用户引用了一条消息（来自 ${who}）：\n${body}\n]`;
  const base = text.trim();
  return base ? `${block}\n\n${base}` : block;
}

export function weaveThreadHistory(text: string, msgs: ContextMessage[]): string {
  if (msgs.length === 0) return text;
  const lines = msgs
    .map((m) => {
      const who = sanitizeContext(m.senderName, 40, true) || '某人';
      const body = sanitizeContext(m.text, LINE_MAX, true);
      return body ? `${who}：${body}` : '';
    })
    .filter((l) => l.length > 0);
  if (lines.length === 0) return text;
  const block = `[话题中在此之前已有的消息（按时间先后排列，供你理解上下文）：\n${lines.join('\n')}\n]`;
  const base = text.trim();
  return base ? `${block}\n\n${base}` : block;
}
