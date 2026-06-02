import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';

/** A project = a Feishu group bound to a fixed working directory. */
export interface Project {
  /** unique project name (also the group name) */
  name: string;
  /** the bound Feishu group chat_id (oc_xxx) */
  chatId: string;
  /** absolute working directory codex runs in for this project */
  cwd: string;
  /** true when bridge created the cwd as a blank project (under projectsRootDir) */
  blank: boolean;
  createdAt: number;
  /** last branch shown in the announcement (for lazy change detection) */
  branch?: string;
  /** group session model: 'multi' (default) = a topic per session (现状);
   * 'single' = the whole group is one session keyed by chatId. */
  kind?: 'multi' | 'single';
  /** respond to non-@ messages too. Read as `noMention ?? defaultNoMention(p)`.
   * multi: only inside a topic; single: whole group. Needs im:message.group_msg. */
  noMention?: boolean;
  /** how the bot got into this group. 'created' (default, omitted on old data) =
   * bridge built the group via chat.create and is its owner; 'joined' = a human
   * added the bot to a pre-existing group and the bot is just a plain member. */
  origin?: 'created' | 'joined';
  /** for 'joined' projects: open_id of the person who added the bot + did the
   * bind (the bot DMs them the bind card / a removal notice). */
  addedBy?: string;
}

/**
 * Default for 免@ (respond without @) when a project hasn't set `noMention`
 * explicitly. On for everything **except** a *joined* single-session group:
 * making the whole of a pre-existing (possibly busy / multi-person) group run
 * codex on every message without an @ is too aggressive, so that one combo
 * defaults off. Created groups (incl. single) keep the historical default (on),
 * so existing data is unaffected. Single source of truth — every
 * `noMention ?? …` read goes through here.
 */
export function defaultNoMention(p: Pick<Project, 'kind' | 'origin'>): boolean {
  return !((p.origin ?? 'created') === 'joined' && (p.kind ?? 'multi') === 'single');
}

interface StoreFile {
  version: number;
  projects: Project[];
}

const FILE_VERSION = 1;

async function read(): Promise<Project[]> {
  try {
    const text = await readFile(paths.projectsFile, 'utf8');
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    return Array.isArray(parsed.projects) ? parsed.projects : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function write(projects: Project[]): Promise<void> {
  await mkdir(dirname(paths.projectsFile), { recursive: true });
  const tmp = `${paths.projectsFile}.tmp-${process.pid}`;
  const body: StoreFile = { version: FILE_VERSION, projects };
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await rename(tmp, paths.projectsFile);
}

export async function listProjects(): Promise<Project[]> {
  return read();
}

export async function getProjectByChatId(chatId: string): Promise<Project | undefined> {
  return (await read()).find((p) => p.chatId === chatId);
}

export async function getProjectByName(name: string): Promise<Project | undefined> {
  return (await read()).find((p) => p.name === name);
}

/** Add a project. Throws if the name — or the bound chat — is already taken.
 * The chatId check is the registry-level hard guard against binding one group
 * twice (createProject's chatId is freshly minted so it never trips). */
export async function addProject(p: Project): Promise<void> {
  const projects = await read();
  if (projects.some((x) => x.name === p.name)) {
    throw new Error(`项目名「${p.name}」已存在`);
  }
  if (p.chatId) {
    const bound = projects.find((x) => x.chatId === p.chatId);
    if (bound) throw new Error(`该群已绑定为项目「${bound.name}」`);
  }
  projects.push(p);
  await write(projects);
}

/** Patch fields of a project by name; no-op if it doesn't exist. */
export async function updateProject(
  name: string,
  patch: Partial<Omit<Project, 'name'>>,
): Promise<void> {
  const projects = await read();
  const p = projects.find((x) => x.name === name);
  if (!p) return;
  const target = p as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) target[k] = v;
  }
  await write(projects);
}

/** Remove (unbind) a project by name. Returns the removed entry, if any. */
export async function removeProject(name: string): Promise<Project | undefined> {
  const projects = await read();
  const idx = projects.findIndex((p) => p.name === name);
  if (idx === -1) return undefined;
  const [removed] = projects.splice(idx, 1);
  await write(projects);
  return removed;
}
