import { access, copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const KNOWLEDGE_DIR = 'knowledge';
const MAX_PARENT_LOOKUP = 12;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

export interface KnowledgePackSeedResult {
  sourceDir?: string;
  targetDir: string;
  copiedFiles: number;
  skippedFiles: number;
}

export async function seedKnowledgePack(cwd: string, sourceDir: string | undefined): Promise<KnowledgePackSeedResult> {
  const targetDir = join(resolve(cwd), KNOWLEDGE_DIR);
  const source = await findNearestKnowledgeDir(sourceDir);
  if (!source || resolve(source) === resolve(targetDir)) {
    return { sourceDir: source, targetDir, copiedFiles: 0, skippedFiles: 0 };
  }

  await mkdir(targetDir, { recursive: true });
  const counters = { copiedFiles: 0, skippedFiles: 0, totalBytes: 0 };
  await copyKnowledgeTree(source, targetDir, counters);
  return { sourceDir: source, targetDir, copiedFiles: counters.copiedFiles, skippedFiles: counters.skippedFiles };
}

export async function findNearestKnowledgeDir(startDir: string | undefined): Promise<string | undefined> {
  if (!startDir?.trim()) return undefined;
  let dir = resolve(startDir);
  for (let i = 0; i < MAX_PARENT_LOOKUP; i++) {
    const candidate = join(dir, KNOWLEDGE_DIR);
    if (await isDirectory(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

async function copyKnowledgeTree(
  sourceDir: string,
  targetDir: string,
  counters: { copiedFiles: number; skippedFiles: number; totalBytes: number },
): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      counters.skippedFiles++;
      continue;
    }

    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name);
    const rel = relative(sourceDir, source);
    if (rel.startsWith('..')) {
      counters.skippedFiles++;
      continue;
    }

    if (entry.isDirectory()) {
      await mkdir(target, { recursive: true });
      await copyKnowledgeTree(source, target, counters);
      continue;
    }

    if (!entry.isFile()) {
      counters.skippedFiles++;
      continue;
    }

    const info = await stat(source);
    if (info.size > MAX_FILE_BYTES || counters.totalBytes + info.size > MAX_TOTAL_BYTES || counters.copiedFiles >= MAX_FILES) {
      counters.skippedFiles++;
      continue;
    }

    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    counters.copiedFiles++;
    counters.totalBytes += info.size;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function hasKnowledgePack(path: string): Promise<boolean> {
  try {
    await access(join(resolve(path), KNOWLEDGE_DIR));
    return true;
  } catch {
    return false;
  }
}
