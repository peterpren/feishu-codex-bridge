import { describe, expect, it } from 'vitest';
import { bridgeDeveloperInstructions } from '../src/agent/codex-appserver/backend';
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
} from '../src/project/cloud-doc-permission';
import type { Project } from '../src/project/registry';

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

describe('cloud doc folder cards', () => {
  it('renders the optional folder input in the new-project form', () => {
    const json = JSON.stringify(buildNewProjectFormCard());
    expect(json).toContain('cloud_doc_folder');
    expect(json).toContain('飞书云文档保存文件夹');
  });

  it('shows and edits the project cloud-doc folder', () => {
    const settings = JSON.stringify(buildProjectSettingsCard(project));
    expect(settings).toContain('fldcnABC123');
    expect(settings).toContain('修改目录');
    expect(settings).toContain('清空目录');
    expect(settings).toContain('权限隔离');
    expect(settings).toContain('已配置管理员/机器人权限');

    const form = JSON.stringify(buildCloudDocFolderFormCard(project));
    expect(form).toContain('cloud_doc_folder');
    expect(form).toContain('https://example.feishu.cn/drive/folder/fldcnABC123');

    const done = JSON.stringify(buildNewProjectDoneCard(project));
    expect(done).toContain('云文档目录');
    expect(done).toContain('fldcnABC123');
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
