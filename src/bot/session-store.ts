import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import type { ReasoningEffort, ServiceTier } from '../agent/types';
import type { CloudDocFolder } from '../project/registry';

/**
 * A persisted session = one Feishu topic (thread) bound to a codex thread.
 * Survives bridge restarts so @bot inside an existing topic resumes the right
 * codex thread (instead of silently starting a fresh one) and the ⚙️ per-session
 * model/effort/speed overrides stick.
 */
export interface SessionRecord {
  /** Feishu topic thread_id (the key) */
  threadId: string;
  chatId: string;
  cwd: string;
  /** codex thread id — pass to backend.resumeThread */
  codexThreadId: string;
  model?: string;
  effort?: ReasoningEffort;
  serviceTier?: ServiceTier;
  /** first user message excerpt, for context */
  summary: string;
  /** Short Feishu topic title shown in the project/session list. */
  topicTitle?: string;
  /** Bot-owned root text message used as the Feishu topic title. */
  topicTitleMessageId?: string;
  /** User who triggered the topic; used to keep the title root message attributable. */
  topicRequesterOpenId?: string;
  topicRequesterName?: string;
  /** Topic-specific Feishu Drive folder for cloud docs. */
  cloudDocFolder?: CloudDocFolder;
  /** Last topic-folder creation/permission error, for local troubleshooting. */
  cloudDocFolderError?: string;
  /** Last Feishu message timestamp fed to Codex; used to weave only new topic context. */
  lastSeenAt?: number;
  createdAt: number;
  updatedAt: number;
}

interface StoreFile {
  version: number;
  sessions: SessionRecord[];
}

const FILE_VERSION = 1;

async function read(): Promise<SessionRecord[]> {
  try {
    const text = await readFile(paths.sessionsFile, 'utf8');
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

let opChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function write(sessions: SessionRecord[]): Promise<void> {
  await mkdir(dirname(paths.sessionsFile), { recursive: true });
  const tmp = `${paths.sessionsFile}.tmp-${process.pid}-${randomUUID()}`;
  const body: StoreFile = { version: FILE_VERSION, sessions };
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await rename(tmp, paths.sessionsFile);
}

export async function listSessions(): Promise<SessionRecord[]> {
  return read();
}

export async function getSession(threadId: string): Promise<SessionRecord | undefined> {
  return (await read()).find((s) => s.threadId === threadId);
}

/** Insert or replace a session by threadId. */
export async function upsertSession(rec: SessionRecord): Promise<void> {
  return withLock(async () => {
    const sessions = await read();
    const idx = sessions.findIndex((s) => s.threadId === rec.threadId);
    if (idx === -1) sessions.push(rec);
    else sessions[idx] = rec;
    await write(sessions);
  });
}

/** Patch fields of an existing session; no-op if it doesn't exist. */
export async function patchSession(
  threadId: string,
  patch:
    | Partial<Omit<SessionRecord, 'threadId'>>
    | ((s: SessionRecord) => Partial<Omit<SessionRecord, 'threadId'>>),
): Promise<void> {
  return withLock(async () => {
    const sessions = await read();
    const rec = sessions.find((s) => s.threadId === threadId);
    if (!rec) return;
    const actual = typeof patch === 'function' ? patch(rec) : patch;
    const target = rec as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(actual)) {
      if (v !== undefined) target[k] = v;
    }
    rec.updatedAt = Date.now();
    await write(sessions);
  });
}

/** Remove the Bridge mapping for one session without touching its Codex thread,
 * local files, cloud documents, or Feishu message history. The next message
 * starts a fresh Codex thread for the same group/topic. */
export async function removeSession(threadId: string): Promise<void> {
  return withLock(async () => {
    const sessions = await read();
    const next = sessions.filter((session) => session.threadId !== threadId);
    if (next.length === sessions.length) return;
    await write(next);
  });
}
