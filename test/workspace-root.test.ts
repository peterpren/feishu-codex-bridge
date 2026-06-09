import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeWorkspaceRoot, resolveProjectCwd } from '../src/project/workspace-root';

const cleanup: string[] = [];

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('bot workspace root', () => {
  it('normalizes and creates an absolute root directory', async () => {
    const base = await temp('bridge-root-');
    const root = join(base, 'finance');

    await expect(normalizeWorkspaceRoot(root)).resolves.toBe(await realpath(root));
  });

  it('requires a configured workspace root before resolving project cwd', async () => {
    await expect(resolveProjectCwd({ name: 'demo' })).rejects.toThrow('请先在 Bot 设置里配置本地工作根目录');
  });

  it('creates blank projects under the configured root', async () => {
    const root = await temp('bridge-root-');

    const result = await resolveProjectCwd({ name: 'demo', workspaceRoot: root });

    expect(result).toEqual({ cwd: await realpath(join(root, 'demo')), blank: true });
  });

  it('accepts existing folders inside the configured root', async () => {
    const root = await temp('bridge-root-');
    const existing = join(root, 'existing');
    await mkdir(existing);

    const result = await resolveProjectCwd({ name: 'ignored', existingPath: existing, workspaceRoot: root });

    expect(result).toEqual({ cwd: await realpath(existing), blank: false });
  });

  it('rejects existing folders outside the configured root', async () => {
    const root = await temp('bridge-root-');
    const outside = await temp('bridge-outside-');

    await expect(resolveProjectCwd({ name: 'demo', existingPath: outside, workspaceRoot: root })).rejects.toThrow(
      '本地文件夹必须在 Bot 工作根目录内',
    );
  });

  it('rejects symlinks that point outside the configured root', async () => {
    const root = await temp('bridge-root-');
    const outside = await temp('bridge-outside-');
    const link = join(root, 'linked-outside');
    await symlink(outside, link);

    await expect(resolveProjectCwd({ name: 'demo', existingPath: link, workspaceRoot: root })).rejects.toThrow(
      '本地文件夹必须在 Bot 工作根目录内',
    );
  });

  it('rejects blank project names that escape the configured root', async () => {
    const root = await temp('bridge-root-');

    await expect(resolveProjectCwd({ name: '../escape', workspaceRoot: root })).rejects.toThrow(
      '项目名不能跳出 Bot 工作根目录',
    );
  });
});
