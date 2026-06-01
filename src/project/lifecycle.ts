import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { addProject, getProjectByName, type Project } from './registry';
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
  let cwd: string;
  let blank: boolean;
  if (input.existingPath) {
    cwd = isAbsolute(input.existingPath) ? input.existingPath : resolve(input.existingPath);
    if (!existsSync(cwd)) throw new Error(`文件夹不存在：${cwd}`);
    blank = false;
  } else {
    cwd = join(paths.projectsRootDir, name);
    await mkdir(cwd, { recursive: true });
    blank = true;
  }

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
  const project: Project = { name, chatId, cwd, blank, createdAt: Date.now(), kind: input.kind ?? 'multi' };
  await addProject(project);
  log.info('project', 'create', { name, chatId, cwd, blank });

  // 4. group announcement (top banner) + onboarding (welcome card / Pin / tab),
  //    both best-effort — a group is usable even if these fail.
  await setAnnouncement(channel, project).catch((err) => log.fail('project', err, { phase: 'announcement' }));
  await onboardGroup(channel, project).catch((err) => log.fail('project', err, { phase: 'onboard' }));
  return project;
}
