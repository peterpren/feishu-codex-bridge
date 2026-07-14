import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { paths } from '../../config/paths';
import { spawnProcessSync } from '../../platform/spawn';

const IS_WIN = process.platform === 'win32';

/**
 * Resolve the codex CLI binary, in priority order:
 *   1. $CODEX_BIN (explicit override)
 *   2. PATH (`codex`, via `where`/`which`)
 *   3. bridge private install (~/.feishu-codex-bridge/codex-cli/node_modules/.bin/codex)
 *   4. macOS Codex.app / ChatGPT.app bundled binary
 * Returns null if none found.
 *
 * On Windows an npm-installed bin is a `codex.cmd`/`codex.exe` shim, never a
 * bare `codex`, so the private-install probe enumerates PATHEXT variants.
 */
export function resolveCodexBin(): string | null {
  const env = process.env.CODEX_BIN;
  if (env && existsSync(env)) return env;

  const onPath = which('codex');
  if (onPath) return onPath;

  for (const cand of execCandidates(paths.codexCliBinDir, 'codex')) {
    if (existsSync(cand)) return cand;
  }

  if (process.platform === 'darwin') {
    // Current ChatGPT desktop releases bundle the Codex CLI here. Older
    // releases used a separate Codex.app, so probe both without relying on a
    // launchd PATH that may not contain either app bundle.
    for (const appBundle of [
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
    ]) {
      if (existsSync(appBundle)) return appBundle;
    }
  }

  return null;
}

/**
 * Candidate file paths for a bare command in `dir`. On Windows a shim carries a
 * PATHEXT extension (`.cmd`/`.exe`/`.bat`), so probe `codex`, `codex.cmd`,
 * `codex.exe`, … On POSIX the bare name is the only candidate.
 */
function execCandidates(dir: string, base: string): string[] {
  const exact = join(dir, base);
  if (!IS_WIN || extname(base)) return [exact];
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  return [exact, ...exts.map((e) => join(dir, base + e.toLowerCase()))];
}

function which(cmd: string): string | null {
  try {
    // `where` (win) / `which` (posix) are real executables; cross-spawn runs
    // them uniformly. `where` may return multiple lines — take the first.
    const res = spawnProcessSync(IS_WIN ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status !== 0 || typeof res.stdout !== 'string') return null;
    const first = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean);
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

/** Best-effort version string of the resolved codex binary. */
export function codexVersion(bin: string): string | null {
  try {
    // cross-spawn so a Windows `.cmd` shim runs (avoids execFile EINVAL).
    const res = spawnProcessSync(bin, ['--version'], { encoding: 'utf8' });
    if (res.status !== 0 || typeof res.stdout !== 'string') return null;
    return res.stdout.trim();
  } catch {
    return null;
  }
}
