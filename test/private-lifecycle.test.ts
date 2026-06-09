import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../src/project/registry';

const addProjectMock = vi.hoisted(() => vi.fn());
const getProjectByNameMock = vi.hoisted(() => vi.fn());

vi.mock('../src/project/registry', () => ({
  addProject: addProjectMock,
  getProjectByChatId: vi.fn(),
  getProjectByName: getProjectByNameMock,
  updateProject: vi.fn(),
}));

vi.mock('../src/project/announcement', () => ({
  setAnnouncement: vi.fn(async () => undefined),
}));

const { createPrivateProject } = await import('../src/project/lifecycle');

describe('createPrivateProject', () => {
  beforeEach(() => {
    addProjectMock.mockClear();
    getProjectByNameMock.mockReset().mockResolvedValue(undefined);
  });

  it('registers private child groups as single-session groups with no-mention disabled', async () => {
    const parent: Project = {
      name: '父项目',
      chatId: 'oc_parent',
      cwd: join(tmpdir(), 'feishu-codex-private-parent'),
      blank: false,
      createdAt: 1,
      kind: 'multi',
      origin: 'created',
      mode: 'write',
      network: false,
    };
    const channel = {
      rawClient: {
        im: {
          v1: {
            chat: { create: vi.fn(async () => ({ data: { chat_id: 'oc_private' } })) },
            chatManagers: { addManagers: vi.fn(async () => ({})) },
            chatMembers: { create: vi.fn(async () => ({})) },
          },
        },
      },
    };

    await createPrivateProject(channel as any, {
      parent,
      title: '私密任务',
      ownerOpenId: 'ou_owner',
      sourceMessageId: 'om_source',
    });

    const registered = addProjectMock.mock.calls[0]?.[0] as Project;
    expect(registered.kind).toBe('single');
    expect(registered.private).toBe(true);
    expect(registered.noMention).toBe(false);
  });
});
