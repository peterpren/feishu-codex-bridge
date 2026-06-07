import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { spawnProcess } from '../platform/spawn';
import type { CloudDocFolder, CloudDocFolderPermission } from './registry';

const MAX_ERROR_CHARS = 180;
const LARK_CLI_TIMEOUT_MS = 20_000;
const TOPIC_FOLDER_NAME_MAX = 80;

export interface GrantCloudDocFolderPermissionResult {
  status: 'granted' | 'failed';
  via?: 'bot' | 'user' | 'mixed';
  scope?: CloudDocFolderPermission['scope'];
  error?: string;
}

export interface CloudDocAccessTarget {
  adminOpenIds: string[];
  appId?: string;
}

export interface TopicCloudDocFolderInput extends CloudDocAccessTarget {
  title: string;
  requesterOpenId: string;
  requesterName?: string;
}

export interface TopicCloudDocFolderResult {
  folder?: CloudDocFolder;
  error?: string;
}

type DriveMemberType = 'openid' | 'openchat' | 'appid';
type DrivePermission = 'edit' | 'full_access';
type DriveMemberData = {
  member_type: DriveMemberType;
  member_id: string;
  perm: DrivePermission;
  type?: 'user' | 'chat';
};

export function permissionRecord(result: GrantCloudDocFolderPermissionResult): CloudDocFolderPermission {
  return {
    status: result.status,
    ...(result.via ? { via: result.via } : {}),
    ...(result.scope ? { scope: result.scope } : {}),
    ...(result.error ? { error: truncate(result.error) } : {}),
    updatedAt: Date.now(),
  };
}

export async function grantProjectCloudDocFolderAccess(
  channel: LarkChannel,
  folder: CloudDocFolder,
  opts: CloudDocAccessTarget & { chatId?: string },
): Promise<GrantCloudDocFolderPermissionResult> {
  if (!folder.token) return { status: 'failed', error: '缺少文件夹 token' };

  const targets = projectAccessMembers(opts);
  if (targets.length === 0) return { status: 'failed', scope: 'project_admins', error: '缺少管理员或机器人 app_id' };

  const grants = [];
  for (const target of targets) {
    grants.push({ member: target, result: await grantMember(channel, folder.token, target) });
  }
  const revoke = opts.chatId ? await revokeGroupPermissionWithBot(channel, folder.token, opts.chatId) : undefined;
  const failures = [
    ...grants.filter((x) => x.result.status === 'failed').map((x) => `${memberLabel(x.member)}: ${x.result.error ?? '失败'}`),
    ...(revoke?.status === 'failed' ? [`移除群权限: ${revoke.error ?? '失败'}`] : []),
  ];

  if (failures.length > 0) {
    return { status: 'failed', scope: 'project_admins', error: truncate(failures.join('; ')) };
  }
  return { status: 'granted', scope: 'project_admins', via: mergeVias([...grants.map((x) => x.result.via), revoke?.via]) };
}

export async function createTopicCloudDocFolder(
  channel: LarkChannel,
  parent: CloudDocFolder,
  opts: TopicCloudDocFolderInput,
): Promise<TopicCloudDocFolderResult> {
  if (!parent.token) return { error: '缺少父文件夹 token' };
  if (!opts.requesterOpenId) return { error: '缺少话题原始发起人 open_id' };

  const name = topicCloudDocFolderName(opts.title, opts.requesterName);
  const created = await createFolder(channel, parent, name);
  if (!created.folder) return { error: created.error ?? '创建话题云文档文件夹失败' };

  const permission = await grantTopicCloudDocFolderAccess(channel, created.folder, opts);
  const folder = { ...created.folder, permission: permissionRecord(permission) };
  if (permission.status === 'failed') return { folder, error: permission.error ?? '话题文件夹权限配置失败' };
  return { folder };
}

export async function grantTopicCloudDocFolderAccess(
  channel: LarkChannel,
  folder: CloudDocFolder,
  opts: TopicCloudDocFolderInput,
): Promise<GrantCloudDocFolderPermissionResult> {
  if (!folder.token) return { status: 'failed', scope: 'topic_owner_admins', error: '缺少文件夹 token' };
  if (!opts.requesterOpenId) return { status: 'failed', scope: 'topic_owner_admins', error: '缺少话题原始发起人 open_id' };

  const targets = topicAccessMembers(opts);
  const grants = [];
  for (const target of targets) {
    grants.push({ member: target, result: await grantMember(channel, folder.token, target) });
  }
  const failures = grants
    .filter((x) => x.result.status === 'failed')
    .map((x) => `${memberLabel(x.member)}: ${x.result.error ?? '失败'}`);

  if (failures.length > 0) {
    return { status: 'failed', scope: 'topic_owner_admins', error: truncate(failures.join('; ')) };
  }
  return { status: 'granted', scope: 'topic_owner_admins', via: mergeVias(grants.map((x) => x.result.via)) };
}

function projectAccessMembers(opts: CloudDocAccessTarget): DriveMemberData[] {
  return uniqueMembers([
    ...(opts.appId ? [appMember(opts.appId)] : []),
    ...openIdMembers(opts.adminOpenIds, 'full_access'),
  ]);
}

function topicAccessMembers(opts: TopicCloudDocFolderInput): DriveMemberData[] {
  const admins = openIdMembers(opts.adminOpenIds, 'full_access');
  const requester = openIdMember(opts.requesterOpenId, 'edit');
  return uniqueMembers([...(opts.appId ? [appMember(opts.appId)] : []), ...admins, requester]);
}

function openIdMembers(ids: string[], perm: DrivePermission): DriveMemberData[] {
  return [...new Set(ids.filter(Boolean))].map((id) => openIdMember(id, perm));
}

function openIdMember(openId: string, perm: DrivePermission): DriveMemberData {
  return { member_type: 'openid', member_id: openId, perm, type: 'user' };
}

function appMember(appId: string): DriveMemberData {
  return { member_type: 'appid', member_id: appId, perm: 'full_access' };
}

function uniqueMembers(members: DriveMemberData[]): DriveMemberData[] {
  const out = new Map<string, DriveMemberData>();
  for (const member of members) {
    const key = `${member.member_type}:${member.member_id}`;
    const existing = out.get(key);
    if (!existing || existing.perm !== 'full_access') out.set(key, member);
  }
  return [...out.values()];
}

async function grantMember(
  channel: LarkChannel,
  folderToken: string,
  member: DriveMemberData,
): Promise<GrantCloudDocFolderPermissionResult> {
  const bot = await grantMemberWithBot(channel, folderToken, member).catch((err) => failResult(err));
  if (bot.status === 'granted') return { ...bot, via: 'bot' };

  const user = await grantMemberWithLarkCliUser(folderToken, member).catch((err) => failResult(err));
  if (user.status === 'granted') return { ...user, via: 'user' };

  return {
    status: 'failed',
    error: truncate(`bot: ${bot.error ?? '失败'}; user: ${user.error ?? '失败'}`),
  };
}

async function grantMemberWithBot(
  channel: LarkChannel,
  folderToken: string,
  member: DriveMemberData,
): Promise<GrantCloudDocFolderPermissionResult> {
  try {
    await channel.rawClient.drive.v1.permissionMember.create({
      path: { token: folderToken },
      params: { type: 'folder', need_notification: false },
      data: member,
    } as any);
    return { status: 'granted' };
  } catch (err) {
    if (isAlreadyGranted(err)) return { status: 'granted' };
    return failResult(err);
  }
}

function grantMemberWithLarkCliUser(
  folderToken: string,
  member: DriveMemberData,
): Promise<GrantCloudDocFolderPermissionResult> {
  const params = JSON.stringify({ token: folderToken, type: 'folder', need_notification: false });
  const data = JSON.stringify(member);
  const args = [
    'drive',
    'permission.members',
    'create',
    '--as',
    'user',
    '--params',
    params,
    '--data',
    data,
    '--yes',
    '--format',
    'json',
  ];

  return runLarkCliGrant(args);
}

async function revokeGroupPermissionWithBot(
  channel: LarkChannel,
  folderToken: string,
  chatId: string,
): Promise<GrantCloudDocFolderPermissionResult> {
  try {
    await channel.rawClient.drive.v1.permissionMember.delete({
      path: { token: folderToken, member_id: chatId },
      params: { type: 'folder', member_type: 'openchat' },
      data: { type: 'chat' },
    } as any);
    return { status: 'granted', via: 'bot' };
  } catch (err) {
    if (isNotFound(err)) return { status: 'granted', via: 'bot' };
    return failResult(err);
  }
}

async function createFolder(
  channel: LarkChannel,
  parent: CloudDocFolder,
  name: string,
): Promise<{ folder?: CloudDocFolder; error?: string }> {
  const bot = await createFolderWithBot(channel, parent.token, name).catch(
    (err): { folder?: CloudDocFolder; error?: string } => ({ error: errorText(err) }),
  );
  if (bot.folder) return bot;

  const user = await createFolderWithLarkCliUser(parent.token, name).catch(
    (err): { folder?: CloudDocFolder; error?: string } => ({ error: errorText(err) }),
  );
  if (user.folder) return user;

  return { error: truncate(`bot: ${bot.error ?? '失败'}; user: ${user.error ?? '失败'}`) };
}

async function createFolderWithBot(
  channel: LarkChannel,
  parentToken: string,
  name: string,
): Promise<{ folder?: CloudDocFolder; error?: string }> {
  const res = await channel.rawClient.drive.v1.file.createFolder({
    data: { name, folder_token: parentToken },
  });
  const token = (res as { data?: { token?: string; url?: string } }).data?.token;
  if (!token) return { error: `未返回文件夹 token：${JSON.stringify(res).slice(0, 160)}` };
  const url = (res as { data?: { url?: string } }).data?.url;
  return { folder: { token, ...(url ? { url } : {}), createAs: 'bot' } };
}

function createFolderWithLarkCliUser(parentToken: string, name: string): Promise<{ folder?: CloudDocFolder; error?: string }> {
  const args = ['drive', '+create-folder', '--as', 'user', '--folder-token', parentToken, '--name', name];
  return runLarkCliCreateFolder(args);
}

function runLarkCliGrant(args: string[]): Promise<GrantCloudDocFolderPermissionResult> {
  return new Promise((resolve) => {
    const child = spawnProcess('lark-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ status: 'failed', error: `lark-cli 超时 ${Math.round(LARK_CLI_TIMEOUT_MS / 1000)}s` });
    }, LARK_CLI_TIMEOUT_MS);

    child.stdout?.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf8');
    });
    child.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: 'failed', error: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = `${stdout}\n${stderr}`.trim();
      if (code === 0 || isAlreadyGranted(text)) resolve({ status: 'granted' });
      else resolve({ status: 'failed', error: text || `lark-cli exit ${code ?? '?'}` });
    });
  });
}

function runLarkCliCreateFolder(args: string[]): Promise<{ folder?: CloudDocFolder; error?: string }> {
  return new Promise((resolve) => {
    const child = spawnProcess('lark-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ error: `lark-cli 超时 ${Math.round(LARK_CLI_TIMEOUT_MS / 1000)}s` });
    }, LARK_CLI_TIMEOUT_MS);

    child.stdout?.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf8');
    });
    child.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ error: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = `${stdout}\n${stderr}`.trim();
      if (code !== 0) {
        resolve({ error: text || `lark-cli exit ${code ?? '?'}` });
        return;
      }
      const folder = parseCreatedFolder(text);
      resolve(folder ? { folder: { ...folder, createAs: 'user' } } : { error: `未识别新文件夹 token：${truncate(text)}` });
    });
  });
}

function parseCreatedFolder(text: string): CloudDocFolder | undefined {
  const parsed = parseJson(text);
  const token = findString(parsed, 'token') ?? /fld[a-zA-Z0-9_-]+/.exec(text)?.[0];
  if (!token) return undefined;
  const url = findString(parsed, 'url') ?? new RegExp(`https?://\\S+/drive/folder/${token}`).exec(text)?.[0];
  return { token, ...(url ? { url } : {}) };
}

function parseJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function findString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (key in value && typeof (value as Record<string, unknown>)[key] === 'string') {
    return (value as Record<string, unknown>)[key] as string;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findString(child, key);
    if (found) return found;
  }
  return undefined;
}

function failResult(err: unknown): GrantCloudDocFolderPermissionResult {
  const text = errorText(err);
  if (isAlreadyGranted(text)) return { status: 'granted' };
  return { status: 'failed', error: text };
}

function isAlreadyGranted(err: unknown): boolean {
  const text = errorText(err).toLowerCase();
  return /already|exist|duplicate|重复|已存在|已经|已是/.test(text);
}

function isNotFound(err: unknown): boolean {
  const text = errorText(err).toLowerCase();
  return /not[ _-]?found|not[ _-]?exist|不存在|未找到|没有找到/.test(text);
}

function errorText(err: unknown): string {
  if (typeof err === 'string') return truncate(err);
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data) {
    try {
      return truncate(JSON.stringify(data));
    } catch {
      return truncate(String(data));
    }
  }
  if (err instanceof Error) return truncate(err.message);
  return truncate(String(err));
}

function mergeVias(vias: Array<GrantCloudDocFolderPermissionResult['via'] | undefined>): GrantCloudDocFolderPermissionResult['via'] {
  const set = new Set(vias.filter(Boolean));
  if (set.size === 0) return undefined;
  if (set.size === 1) return [...set][0];
  return 'mixed';
}

function memberLabel(member: DriveMemberData): string {
  return `${member.member_type}:${member.member_id.slice(-8)}`;
}

function topicCloudDocFolderName(title: string, requesterName?: string): string {
  const cleanTitle = sanitizeFolderName(title) || '新任务';
  const cleanRequester = sanitizeFolderName(requesterName ?? '');
  const suffix = cleanRequester ? ` - ${cleanRequester}` : '';
  return `${cleanTitle}${suffix}`.slice(0, TOPIC_FOLDER_NAME_MAX).trim();
}

function sanitizeFolderName(value: string): string {
  return value
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS)}…` : clean;
}
