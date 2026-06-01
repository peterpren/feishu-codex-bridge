import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getServiceAdapter } from './adapter';
import { statusLaunchd } from './launchd';

const execFileP = promisify(execFile);

// On Windows the npm shim is npm.cmd, not an exec'able `npm`. The bridge service
// is darwin-only today, but the `update` CLI runs everywhere — keep it portable.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * The installed package's own root. After bundling, every source module's
 * `import.meta.url` resolves to dist/cli.js, so its parent is the package root —
 * the same layout in a global install (.../node_modules/<pkg>/) and a local
 * checkout. We read package.json from here for both the current version and the
 * canonical package name (so a rename can't drift the npm target).
 */
function pkgRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function pkgJson(): { name?: string; version?: string } {
  try {
    return JSON.parse(readFileSync(join(pkgRoot(), 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
    };
  } catch {
    return {};
  }
}

export function currentVersion(): string {
  return pkgJson().version ?? '0.0.0';
}

export function packageName(): string {
  return pkgJson().name ?? '@modelzen/feishu-codex-bridge';
}

/**
 * Running from a git checkout (the repo root has a .git) rather than an npm
 * install. `npm i -g` would not update that working copy, so callers should
 * steer the user to `git pull && npm i` instead.
 */
export function isDevSource(): boolean {
  return existsSync(join(pkgRoot(), '.git'));
}

/** semver-ish compare: is `a` strictly newer than `b`? (major.minor.patch) */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** Latest published version on the configured registry, or null if unreachable. */
export async function latestVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileP(NPM, ['view', packageName(), 'version'], { timeout: 20000 });
    const v = stdout.trim();
    return /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  dev: boolean;
}

export async function checkUpdate(): Promise<UpdateCheck> {
  const current = currentVersion();
  const latest = await latestVersion();
  return { current, latest, hasUpdate: !!latest && isNewer(latest, current), dev: isDevSource() };
}

export interface InstallResult {
  ok: boolean;
  /** tail of npm's combined output (capture mode) or a short status line */
  message: string;
}

/**
 * Run `npm install -g <pkg>@latest`. Async (spawn, never spawnSync) so card
 * callbacks can call it without freezing the bridge's event loop. With
 * `inherit`, npm's progress streams straight to the terminal (CLI use); without
 * it, output is captured and the tail returned for surfacing in a card.
 */
export async function installLatest(opts: { inherit?: boolean } = {}): Promise<InstallResult> {
  const target = `${packageName()}@latest`;
  return await new Promise<InstallResult>((resolveP) => {
    const child = spawn(NPM, ['install', '-g', target], {
      stdio: opts.inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    if (!opts.inherit) {
      child.stdout?.on('data', (d) => (out += d));
      child.stderr?.on('data', (d) => (out += d));
    }
    child.on('error', (e) => resolveP({ ok: false, message: e.message }));
    child.on('close', (code) => {
      const tail = out.trim().slice(-600);
      resolveP({ ok: code === 0, message: opts.inherit ? `退出码 ${code}` : tail || `退出码 ${code}` });
    });
  });
}

/** Is the launchd background service currently loaded? (false off darwin.) */
export function daemonRunning(): boolean {
  try {
    return statusLaunchd().loaded;
  } catch {
    return false;
  }
}

/**
 * Restart the background daemon so it reloads the freshly-installed code. When
 * invoked from a card handler the running process *is* that daemon, so this kill
 * terminates the caller — send any "done" UI before calling it.
 */
export async function restartDaemon(): Promise<void> {
  await getServiceAdapter().restart();
}
