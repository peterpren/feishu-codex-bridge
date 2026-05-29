import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { paths, botDir } from './paths';
import { loadConfig } from './store';
import { isComplete, type TenantBrand } from './schema';

/** One saved bot. Credentials' secret lives in the keystore (key `app-<appId>`). */
export interface BotEntry {
  /** short human handle for `use <name>` — unique within the registry */
  name: string;
  appId: string;
  tenant: TenantBrand;
  /** bot display name from credential validation (best-effort, for `bots` list) */
  botName?: string;
  createdAt: number;
}

export interface BotsRegistry {
  version: 1;
  /** appId of the bot `start` / the service will run. */
  current?: string;
  bots: BotEntry[];
}

const EMPTY: BotsRegistry = { version: 1, bots: [] };

export async function loadBots(): Promise<BotsRegistry> {
  try {
    const text = await readFile(paths.botsFile, 'utf8');
    const reg = JSON.parse(text) as BotsRegistry;
    return { version: 1, current: reg.current, bots: Array.isArray(reg.bots) ? reg.bots : [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    throw err;
  }
}

export async function saveBots(reg: BotsRegistry): Promise<void> {
  await mkdir(dirname(paths.botsFile), { recursive: true });
  const tmp = `${paths.botsFile}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(reg, null, 2)}\n`, 'utf8');
  await chmod(tmp, 0o600);
  await rename(tmp, paths.botsFile);
}

/**
 * Return the registry, migrating a legacy single-bot install on first run: if
 * there's no bots.json yet but a complete flat `~/.feishu-codex-bridge/config.json`
 * exists, move its config/projects/sessions/processes into `bots/<appId>/` and
 * register it as `default` (current). Idempotent — a no-op once bots.json exists.
 */
export async function ensureRegistry(): Promise<BotsRegistry> {
  if (existsSync(paths.botsFile)) return loadBots();

  // No registry yet. Read the legacy flat config explicitly (don't rely on the
  // current useBotDir() state) and migrate it if it's a complete bot.
  const flatConfigPath = join(paths.appDir, 'config.json');
  const flat = await loadConfig(flatConfigPath);
  if (!isComplete(flat)) return { ...EMPTY };

  const { id: appId, tenant } = flat.accounts.app;
  const dest = botDir(appId);
  await mkdir(dest, { recursive: true });
  for (const file of ['config.json', 'projects.json', 'sessions.json', 'processes.json']) {
    await moveIfExists(join(paths.appDir, file), join(dest, file));
  }

  const reg: BotsRegistry = {
    version: 1,
    current: appId,
    bots: [{ name: 'default', appId, tenant, createdAt: nowMs() }],
  };
  await saveBots(reg);
  return reg;
}

export function findBot(reg: BotsRegistry, nameOrAppId: string): BotEntry | undefined {
  return reg.bots.find((b) => b.name === nameOrAppId || b.appId === nameOrAppId);
}

export function currentBot(reg: BotsRegistry): BotEntry | undefined {
  return reg.current ? reg.bots.find((b) => b.appId === reg.current) : undefined;
}

/** Add (or replace by appId) a bot; first bot added becomes current. */
export async function addBot(entry: BotEntry): Promise<BotsRegistry> {
  const reg = await loadBots();
  reg.bots = reg.bots.filter((b) => b.appId !== entry.appId);
  reg.bots.push(entry);
  if (!reg.current) reg.current = entry.appId;
  await saveBots(reg);
  return reg;
}

export async function setCurrent(appId: string): Promise<void> {
  const reg = await loadBots();
  reg.current = appId;
  await saveBots(reg);
}

/** Remove a bot from the registry; if it was current, fall back to the first remaining. */
export async function removeBot(appId: string): Promise<BotsRegistry> {
  const reg = await loadBots();
  reg.bots = reg.bots.filter((b) => b.appId !== appId);
  if (reg.current === appId) reg.current = reg.bots[0]?.appId;
  await saveBots(reg);
  return reg;
}

/** A registry-unique short name derived from `desired` (slugified, suffixed on clash). */
export function uniqueName(reg: BotsRegistry, desired: string): string {
  const base = slugify(desired) || 'bot';
  if (!reg.bots.some((b) => b.name === base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!reg.bots.some((b) => b.name === candidate)) return candidate;
  }
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function nowMs(): number {
  return Date.now();
}

async function moveIfExists(src: string, dest: string): Promise<void> {
  if (!existsSync(src)) return;
  await rename(src, dest);
}
