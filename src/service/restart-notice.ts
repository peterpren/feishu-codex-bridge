import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config/paths';

const NOTICE_TTL_MS = 30 * 60 * 1000;

export type RestartReason = 'manual_restart' | 'version_update';

export interface RestartNotice {
  id: string;
  reason: RestartReason;
  requestedAt: string;
  runs?: RestartInterruptedRun[];
}

export interface RestartInterruptedRun {
  appId: string;
  chatId: string;
  replyToMessageId: string;
  replyInThread?: boolean;
  cardMessageId?: string;
  feishuThreadId?: string;
  requesterOpenId?: string;
  requesterName?: string;
  projectName?: string;
  topicTitle?: string;
  promptPreview?: string;
  startedAt?: string;
}

interface RestartNoticeOpts {
  dir?: string;
  now?: Date;
}

function noticeFile(dir = paths.appDir): string {
  return join(dir, 'restart-notice.json');
}

function sentDir(dir = paths.appDir): string {
  return join(dir, 'restart-notices');
}

function sentFile(appId: string, noticeId: string, dir = paths.appDir): string {
  return join(sentDir(dir), `${noticeId}.${appId}.sent`);
}

function runsFile(appId: string, noticeId: string, dir = paths.appDir): string {
  return join(sentDir(dir), `${noticeId}.${appId}.runs.json`);
}

export async function markRestartIntent(reason: RestartReason, opts: RestartNoticeOpts = {}): Promise<RestartNotice> {
  const dir = opts.dir ?? paths.appDir;
  const notice: RestartNotice = {
    id: `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    reason,
    requestedAt: (opts.now ?? new Date()).toISOString(),
  };
  await mkdir(dir, { recursive: true });
  const target = noticeFile(dir);
  const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(notice, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
  return notice;
}

export async function restartNoticeForApp(appId: string, opts: RestartNoticeOpts = {}): Promise<RestartNotice | undefined> {
  const dir = opts.dir ?? paths.appDir;
  let notice: RestartNotice;
  try {
    notice = JSON.parse(await readFile(noticeFile(dir), 'utf8')) as RestartNotice;
  } catch {
    return undefined;
  }
  if (!notice.id || !notice.requestedAt) return undefined;
  const age = (opts.now ?? new Date()).getTime() - Date.parse(notice.requestedAt);
  if (!Number.isFinite(age) || age < 0 || age > NOTICE_TTL_MS) return undefined;
  if (existsSync(sentFile(appId, notice.id, dir))) return undefined;
  return { ...notice, runs: await readRuns(appId, notice.id, dir) };
}

export async function markRestartNoticeSent(appId: string, noticeId: string, opts: RestartNoticeOpts = {}): Promise<void> {
  const dir = opts.dir ?? paths.appDir;
  await mkdir(sentDir(dir), { recursive: true });
  await writeFile(sentFile(appId, noticeId, dir), new Date().toISOString(), 'utf8');
}

export async function recordRestartInterruptedRuns(
  appId: string,
  runs: RestartInterruptedRun[],
  opts: RestartNoticeOpts = {},
): Promise<RestartNotice | undefined> {
  const clean = runs.filter((r) => r.appId === appId && r.chatId && r.replyToMessageId);
  if (clean.length === 0) return undefined;

  const dir = opts.dir ?? paths.appDir;
  const notice = await readCurrentNotice(dir) ?? await markRestartIntent('manual_restart', opts);
  await mkdir(sentDir(dir), { recursive: true });

  const existing = await readRuns(appId, notice.id, dir);
  const merged = dedupeRuns([...existing, ...clean]);
  const target = runsFile(appId, notice.id, dir);
  const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
  return { ...notice, runs: merged };
}

async function readCurrentNotice(dir: string): Promise<RestartNotice | undefined> {
  try {
    const notice = JSON.parse(await readFile(noticeFile(dir), 'utf8')) as RestartNotice;
    if (!notice.id || !notice.requestedAt) return undefined;
    return notice;
  } catch {
    return undefined;
  }
}

async function readRuns(appId: string, noticeId: string, dir: string): Promise<RestartInterruptedRun[]> {
  try {
    const parsed = JSON.parse(await readFile(runsFile(appId, noticeId, dir), 'utf8')) as RestartInterruptedRun[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r) => r?.appId === appId && Boolean(r.chatId) && Boolean(r.replyToMessageId));
  } catch {
    return [];
  }
}

function dedupeRuns(runs: RestartInterruptedRun[]): RestartInterruptedRun[] {
  const out = new Map<string, RestartInterruptedRun>();
  for (const run of runs) {
    const key = [run.appId, run.cardMessageId || run.replyToMessageId, run.startedAt || ''].join(':');
    out.set(key, run);
  }
  return [...out.values()];
}
