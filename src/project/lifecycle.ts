import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { mkdir } from 'node:fs/promises';
import { log } from '../core/logger';
import {
  DEFAULT_ADMIN_MODE,
  DEFAULT_GUEST_MODE,
  DEFAULT_NETWORK,
  addProject,
  effectiveGuestMode,
  effectiveMode,
  effectiveNetwork,
  getProjectByChatId,
  getProjectByName,
  updateProject,
  type CloudDocFolder,
  type Project,
} from './registry';
import type { PermissionMode } from '../agent/types';
import { grantProjectCloudDocFolderAccess, permissionRecord } from './cloud-doc-permission';
import { setAnnouncement } from './announcement';
import { onboardGroup } from './onboarding';
import { resolveProjectCwd } from './workspace-root';
import { privateProjectName, privateWorkspacePath } from './private-project';

export interface CreateProjectInput {
  name: string;
  /** DM sender open_id — invited to the new group + set as a member. */
  ownerOpenId: string;
  /** when set, bind this existing folder; otherwise create a blank project. */
  existingPath?: string;
  /** Bot-level local root directory; all new/bound projects must live inside it. */
  workspaceRoot?: string;
  /** session model for the group (default 'multi'). */
  kind?: 'multi' | 'single';
  /** permission tier for owner/admins (default 'full'). */
  mode?: PermissionMode;
  /** permission tier for ordinary members (default 'write'). */
  guestMode?: PermissionMode;
  /** allow the sandboxed shell to reach the network (default true). */
  network?: boolean;
  /** default Feishu Drive folder for cloud docs created in this project */
  cloudDocFolder?: CloudDocFolder;
  /** open_ids that should keep full access to the parent cloud-doc folder. */
  adminOpenIds?: string[];
  /** Feishu app_id for granting the bot/app full access to the parent folder. */
  appId?: string;
}

export interface JoinGroupInput {
  /** project name — editable in the bind card, defaults to the group's name. */
  name: string;
  /** the pre-existing group the bot was added to. */
  chatId: string;
  /** open_id of the admin who added the bot + submitted the bind. */
  addedBy: string;
  /** when set, bind this existing folder; otherwise create a blank project. */
  existingPath?: string;
  /** Bot-level local root directory; all new/bound projects must live inside it. */
  workspaceRoot?: string;
  /** session model for the group (default 'multi'). */
  kind?: 'multi' | 'single';
  /** permission tier for owner/admins (default 'full'). */
  mode?: PermissionMode;
  /** permission tier for ordinary members (default 'write'). */
  guestMode?: PermissionMode;
  /** allow the sandboxed shell to reach the network (default true). */
  network?: boolean;
  /** default Feishu Drive folder for cloud docs created in this project */
  cloudDocFolder?: CloudDocFolder;
  /** open_ids that should keep full access to the parent cloud-doc folder. */
  adminOpenIds?: string[];
  /** Feishu app_id for granting the bot/app full access to the parent folder. */
  appId?: string;
}

export interface CreatePrivateProjectInput {
  /** The parent multi-topic project where `/private` was invoked. */
  parent: Project;
  /** Human-readable private task title. */
  title: string;
  /** User who invoked `/private`. Invited and promoted to group admin. */
  ownerOpenId: string;
  /** Extra open_ids explicitly @mentioned in the `/private` command. */
  participantOpenIds?: string[];
  sourceThreadId?: string;
  sourceMessageId: string;
}

/**
 * Create a project: resolve/prepare the cwd, create a bound Feishu group
 * (bot stays owner, creator invited + promoted to admin), register it, and set
 * the group announcement.
 * Throws on duplicate name or missing existing path (before creating a group,
 * so no orphan groups).
 */
export async function createProject(channel: LarkChannel, input: CreateProjectInput): Promise<Project> {
  const name = input.name.trim();
  if (!name) throw new Error('项目名不能为空');
  if (await getProjectByName(name)) throw new Error(`项目名「${name}」已存在，换个名或用 /projects 看已有的`);

  // 1. resolve cwd
  const { cwd, blank } = await resolveProjectCwd({
    name,
    existingPath: input.existingPath,
    workspaceRoot: input.workspaceRoot,
  });

  // 2. create the bound group — bot stays as owner (no owner_id passed); the
  //    creator is invited as a member here, then promoted to admin in 2b so the
  //    two share every day-to-day permission. The owner (bot) keeps only
  //    disband / transfer / manage-admins to itself — those can't be shared
  //    because Feishu allows exactly one owner.
  const res = await channel.rawClient.im.v1.chat.create({
    params: { user_id_type: 'open_id' },
    data: { name, user_id_list: [input.ownerOpenId] },
  });
  const chatId = (res.data as { chat_id?: string } | undefined)?.chat_id;
  if (!chatId) throw new Error(`建群失败：${JSON.stringify(res).slice(0, 200)}`);

  // 2b. promote the creator to group admin. Only the owner (our bot) may do
  //     this; best-effort — the group is usable even if it fails.
  await channel.rawClient.im.v1.chatManagers
    .addManagers({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id' },
      data: { manager_ids: [input.ownerOpenId] },
    })
    .catch((err) => log.fail('project', err, { phase: 'add-manager' }));

  // 3. register
  const project: Project = {
    name,
    chatId,
    cwd,
    blank,
    createdAt: Date.now(),
    kind: input.kind ?? 'multi',
    origin: 'created',
    mode: input.mode ?? DEFAULT_ADMIN_MODE,
    guestMode: input.guestMode ?? DEFAULT_GUEST_MODE,
    network: input.network ?? DEFAULT_NETWORK,
    ...(input.cloudDocFolder ? { cloudDocFolder: input.cloudDocFolder } : {}),
  };
  await addProject(project);
  log.info('project', 'create', { name, chatId, cwd, blank, mode: project.mode });
  await grantCloudDocFolderIfConfigured(channel, project, {
    adminOpenIds: input.adminOpenIds ?? [input.ownerOpenId],
    appId: input.appId,
  });

  // 4. group announcement (top banner) + onboarding (welcome card / Pin / tab),
  //    both best-effort — a group is usable even if these fail.
  await setAnnouncement(channel, project).catch((err) => log.fail('project', err, { phase: 'announcement' }));
  await onboardGroup(channel, project).catch((err) => log.fail('project', err, { phase: 'onboard' }));
  return project;
}

/**
 * Bind a *pre-existing* group (the bot was just added to it by a human) as a
 * `joined` project. Unlike {@link createProject}: no group is created, no
 * announcement is written, no admin is promoted and ownership is never touched —
 * the bot stays a plain member. Onboarding only posts a (non-pinned) welcome
 * card. Throws on duplicate name (the name is editable in the bind card, so the
 * user can pick another) or if this chat is already bound — before resolving the
 * cwd, so nothing partial is left behind.
 */
export async function joinExistingGroup(channel: LarkChannel, input: JoinGroupInput): Promise<Project> {
  const name = input.name.trim();
  if (!name) throw new Error('项目名不能为空');
  if (await getProjectByName(name)) throw new Error(`项目名「${name}」已存在，换个名或用 /projects 看已有的`);
  const bound = await getProjectByChatId(input.chatId);
  if (bound) throw new Error(`该群已绑定为项目「${bound.name}」`);

  const { cwd, blank } = await resolveProjectCwd({
    name,
    existingPath: input.existingPath,
    workspaceRoot: input.workspaceRoot,
  });

  const project: Project = {
    name,
    chatId: input.chatId,
    cwd,
    blank,
    createdAt: Date.now(),
    kind: input.kind ?? 'multi',
    origin: 'joined',
    addedBy: input.addedBy,
    mode: input.mode ?? DEFAULT_ADMIN_MODE,
    guestMode: input.guestMode ?? DEFAULT_GUEST_MODE,
    network: input.network ?? DEFAULT_NETWORK,
    ...(input.cloudDocFolder ? { cloudDocFolder: input.cloudDocFolder } : {}),
  };
  await addProject(project);
  log.info('project', 'join', { name, chatId: input.chatId, cwd, blank, kind: project.kind, mode: project.mode });
  await grantCloudDocFolderIfConfigured(channel, project, {
    adminOpenIds: input.adminOpenIds ?? [input.addedBy],
    appId: input.appId,
  });

  // Onboarding only (no announcement / Pin / tab — see onboardGroup's joined
  // branch); best-effort, the binding holds even if the welcome card fails.
  await onboardGroup(channel, project).catch((err) => log.fail('project', err, { phase: 'onboard-join' }));
  return project;
}

/**
 * Create a private single-session child group for a parent project. It is
 * registered like a normal project so diagnostics, sessions and permission
 * boundaries stay inspectable, but it does not grant the parent cloud folder to
 * the group. Cloud docs/files use lazy per-session child folders instead.
 */
export async function createPrivateProject(channel: LarkChannel, input: CreatePrivateProjectInput): Promise<Project> {
  const sourceId = input.sourceThreadId ?? input.sourceMessageId;
  const name = await uniquePrivateName(input.parent, input.title, sourceId);
  const extraOpenIds = [...new Set((input.participantOpenIds ?? []).filter((id) => id && id !== input.ownerOpenId))];
  const cwd = privateWorkspacePath(input.parent, sourceId);
  await mkdir(cwd, { recursive: true });

  const res = await channel.rawClient.im.v1.chat.create({
    params: { user_id_type: 'open_id' },
    data: { name, user_id_list: [input.ownerOpenId] },
  });
  const chatId = (res.data as { chat_id?: string } | undefined)?.chat_id;
  if (!chatId) throw new Error(`创建私密群失败：${JSON.stringify(res).slice(0, 200)}`);

  await channel.rawClient.im.v1.chatManagers
    .addManagers({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id' },
      data: { manager_ids: [input.ownerOpenId] },
    })
    .catch((err) => log.fail('project', err, { phase: 'private-add-manager' }));

  const addedOpenIds = [input.ownerOpenId];
  const participantAddFailures: NonNullable<Project['participantAddFailures']> = [];
  for (const openId of extraOpenIds) {
    const added = await addPrivateChatMember(channel, chatId, openId);
    if (added.ok) {
      addedOpenIds.push(openId);
    } else {
      participantAddFailures.push({ openId, error: added.error, attemptedAt: Date.now() });
      log.fail('project', new Error(added.error), { phase: 'private-add-member', openId: openId.slice(-6) });
    }
  }

  const project: Project = {
    name,
    chatId,
    cwd,
    blank: true,
    createdAt: Date.now(),
    kind: 'single',
    noMention: false,
    origin: 'created',
    mode: effectiveMode(input.parent),
    guestMode: effectiveGuestMode(input.parent),
    network: effectiveNetwork(input.parent),
    cloudDocFolder: input.parent.cloudDocFolder,
    ...(input.parent.mcpServers?.length ? { mcpServers: input.parent.mcpServers.map((server) => ({ ...server })) } : {}),
    private: true,
    parentChatId: input.parent.chatId,
    parentProjectName: input.parent.name,
    sourceThreadId: input.sourceThreadId,
    sourceMessageId: input.sourceMessageId,
    participants: addedOpenIds,
    ...(participantAddFailures.length ? { participantAddFailures } : {}),
  };
  await addProject(project);
  log.info('project', 'private-create', {
    name,
    chatId,
    parent: input.parent.name,
    participants: addedOpenIds.length,
    addFailures: participantAddFailures.length,
    cwd,
  });

  await setAnnouncement(channel, project).catch((err) => log.fail('project', err, { phase: 'private-announcement' }));
  return project;
}

async function addPrivateChatMember(
  channel: LarkChannel,
  chatId: string,
  openId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await channel.rawClient.im.v1.chatMembers.create({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id' },
      data: { id_list: [openId] },
    });
    const data = res.data;
    const failed = data?.invalid_id_list?.includes(openId) || data?.not_existed_id_list?.includes(openId) || data?.pending_approval_id_list?.includes(openId);
    if (failed) return { ok: false, error: `飞书未能加入该成员：${JSON.stringify(data).slice(0, 180)}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

function errorText(err: unknown): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data) {
    const obj = data as { code?: unknown; msg?: unknown };
    if (obj.code || obj.msg) return truncateError(`${obj.code ?? ''} ${obj.msg ?? ''}`.trim());
    try {
      return truncateError(JSON.stringify(data));
    } catch {
      return truncateError(String(data));
    }
  }
  if (err instanceof Error) return truncateError(err.message);
  return truncateError(String(err));
}

function truncateError(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > 220 ? `${clean.slice(0, 220)}…` : clean;
}

async function uniquePrivateName(parent: Project, title: string, sourceId: string): Promise<string> {
  const base = privateProjectName(parent, title, sourceId);
  if (!(await getProjectByName(base))) return base;
  for (let i = 2; i <= 20; i++) {
    const next = `${base}-${i}`;
    if (!(await getProjectByName(next))) return next;
  }
  throw new Error(`私密项目名「${base}」已存在，请稍后重试`);
}

async function grantCloudDocFolderIfConfigured(
  channel: LarkChannel,
  project: Project,
  access: { adminOpenIds: string[]; appId?: string },
): Promise<void> {
  if (!project.cloudDocFolder?.token) return;
  const result = await grantProjectCloudDocFolderAccess(channel, project.cloudDocFolder, {
    ...access,
    chatId: project.chatId,
  });
  project.cloudDocFolder = { ...project.cloudDocFolder, permission: permissionRecord(result) };
  await updateProject(project.name, { cloudDocFolder: project.cloudDocFolder });
  if (result.status === 'granted') {
    log.info('project', 'cloud-doc-folder-access', { name: project.name, via: result.via ?? '-' });
  } else {
    log.fail('project', new Error(result.error ?? 'grant failed'), { phase: 'cloud-doc-folder-access', name: project.name });
  }
}
