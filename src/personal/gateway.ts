import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withUserAccessToken, type LarkChannel } from '@larksuiteoapi/node-sdk';
import { paths } from '../config/paths';
import type { AppConfig } from '../config/schema';
import { getValidPersonalAccessToken } from './oauth';

export type PersonalDataKind = 'docs' | 'minutes';

export interface PersonalDataRequest {
  kind: PersonalDataKind;
  query: string;
  appId: string;
  openId: string;
  chatId: string;
  messageId: string;
  projectName?: string;
}

export interface PersonalSearchResult {
  title: string;
  summary?: string;
  url?: string;
  token?: string;
  docType?: string;
  entityType?: string;
  ownerName?: string;
  updatedAt?: number;
  content?: string;
  contentError?: string;
}

export interface PersonalDataBundle {
  kind: PersonalDataKind;
  query: string;
  results: PersonalSearchResult[];
}

export function parsePersonalDataCommand(text: string): { kind?: PersonalDataKind | 'status' | 'help'; query: string } {
  const raw = text.replace(/^\/me\b/i, '').trim();
  if (!raw) return { kind: 'help', query: '' };
  const [head = '', ...rest] = raw.split(/\s+/);
  const name = head.toLowerCase();
  const query = rest.join(' ').trim();
  if (name === 'status' || head === '状态') return { kind: 'status', query };
  if (name === 'docs' || name === 'doc' || head === '文档') return { kind: 'docs', query };
  if (name === 'minutes' || name === 'minute' || head === '会议' || head === '会议纪要' || head === '妙记') {
    return { kind: 'minutes', query };
  }
  return { kind: 'docs', query: raw };
}

export function detectPersonalDataIntent(text: string): { kind: PersonalDataKind; query: string } | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean || clean.startsWith('/')) return null;
  const wantsLookup = /(查|找|搜|搜索|看一下|看看|读取|基于|根据|参考|总结|整理|有没有|帮我看)/.test(clean);
  const personalScope = /(我的?飞书|我飞书|我能访问|我有权限|个人飞书|飞书里|飞书上|云空间|云盘)/.test(clean);
  const minuteSource = /(会议纪要|妙记|会议记录|会后纪要)/.test(clean);
  if (minuteSource && (wantsLookup || personalScope)) return { kind: 'minutes', query: clean };

  const docSource = /(文档|云文档|飞书文档|资料|材料|文件)/.test(clean);
  if (docSource && personalScope && wantsLookup) return { kind: 'docs', query: clean };
  if (/(我的?飞书里|我飞书里|个人飞书里|我能访问的).*(文档|资料|材料|文件)/.test(clean)) {
    return { kind: 'docs', query: clean };
  }
  return null;
}

export async function fetchPersonalDataBundle(
  channel: LarkChannel,
  cfg: AppConfig,
  req: PersonalDataRequest,
): Promise<PersonalDataBundle> {
  const startedAt = Date.now();
  try {
    const auth = await getValidPersonalAccessToken(channel, cfg, req.openId);
    if (!auth) throw new Error('还没有绑定个人飞书权限，请先发送 `/connect`。');
    const query = normalizeQuery(req.kind, req.query);
    const results = await searchDocWiki(channel, auth.token, query);
    const withContent = await attachReadableContent(channel, auth.token, results, req.kind === 'minutes' ? 2 : 3);
    await appendPersonalAudit({ ...req, query, status: 'ok', resultCount: withContent.length, durationMs: Date.now() - startedAt });
    return { kind: req.kind, query, results: withContent };
  } catch (err) {
    await appendPersonalAudit({
      ...req,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}

function normalizeQuery(kind: PersonalDataKind, query: string): string {
  const q = query.trim();
  if (kind === 'minutes') return q ? `${q} 会议纪要 妙记` : '会议纪要 妙记';
  return q || '最近文档';
}

async function searchDocWiki(channel: LarkChannel, token: string, query: string): Promise<PersonalSearchResult[]> {
  const resp = await channel.rawClient.search.docWiki.search(
    {
      data: {
        query,
        page_size: 5,
        doc_filter: { sort_type: 'EDIT_TIME' },
        wiki_filter: { sort_type: 'EDIT_TIME' },
      },
    },
    withUserAccessToken(token),
  );
  if (resp.code !== 0) throw new Error(resp.msg || '个人飞书文档搜索失败');
  return (resp.data?.res_units ?? []).map((item) => {
    const meta = item.result_meta;
    return {
      title: stripHighlight(item.title_highlighted || meta?.url || '未命名文档'),
      summary: stripHighlight(item.summary_highlighted || ''),
      url: meta?.url,
      token: meta?.token,
      docType: meta?.doc_types,
      entityType: item.entity_type,
      ownerName: meta?.owner_name,
      updatedAt: meta?.update_time,
    };
  });
}

async function attachReadableContent(
  channel: LarkChannel,
  token: string,
  results: PersonalSearchResult[],
  maxDocs: number,
): Promise<PersonalSearchResult[]> {
  let fetched = 0;
  const out: PersonalSearchResult[] = [];
  for (const result of results) {
    if (fetched >= maxDocs || result.docType !== 'DOCX' || !result.token) {
      out.push(result);
      continue;
    }
    fetched++;
    try {
      const content = await channel.rawClient.docx.v1.document.rawContent(
        { path: { document_id: result.token } },
        withUserAccessToken(token),
      );
      out.push({ ...result, content: truncateContent(content.data?.content ?? '') });
    } catch (err) {
      out.push({ ...result, contentError: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

function stripHighlight(input: string): string {
  return input.replace(/<\/?em>/g, '').replace(/\s+/g, ' ').trim();
}

function truncateContent(input: string): string {
  const clean = input.replace(/\s+/g, ' ').trim();
  return clean.length > 3_000 ? `${clean.slice(0, 3_000)}…` : clean;
}

export function formatPersonalDataForPrompt(bundle: PersonalDataBundle): string {
  const label = bundle.kind === 'minutes' ? '会议纪要/妙记搜索' : '个人文档搜索';
  const lines = [
    '[Bridge 个人飞书数据]',
    `数据类型：${label}`,
    `查询词：${bundle.query}`,
    '权限边界：以下数据只来自当前发言人的个人飞书授权；不要声称访问了其他人的飞书资料。',
    '',
  ];
  if (bundle.results.length === 0) {
    lines.push('没有搜索到结果。');
    return lines.join('\n');
  }
  bundle.results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    if (r.url) lines.push(`   链接：${r.url}`);
    if (r.docType) lines.push(`   类型：${r.docType}`);
    if (r.ownerName) lines.push(`   所有者：${r.ownerName}`);
    if (r.summary) lines.push(`   摘要：${r.summary}`);
    if (r.content) lines.push(`   正文摘录：${r.content}`);
    if (r.contentError) lines.push(`   正文读取失败：${r.contentError}`);
  });
  return lines.join('\n');
}

export function formatPersonalDataSummary(bundle: PersonalDataBundle): string {
  const label = bundle.kind === 'minutes' ? '会议纪要/妙记' : '个人文档';
  return `已用你的个人飞书权限搜索「${bundle.query}」，找到 ${bundle.results.length} 条${label}结果。`;
}

interface AuditInput extends PersonalDataRequest {
  status: 'ok' | 'failed';
  resultCount?: number;
  error?: string;
  durationMs: number;
}

async function appendPersonalAudit(input: AuditInput): Promise<void> {
  await mkdir(paths.personalAuditDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    appId: input.appId,
    openId: input.openId,
    chatId: input.chatId,
    messageId: input.messageId,
    projectName: input.projectName,
    kind: input.kind,
    query: input.query.slice(0, 200),
    status: input.status,
    resultCount: input.resultCount,
    error: input.error,
    durationMs: input.durationMs,
  });
  await appendFile(join(paths.personalAuditDir, `${day}.jsonl`), `${line}\n`, 'utf8');
}
