import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnProcess } from '../platform/spawn';
import { getServiceAdapter, isServiceRunning } from './adapter';

// `npm` via cross-spawn: on Windows it's an `npm.cmd` shim that a bare
// spawn/execFile would reject with EINVAL (CVE-2024-27980); cross-spawn runs it,
// and spawnProcess hides the console window (important when the background
// service triggers a one-click update with no console of its own).
const NPM = 'npm';
const DEFAULT_UPDATE_TARGET = 'peterpren-feishu-codex-bridge';
const VERSION_LOOKUP_TIMEOUT_MS = 60_000;

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
  return pkgJson().name ?? 'peterpren-feishu-codex-bridge';
}

export function installTarget(): string {
  return process.env.FEISHU_CODEX_BRIDGE_UPDATE_TARGET?.trim() || DEFAULT_UPDATE_TARGET;
}

export function updateSourceLabel(): string {
  const target = installTarget();
  if (target.startsWith('github:')) return `GitHub ${target.slice('github:'.length)}`;
  if (target.startsWith('git+https://github.com/')) {
    return `GitHub ${target.replace(/^git\+https:\/\/github\.com\//, '').replace(/\.git$/, '')}`;
  }
  return `npm ${target}`;
}

export function manualInstallCommand(): string {
  return `npm i -g ${installTarget()}`;
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

/** Latest package version on the configured update source, or null if unreachable. */
export async function latestVersion(): Promise<string | null> {
  const v = await new Promise<string | null>((resolveP) => {
    const child = spawnProcess(NPM, ['view', installTarget(), 'version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolveP(null);
    }, VERSION_LOOKUP_TIMEOUT_MS);
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolveP(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP(code === 0 ? out.trim() : null);
    });
  });
  return v && /^\d+\.\d+\.\d+/.test(v) ? v : null;
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  dev: boolean;
  source: string;
  installCommand: string;
}

export async function checkUpdate(): Promise<UpdateCheck> {
  const current = currentVersion();
  const latest = await latestVersion();
  return {
    current,
    latest,
    hasUpdate: !!latest && isNewer(latest, current),
    dev: isDevSource(),
    source: updateSourceLabel(),
    installCommand: manualInstallCommand(),
  };
}

export interface InstallResult {
  ok: boolean;
  /** tail of npm's combined output (capture mode) or a short status line */
  message: string;
}

/**
 * Run `npm install -g <configured source>`. Async (spawn, never spawnSync) so card
 * callbacks can call it without freezing the bridge's event loop. With
 * `inherit`, npm's progress streams straight to the terminal (CLI use); without
 * it, output is captured and the tail returned for surfacing in a card.
 */
export async function installLatest(opts: { inherit?: boolean } = {}): Promise<InstallResult> {
  const target = installTarget();
  return await new Promise<InstallResult>((resolveP) => {
    const child = spawnProcess(NPM, ['install', '-g', target], {
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

/**
 * Is the OS background service currently running? Platform-aware (launchd on
 * macOS, Task Scheduler on Windows); false on platforms without a service.
 */
export function daemonRunning(): boolean {
  return isServiceRunning();
}

/**
 * Restart the background daemon so it reloads the freshly-installed code. When
 * invoked from a card handler the running process *is* that daemon, so this kill
 * terminates the caller — send any "done" UI before calling it.
 */
export async function restartDaemon(): Promise<void> {
  await getServiceAdapter().restart();
}
