import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Project, TopicWorkspaceMode } from './registry';

export function defaultTopicWorkspaceMode(
  project: Pick<Project, 'kind' | 'topicWorkspace'> | undefined,
): TopicWorkspaceMode {
  if (!project) return 'shared';
  if ((project.kind ?? 'multi') === 'single') return 'shared';
  return project.topicWorkspace ?? 'isolated';
}

export function isIsolatedTopicWorkspace(project: Pick<Project, 'kind' | 'topicWorkspace'> | undefined): boolean {
  return defaultTopicWorkspaceMode(project) === 'isolated';
}

export function safeTopicWorkspaceName(topicKey: string): string {
  const cleaned = topicKey
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  return cleaned || 'topic';
}

export function topicWorkspaceRoot(project: Pick<Project, 'cwd'>): string {
  return join(resolve(project.cwd), '.feishu-codex', 'topics');
}

export function topicWorkspacePath(project: Pick<Project, 'cwd'>, topicKey: string): string {
  return join(topicWorkspaceRoot(project), safeTopicWorkspaceName(topicKey));
}

export async function prepareSessionCwd(
  project: Project | undefined,
  sessionKey: string,
  fallbackCwd: string,
  opts: { flat?: boolean } = {},
): Promise<string> {
  const projectCwd = resolve(project?.cwd ?? fallbackCwd);
  if (!project || opts.flat || !isIsolatedTopicWorkspace(project)) return projectCwd;
  const cwd = topicWorkspacePath(project, sessionKey);
  await mkdir(cwd, { recursive: true });
  return cwd;
}
