import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { addProject, getProjectByChatId, getProjectByName, type Project } from './registry';
import { setAnnouncement } from './announcement';
import { onboardGroup } from './onboarding';

export interface CreateProjectInput {
  name: string;
  /** DM sender open_id — invited to the new group + set as a member. */
  ownerOpenId: string;
  /** when set, bind this existing folder; otherwise create a blank project. */
  existingPath?: string;
  /** session model for the group (default 'multi'). */
  kind?: 'multi' | 'single';
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
  /** session model for the group (default 'multi'). */
  kind?: 'multi' | 'single';
}

/**
 * Resolve the working directory for a project: an explicit `existingPath` (must
 * exist) binds a folder you already have; otherwise a blank project dir is
 * created under {@link paths.projectsRootDir}. Throws before any group is
 * touched so a bad path never leaves an orphan group.
 */
async function resolveCwd(name: string, existingPath?: string): Promise<{ cwd: string; blank: boolean }> {
  if (existingPath) {
    const cwd = isAbsolute(existingPath) ? existingPath : resolve(existingPath);
    if (!existsSync(cwd)) throw new Error(`文件夹不存在：${cwd}`);
    return { cwd, blank: false };
  }
  const cwd = join(paths.projectsRootDir, name);
  await mkdir(cwd, { recursive: true });
  return { cwd, blank: true };
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
  const { cwd, blank } = await resolveCwd(name, input.existingPath);

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
  const project: Project = { name, chatId, cwd, blank, createdAt: Date.now(), kind: input.kind ?? 'multi', origin: 'created' };
  await addProject(project);
  log.info('project', 'create', { name, chatId, cwd, blank });

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

  const { cwd, blank } = await resolveCwd(name, input.existingPath);

  const project: Project = {
    name,
    chatId: input.chatId,
    cwd,
    blank,
    createdAt: Date.now(),
    kind: input.kind ?? 'multi',
    origin: 'joined',
    addedBy: input.addedBy,
  };
  await addProject(project);
  log.info('project', 'join', { name, chatId: input.chatId, cwd, blank, kind: project.kind });

  // Onboarding only (no announcement / Pin / tab — see onboardGroup's joined
  // branch); best-effort, the binding holds even if the welcome card fails.
  await onboardGroup(channel, project).catch((err) => log.fail('project', err, { phase: 'onboard-join' }));
  return project;
}
