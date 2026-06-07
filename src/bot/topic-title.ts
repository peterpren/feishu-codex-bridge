const DEFAULT_TITLE = '新任务';
const MAX_TITLE_CHARS = 28;
const MAX_MANUAL_TITLE_CHARS = 60;

const GENERIC_PREFIX_RE = /^(?:请|麻烦|辛苦)?(?:帮我看一下|帮我看下|帮我分析一下|帮我分析下|帮我判断一下|帮我判断下|帮我|帮忙|帮|协助我|你看一下|看一下|看下|我想|想|需要|能否|是否|可以|可不可以)\s*/;
const GENERIC_COLON_PREFIX_RE = /^(?:加一个|增加一个|新增一个|加|增加|新增)?(?:功能|需求|问题|事情|任务|想法|方案)\s*[：:]\s*/;

export function deriveTopicTitle(input: string): string {
  let title = normalize(input);
  if (!title) return DEFAULT_TITLE;

  title = title
    .replace(GENERIC_PREFIX_RE, '')
    .replace(GENERIC_COLON_PREFIX_RE, '')
    .replace(/^在(.{1,40}?)之后[，,]?(?:能够|可以)?/, '')
    .replace(/^(?:能够|可以)?自动(?:将|把)?/, '')
    .replace(/^该/, '');

  const colonIdx = title.search(/[：:]/);
  if (colonIdx >= 0 && colonIdx <= 16 && /功能|需求|问题|事情|任务|想法|方案/.test(title.slice(0, colonIdx))) {
    title = title.slice(colonIdx + 1).trim();
  }

  title = firstUsefulClause(title).replace(/[。？！?！、，,；;：:]+$/g, '').trim();
  if (!title) return DEFAULT_TITLE;
  return truncateTitle(title);
}

export function normalizeManualTopicTitle(input: string): string {
  const clean = input.trim().replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const chars = [...clean];
  return chars.length > MAX_MANUAL_TITLE_CHARS
    ? `${chars.slice(0, MAX_MANUAL_TITLE_CHARS - 1).join('')}…`
    : clean;
}

export interface TopicRequester {
  openId?: string;
  name?: string;
}

export function formatTopicTitleMessage(title: string, requester?: TopicRequester): string {
  const safeTitle = sanitizePlainText(title.trim() || DEFAULT_TITLE);
  const openId = normalizeOpenId(requester?.openId);
  if (!openId) return safeTitle;
  const name = sanitizePlainText(normalizeManualTopicTitle(requester?.name ?? '') || '提问人');
  return `${safeTitle} · <at user_id="${openId}">${name}</at>`;
}

function normalize(input: string): string {
  return input
    .replace(/<at\b[^>]*>.*?<\/at>/g, '')
    .replace(/^(@\S+\s*)+/, '')
    .replace(/\s+/g, ' ')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .trim();
}

function firstUsefulClause(input: string): string {
  const sentence = input.split(/[。？！?!\n\r]/)[0]?.trim() ?? '';
  if (!sentence) return input.trim();
  const commaParts = sentence.split(/[，,；;]/).map((x) => x.trim()).filter(Boolean);
  const first = commaParts[0];
  if (commaParts.length > 1 && first && first.length >= 8) return first;
  return sentence;
}

function truncateTitle(input: string): string {
  const chars = [...input];
  if (chars.length <= MAX_TITLE_CHARS) return input;
  return `${chars.slice(0, MAX_TITLE_CHARS - 1).join('')}…`;
}

function normalizeOpenId(input: string | undefined): string {
  const id = (input ?? '').trim();
  return /^ou_[a-zA-Z0-9_-]+$/.test(id) ? id : '';
}

function sanitizePlainText(input: string): string {
  return input.replace(/[<>]/g, (ch) => (ch === '<' ? '＜' : '＞'));
}
