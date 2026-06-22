import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { findNearestAgentsFile, seedAgentsFile } from '../src/project/agents-file';

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
});
