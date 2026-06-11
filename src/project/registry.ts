import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import type { McpServerConfig, PermissionMode } from '../agent/types';

export type CloudDocCreateAs = 'user' | 'bot';

export interface CloudDocFolderPermission {
  status: 'granted' | 'failed';
  via?: 'bot' | 'user' | 'mixed';
  scope?: 'project_admins' | 'topic_owner_admins' | 'group';
  error?: string;
  updatedAt: number;
}

export interface CloudDocFolder {
  token: string;
  url?: string;
  createAs?: CloudDocCreateAs;
  permission?: CloudDocFolderPermission;
}

export type TopicWorkspaceMode = 'shared' | 'isolated';

export const DEFAULT_ADMIN_MODE: PermissionMode = 'full';
export const DEFAULT_GUEST_MODE: PermissionMode = 'write';
export const DEFAULT_NETWORK = true;

export type ProjectMcpServer = McpServerConfig;

export const FOOD_MCP_SERVERS: readonly ProjectMcpServer[] = [
  {
    name: 'luckin-coffee',
    title: '瑞幸咖啡',
    url: 'https://gwmcp.lkcoffee.com/order/user/mcp',
    bearerTokenEnvVar: 'LUCKIN_MCP_TOKEN',
    bearerTokenSecretId: 'mcp:LUCKIN_MCP_TOKEN',
    enabled: true,
  },
  {
    name: 'mcd-mcp',
    title: '麦当劳',
    url: 'https://mcp.mcd.cn',
    bearerTokenEnvVar: 'MCD_MCP_TOKEN',
    bearerTokenSecretId: 'mcp:MCD_MCP_TOKEN',
    enabled: true,
  },
];

const FOOD_MCP_NAMES = new Set(FOOD_MCP_SERVERS.map((server) => server.name));

/** A project = a Feishu group bound to a fixed working directory. */
export interface Project {
  /** unique project name (also the group name) */
  name: string;
  /** the bound Feishu group chat_id (oc_xxx) */
  chatId: string;
  /** absolute working directory codex runs in for this project */
  cwd: string;
  /** true when bridge created the cwd as a blank project (under this bot's local workspace root) */
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
  /** 项目级响应白名单：谁能让 bot 在本群响应/跑 codex。空/缺省 = 所有人；
   * admin/owner 恒豁免（见 isUserAllowedInProject）。 */
  allowedUsers?: string[];
  /** permission tier for codex's sandbox — the tier ADMINS/owner get. Omitted →
   * treated as 'full' (danger-full-access).
   * Read via {@link effectiveMode}. 'qa'/'write' confine reads+writes to `cwd`. */
  mode?: PermissionMode;
  /** permission tier for NON-admin senders. Omitted → 'write'. When set to a
   * distinct tier, admin and guest turns run on SEPARATE codex threads (see
   * {@link turnTier}). Read via {@link effectiveGuestMode}. */
  guestMode?: PermissionMode;
  /** allow the sandboxed agent's shell to reach the network (only meaningful for
   * 'qa'/'write'; 'full' is always networked). Omitted → true. */
  network?: boolean;
  /** Codex auto-compacts old context near the model window. Missing = on. */
  autoCompact?: boolean;
  /** Multi-topic file boundary. 'isolated' gives each topic its own writable cwd;
   * 'shared' keeps the legacy behavior where every topic writes the project cwd.
   * Missing = isolated for multi-topic groups, shared for single-session groups. */
  topicWorkspace?: TopicWorkspaceMode;
  /** Default Feishu Drive folder for cloud docs Codex creates for this project. */
  cloudDocFolder?: CloudDocFolder;
  /** Project-scoped MCP servers. Tokens are referenced by env var only. */
  mcpServers?: ProjectMcpServer[];
  /** Private child group created from a parent project via `/private`. */
  private?: boolean;
  /** Parent project chat_id for private child groups. */
  parentChatId?: string;
  /** Parent project name for private child groups. */
  parentProjectName?: string;
  /** Source topic thread_id when `/private` was triggered inside a topic. */
  sourceThreadId?: string;
  /** Source message_id that triggered `/private`. */
  sourceMessageId?: string;
  /** Private group participants: initiator + explicitly @mentioned users. */
  participants?: string[];
  /** Users that were @mentioned for a private group but could not be added. */
  participantAddFailures?: { openId: string; error: string; attemptedAt: number }[];
}

const FOLDER_URL_RE = /\/drive\/folder\/([^/?#]+)/;
const FOLDER_TOKEN_RE = /^fld[a-zA-Z0-9_-]+$/;

export function parseCloudDocFolder(input: string): CloudDocFolder | undefined {
  const raw = input.trim();
  if (!raw) return undefined;

  const fromUrl = FOLDER_URL_RE.exec(raw)?.[1];
  if (fromUrl) return { token: fromUrl, url: raw, createAs: 'user' };
  if (FOLDER_TOKEN_RE.test(raw)) return { token: raw, createAs: 'user' };

  throw new Error('飞书云空间目录请填写文件夹 URL，或 fld... 开头的文件夹 token');
}

export function cloudDocFolderLabel(folder: CloudDocFolder | undefined): string {
  if (!folder?.token) return '未设置';
  return folder.url ? `${folder.token}` : folder.token;
}

export function cloudDocFolderPermissionLabel(folder: CloudDocFolder | undefined): string {
  const p = folder?.permission;
  if (!folder?.token) return '未设置';
  if (!p) return '未授权';
  if (p.status === 'granted') {
    const label =
      p.scope === 'topic_owner_admins'
        ? '话题发起人/管理员'
        : p.scope === 'group'
          ? '群编辑'
          : p.scope === 'project_admins'
            ? '管理员/机器人'
            : '权限';
    return `已配置${label}权限${p.via ? `（${p.via}）` : ''}`;
  }
  return `授权失败${p.error ? `：${p.error}` : ''}`;
}

/**
 * Default for 免@ (respond without @) when a project hasn't set `noMention`
 * explicitly. Multi-topic groups default off: topic chatter should not be
 * captured by Codex unless the group admin opts in. Single-session groups keep
 * the chat-like default for bot-created groups, while joined existing groups
 * default off to avoid taking over a busy group.
 */
export function defaultNoMention(p: Pick<Project, 'kind' | 'origin'>): boolean {
  const kind = p.kind ?? 'multi';
  if (kind === 'multi') return false;
  return (p.origin ?? 'created') !== 'joined';
}

/**
 * A project's effective permission tier. Old data (no `mode`) → 'full', so
 * existing projects keep danger-full-access and are unaffected; only an
 * explicitly-set tier confines the sandbox. Single source of truth — every
 * `mode ?? …` read goes through here.
 */
export function effectiveMode(p: Pick<Project, 'mode'>): PermissionMode {
  return p.mode ?? DEFAULT_ADMIN_MODE;
}

/**
 * The effective tier for NON-admin senders. Unset `guestMode` → project read
 * and write, so ordinary group members stay inside the project folder by
 * default.
 */
export function effectiveGuestMode(p: Pick<Project, 'mode' | 'guestMode'>): PermissionMode {
  return p.guestMode ?? DEFAULT_GUEST_MODE;
}

/** Effective network switch for confined tiers. Full access is networked by the
 * Codex backend regardless, but callers still use this for UI and qa/write. */
export function effectiveNetwork(p: Pick<Project, 'network'>): boolean {
  return p.network ?? DEFAULT_NETWORK;
}

export function enabledProjectMcpServers(p: Pick<Project, 'mcpServers'> | undefined): ProjectMcpServer[] {
  return (p?.mcpServers ?? [])
    .filter((server) => server.enabled !== false && server.name.trim() && server.url.trim())
    .map((server) => ({
      ...server,
      name: server.name.trim(),
      url: server.url.trim(),
      bearerTokenEnvVar: server.bearerTokenEnvVar?.trim(),
      bearerTokenSecretId: server.bearerTokenSecretId?.trim(),
    }));
}

export function foodMcpEnabled(p: Pick<Project, 'mcpServers'>): boolean {
  const enabled = new Set(enabledProjectMcpServers(p).map((server) => server.name));
  return FOOD_MCP_SERVERS.every((server) => enabled.has(server.name));
}

export function withFoodMcpServers(existing: readonly ProjectMcpServer[] | undefined): ProjectMcpServer[] {
  const byName = new Map<string, ProjectMcpServer>();
  for (const server of existing ?? []) byName.set(server.name, { ...server });
  for (const server of FOOD_MCP_SERVERS) {
    byName.set(server.name, { ...byName.get(server.name), ...server, enabled: true });
  }
  return [...byName.values()];
}

export function withoutFoodMcpServers(existing: readonly ProjectMcpServer[] | undefined): ProjectMcpServer[] | undefined {
  const next = (existing ?? []).filter((server) => !FOOD_MCP_NAMES.has(server.name));
  return next.length ? next.map((server) => ({ ...server })) : undefined;
}

/**
 * Resolve a turn's permission tier + role from the sender's admin status.
 * `split` is true when the effective admin and guest tiers differ — then the
 * sandbox AND the codex conversation history (both bound per thread) differ by
 * role, so admin and guest turns MUST run on separate threads. The caller
 * namespaces the session key by `role` when `split` to keep a guest from ever
 * inheriting the admin thread (its sandbox or its history). No split → one
 * shared thread per topic, unchanged from before.
 */
export function turnTier(
  p: Pick<Project, 'mode' | 'guestMode'>,
  isAdminSender: boolean,
): { mode: PermissionMode; role: 'admin' | 'guest'; split: boolean } {
  const adminTier = effectiveMode(p);
  const guestTier = effectiveGuestMode(p);
  return {
    mode: isAdminSender ? adminTier : guestTier,
    role: isAdminSender ? 'admin' : 'guest',
    split: guestTier !== adminTier,
  };
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

// 同进程内并发的「读-改-写」串行化（addProject/updateProject/removeProject）：既防
// 共用 tmp 文件交错损坏，也防两个回调基于同一旧快照算 next、后写覆盖前写的丢更新
// （白名单数组增删最易踩中）。配合函数式 updater，把 read+算+write 收进一个临界区。
let opChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function write(projects: Project[]): Promise<void> {
  await mkdir(dirname(paths.projectsFile), { recursive: true });
  const tmp = `${paths.projectsFile}.tmp-${process.pid}-${randomUUID()}`;
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
  return withLock(async () => {
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
  });
}

/** Patch fields of a project by name; no-op if it doesn't exist. `patch` 可以是
 * 对象，或一个 `(p) => patch` 函数——后者在同一临界区内基于**最新盘值**计算补丁，
 * 用于数组增量改写（如 allowedUsers append/filter）避免丢更新。 */
export async function updateProject(
  name: string,
  patch: Partial<Omit<Project, 'name'>> | ((p: Project) => Partial<Omit<Project, 'name'>>),
): Promise<void> {
  return withLock(async () => {
    const projects = await read();
    const p = projects.find((x) => x.name === name);
    if (!p) return;
    const actual = typeof patch === 'function' ? patch(p) : patch;
    const target = p as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(actual)) {
      if (v === undefined) delete target[k];
      else target[k] = v;
    }
    await write(projects);
  });
}

/** Rename a project registry key. Used by private child groups whose visible
 * chat title can be changed after creation. The bound chat_id/cwd stay stable. */
export async function renameProject(oldName: string, newName: string): Promise<Project | undefined> {
  const targetName = newName.trim();
  if (!targetName) throw new Error('项目名不能为空');

  return withLock(async () => {
    const projects = await read();
    const p = projects.find((x) => x.name === oldName);
    if (!p) return undefined;
    if (p.name === targetName) return p;
    if (projects.some((x) => x.name === targetName)) {
      throw new Error(`项目名「${targetName}」已存在`);
    }
    p.name = targetName;
    await write(projects);
    return p;
  });
}

/** Remove (unbind) a project by name. Returns the removed entry, if any. */
export async function removeProject(name: string): Promise<Project | undefined> {
  return withLock(async () => {
    const projects = await read();
    const idx = projects.findIndex((p) => p.name === name);
    if (idx === -1) return undefined;
    const [removed] = projects.splice(idx, 1);
    await write(projects);
    return removed;
  });
}
