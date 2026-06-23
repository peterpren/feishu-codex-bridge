import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { bridgeDeveloperInstructions } from '../src/agent/codex-appserver/backend';
import { textRequestsCloudDocFolder } from '../src/bot/cloud-doc-intent';
import {
  buildCloudDocFolderFormCard,
  buildNewProjectDoneCard,
  buildNewProjectFormCard,
  buildProjectSettingsCard,
} from '../src/card/dm-cards';
import {
  createTopicCloudDocFolder,
  grantProjectCloudDocFolderAccess,
  permissionRecord,
  renameTopicCloudDocFolder,
} from '../src/project/cloud-doc-permission';
import type { Project } from '../src/project/registry';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('../src/platform/spawn', () => ({
  spawnProcess: spawnMock,
}));

const project: Project = {
  name: 'demo',
  chatId: 'oc_x',
  cwd: '/tmp/demo',
  blank: false,
  createdAt: Date.now(),
  kind: 'multi',
  cloudDocFolder: {
    token: 'fldcnABC123',
    url: 'https://example.feishu.cn/drive/folder/fldcnABC123',
    createAs: 'user',
    permission: { status: 'granted', via: 'user', scope: 'project_admins', updatedAt: Date.now() },
  },
};

function fakeSpawn(code: number, stdout = '{}', stderr = ''): any {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
  return child;
}

describe('cloud doc folder cards', () => {
  it('renders the optional folder input in the new-project form', () => {
    const json = JSON.stringify(buildNewProjectFormCard());
    expect(json).toContain('cloud_doc_folder');
    expect(json).toContain('飞书云文档保存文件夹');
    expect(json).toContain('default_model');
    expect(json).toContain('默认模型');
  });

  it('shows and edits the project cloud-doc folder', () => {
    const settings = JSON.stringify(buildProjectSettingsCard(project));
    expect(settings).toContain('fldcnABC123');
    expect(settings).toContain('修改目录');
    expect(settings).toContain('清空目录');
    expect(settings).toContain('权限隔离');
    expect(settings).toContain('已配置管理员/机器人权限');
    expect(settings).toContain('默认配置');
    expect(settings).toContain('推理：中');
    expect(settings).toContain('速度：标准');

    const form = JSON.stringify(buildCloudDocFolderFormCard(project));
    expect(form).toContain('cloud_doc_folder');
    expect(form).toContain('https://example.feishu.cn/drive/folder/fldcnABC123');

    const done = JSON.stringify(buildNewProjectDoneCard(project));
    expect(done).toContain('云文档目录');
    expect(done).toContain('fldcnABC123');
    expect(done).toContain('默认配置');
    expect(done).toContain('推理：中');
    expect(done).toContain('速度：标准');
  });
});

describe('cloud doc folder permissions', () => {
  it('grants parent folder full access to admins/app and does not create group edit permission', async () => {
    const calls: unknown[] = [];
    const channel = {
      rawClient: {
        drive: {
          v1: {
            permissionMember: {
              create: async (payload: unknown) => {
                calls.push(payload);
                return {};
              },
              delete: async (payload: unknown) => {
                calls.push(payload);
                return {};
              },
            },
          },
        },
      },
    } as any;

    const result = await grantProjectCloudDocFolderAccess(channel, project.cloudDocFolder!, {
      adminOpenIds: ['ou_admin'],
      appId: 'cli_app',
      chatId: 'oc_chat',
    });
    expect(result).toEqual({ status: 'granted', via: 'bot', scope: 'project_admins' });
    expect(calls[0]).toMatchObject({
      path: { token: 'fldcnABC123' },
      params: { type: 'folder', need_notification: false },
      data: { member_type: 'appid', member_id: 'cli_app', perm: 'full_access' },
    });
    expect(calls[1]).toMatchObject({
      path: { token: 'fldcnABC123' },
      params: { type: 'folder', need_notification: false },
      data: { member_type: 'openid', member_id: 'ou_admin', perm: 'full_access', type: 'user' },
    });
    expect(calls[2]).toMatchObject({
      path: { token: 'fldcnABC123' },
      params: { type: 'folder', member_type: 'openchat' },
      data: { type: 'chat' },
    });
    expect(JSON.stringify(calls.filter((x: any) => x.data?.member_type === 'openchat'))).toBe('[]');
    expect(permissionRecord(result)).toMatchObject({ status: 'granted', via: 'bot', scope: 'project_admins' });
  });

  it('creates a topic child folder and grants it only to app, admins, and requester', async () => {
    const calls: unknown[] = [];
    const channel = {
      rawClient: {
        drive: {
          v1: {
            file: {
              createFolder: async (payload: unknown) => {
                calls.push(payload);
                return { data: { token: 'fldcnCHILD', url: 'https://example.feishu.cn/drive/folder/fldcnCHILD' } };
              },
            },
            permissionMember: {
              create: async (payload: unknown) => {
                calls.push(payload);
                return {};
              },
            },
          },
        },
      },
    } as any;

    const result = await createTopicCloudDocFolder(channel, project.cloudDocFolder!, {
      title: '修复接口权限',
      requesterOpenId: 'ou_requester',
      requesterName: '张三',
      adminOpenIds: ['ou_admin'],
      appId: 'cli_app',
    });

    expect(result.folder).toMatchObject({
      token: 'fldcnCHILD',
      createAs: 'bot',
      permission: { status: 'granted', scope: 'topic_owner_admins' },
    });
    expect(calls[0]).toMatchObject({ data: { folder_token: 'fldcnABC123' } });
    expect(calls[1]).toMatchObject({ data: { member_type: 'appid', member_id: 'cli_app', perm: 'full_access' } });
    expect(calls[2]).toMatchObject({ data: { member_type: 'openid', member_id: 'ou_admin', perm: 'full_access', type: 'user' } });
    expect(calls[3]).toMatchObject({ data: { member_type: 'openid', member_id: 'ou_requester', perm: 'edit', type: 'user' } });
    expect(JSON.stringify(calls)).not.toContain('openchat');
  });

  it('renames an existing topic child folder through Drive files.patch', async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeSpawn(0));

    const result = await renameTopicCloudDocFolder(
      { token: 'fldcnCHILD', url: 'https://example.feishu.cn/drive/folder/fldcnCHILD', createAs: 'bot' },
      { title: '天气查询', requesterName: '张三' },
    );

    expect(result.folder).toMatchObject({ token: 'fldcnCHILD', createAs: 'bot' });
    expect(spawnMock).toHaveBeenCalledWith(
      'lark-cli',
      expect.arrayContaining([
        'drive',
        'files',
        'patch',
        '--as',
        'bot',
        '--params',
        JSON.stringify({ file_token: 'fldcnCHILD', type: 'folder' }),
        '--data',
        JSON.stringify({ new_title: '天气查询 - 张三' }),
      ]),
      expect.any(Object),
    );
  });
});

describe('bridge developer instructions', () => {
  it('injects the default docs create target when configured', () => {
    const instructions = bridgeDeveloperInstructions({ cloudDocFolder: project.cloudDocFolder });
    expect(instructions).toContain('默认 folder_token：fldcnABC123');
    expect(instructions).toContain('lark-cli docs +create --api-version v2 --as user --parent-token fldcnABC123');
  });

  it('keeps the base instructions clean when no folder is configured', () => {
    const instructions = bridgeDeveloperInstructions();
    expect(instructions).not.toContain('--parent-token');
  });
});

describe('cloud doc folder intent', () => {
  it('does not request a topic folder for normal chat', () => {
    expect(textRequestsCloudDocFolder('你好，帮我查下杭州天气')).toBe(false);
    expect(textRequestsCloudDocFolder('帮我写一个需求说明')).toBe(false);
  });

  it('requests a topic folder when the user explicitly targets Feishu cloud docs', () => {
    expect(textRequestsCloudDocFolder('帮我把这个文件转成飞书文档')).toBe(true);
    expect(textRequestsCloudDocFolder('生成一份云文档并保存')).toBe(true);
    expect(textRequestsCloudDocFolder('upload this to lark docs')).toBe(true);
  });
});
