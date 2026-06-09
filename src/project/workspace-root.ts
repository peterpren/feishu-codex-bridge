import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export interface ResolvedProjectCwd {
  cwd: string;
  blank: boolean;
}

export function localWorkspaceRootLabel(root?: string): string {
  return root?.trim() ? `\`${root.trim()}\`` : '未配置';
}

export function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel));
}

export async function normalizeWorkspaceRoot(input: string): Promise<string> {
  const raw = input.trim();
  if (!raw) throw new Error('本地工作根目录不能为空');
  if (!isAbsolute(raw)) throw new Error('本地工作根目录必须填写绝对路径');
  const abs = resolve(raw);
  await mkdir(abs, { recursive: true });
  const realRoot = await realpath(abs);
  const s = await stat(realRoot);
  if (!s.isDirectory()) throw new Error(`本地工作根目录不是文件夹：${realRoot}`);
  return realRoot;
}

export async function resolveProjectCwd(input: {
  name: string;
  existingPath?: string;
  workspaceRoot?: string;
}): Promise<ResolvedProjectCwd> {
  const workspaceRoot = input.workspaceRoot?.trim();
  if (!workspaceRoot) throw new Error('请先在 Bot 设置里配置本地工作根目录');

  const root = await normalizeWorkspaceRoot(workspaceRoot);

  if (input.existingPath?.trim()) {
    const raw = input.existingPath.trim();
    if (!isAbsolute(raw)) throw new Error('本地文件夹路径必须填写绝对路径');
    const cwd = resolve(raw);
    let realCwd: string;
    try {
      realCwd = await realpath(cwd);
    } catch {
      throw new Error(`文件夹不存在：${cwd}`);
    }
    const s = await stat(realCwd);
    if (!s.isDirectory()) throw new Error(`本地文件夹路径不是文件夹：${realCwd}`);
    if (!isPathInside(root, realCwd)) {
      throw new Error(`本地文件夹必须在 Bot 工作根目录内：${root}`);
    }
    return { cwd: realCwd, blank: false };
  }

  const cwd = resolve(root, input.name);
  if (!isPathInside(root, cwd)) throw new Error(`项目名不能跳出 Bot 工作根目录：${input.name}`);
  await mkdir(cwd, { recursive: true });
  const realCwd = await realpath(cwd);
  if (!isPathInside(root, realCwd)) throw new Error(`项目目录不能跳出 Bot 工作根目录：${root}`);
  return { cwd: realCwd, blank: true };
}
