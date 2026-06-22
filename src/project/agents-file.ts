import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const AGENTS_FILE = 'AGENTS.md';
const MAX_PARENT_LOOKUP = 12;

export async function seedAgentsFile(cwd: string, sourceDir: string | undefined): Promise<boolean> {
  if (!sourceDir?.trim()) return false;
  const targetDir = resolve(cwd);
  const dest = join(targetDir, AGENTS_FILE);
  if (await exists(dest)) return false;

  const source = await findNearestAgentsFile(sourceDir);
  if (!source || resolve(source) === resolve(dest)) return false;

  await mkdir(targetDir, { recursive: true });
  await copyFile(source, dest);
  return true;
}

export async function findNearestAgentsFile(startDir: string): Promise<string | undefined> {
  let dir = resolve(startDir);
  for (let i = 0; i < MAX_PARENT_LOOKUP; i++) {
    const candidate = join(dir, AGENTS_FILE);
    if (await exists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
