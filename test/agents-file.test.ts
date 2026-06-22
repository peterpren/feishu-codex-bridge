import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { findNearestAgentsFile, seedAgentsFile } from '../src/project/agents-file';
import { findNearestKnowledgeDir, seedKnowledgePack } from '../src/project/knowledge-pack';

describe('agents-file seeding', () => {
  it('copies the nearest parent AGENTS.md into a new project cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-agents-'));
    const botRoot = join(root, 'bot');
    const projectsRoot = join(botRoot, 'projects');
    const cwd = join(projectsRoot, 'project-a');
    await mkdir(projectsRoot, { recursive: true });
    await writeFile(join(botRoot, 'AGENTS.md'), 'bot rules\n', 'utf8');

    await expect(seedAgentsFile(cwd, projectsRoot)).resolves.toBe(true);
    await expect(readFile(join(cwd, 'AGENTS.md'), 'utf8')).resolves.toBe('bot rules\n');
  });

  it('does not overwrite an existing project AGENTS.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-agents-'));
    const botRoot = join(root, 'bot');
    const cwd = join(botRoot, 'projects', 'project-a');
    await mkdir(join(botRoot, 'projects'), { recursive: true });
    await writeFile(join(botRoot, 'AGENTS.md'), 'bot rules\n', 'utf8');
    await seedAgentsFile(cwd, join(botRoot, 'projects'));
    await writeFile(join(cwd, 'AGENTS.md'), 'project rules\n', 'utf8');

    await expect(seedAgentsFile(cwd, join(botRoot, 'projects'))).resolves.toBe(false);
    await expect(readFile(join(cwd, 'AGENTS.md'), 'utf8')).resolves.toBe('project rules\n');
  });

  it('finds the nearest AGENTS.md before higher-level files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-agents-'));
    const botRoot = join(root, 'bot');
    const project = join(botRoot, 'projects', 'project-a');
    await mkdir(project, { recursive: true });
    await writeFile(join(root, 'AGENTS.md'), 'global\n', 'utf8');
    await writeFile(join(botRoot, 'AGENTS.md'), 'bot\n', 'utf8');

    await expect(findNearestAgentsFile(project)).resolves.toBe(join(botRoot, 'AGENTS.md'));
  });

  it('copies a parent knowledge pack into the new workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-knowledge-'));
    const botRoot = join(root, 'bot');
    const projectsRoot = join(botRoot, 'projects');
    const cwd = join(projectsRoot, 'project-a');
    await mkdir(join(botRoot, 'knowledge'), { recursive: true });
    await writeFile(join(botRoot, 'knowledge', 'rules.md'), 'rules\n', 'utf8');
    await writeFile(join(botRoot, 'knowledge', '.secret'), 'secret\n', 'utf8');

    const result = await seedKnowledgePack(cwd, projectsRoot);

    expect(result).toMatchObject({ copiedFiles: 1, skippedFiles: 1, sourceDir: join(botRoot, 'knowledge') });
    await expect(readFile(join(cwd, 'knowledge', 'rules.md'), 'utf8')).resolves.toBe('rules\n');
    await expect(findNearestKnowledgeDir(projectsRoot)).resolves.toBe(join(botRoot, 'knowledge'));
  });
});
