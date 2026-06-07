import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultTopicWorkspaceMode,
  prepareSessionCwd,
  safeTopicWorkspaceName,
  topicWorkspacePath,
} from '../src/project/topic-workspace';
import type { Project } from '../src/project/registry';

const tmpRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fcb-topic-workspace-'));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

function project(cwd: string, patch: Partial<Project> = {}): Project {
  return {
    name: 'p',
    chatId: 'oc_1',
    cwd,
    blank: false,
    createdAt: 1,
    kind: 'multi',
    ...patch,
  };
}

describe('topic workspace routing', () => {
  it('defaults multi-topic projects to isolated workspaces', () => {
    expect(defaultTopicWorkspaceMode(project('/tmp/p'))).toBe('isolated');
    expect(defaultTopicWorkspaceMode(project('/tmp/p', { topicWorkspace: 'shared' }))).toBe('shared');
  });

  it('keeps single-session projects on the shared project cwd', () => {
    expect(defaultTopicWorkspaceMode(project('/tmp/p', { kind: 'single' }))).toBe('shared');
  });

  it('creates a sanitized per-topic cwd under the project directory', async () => {
    const root = await tempRoot();
    const p = project(root);
    const cwd = await prepareSessionCwd(p, 'omt:test/123', '/fallback');

    expect(cwd).toBe(topicWorkspacePath(p, 'omt:test/123'));
    expect(cwd.endsWith(join('.feishu-codex', 'topics', 'omt_test_123'))).toBe(true);
    expect(existsSync(cwd)).toBe(true);
  });

  it('does not create a topic workspace when the project is shared', async () => {
    const root = await tempRoot();
    const p = project(root, { topicWorkspace: 'shared' });

    await expect(prepareSessionCwd(p, 'omt_1', '/fallback')).resolves.toBe(root);
  });

  it('sanitizes empty or unusual topic keys', () => {
    expect(safeTopicWorkspaceName(' / ')).toBe('topic');
    expect(safeTopicWorkspaceName('om_xxx-123.abc')).toBe('om_xxx-123.abc');
  });
});
