import type { ChildProcess, SpawnOptions, SpawnSyncOptions } from 'node:child_process';
import crossSpawn from 'cross-spawn';

/**
 * Cross-platform process spawn. **Use this instead of `node:child_process`
 * spawn/execFile for launching CLI binaries** (codex, lark-cli, …).
 *
 * On Windows an npm-installed bin is a `.cmd`/`.ps1` shim, and modern Node
 * (≥18.20 / 20.12) refuses to `spawn()` a `.cmd` directly — it throws `EINVAL`
 * (CVE-2024-27980 mitigation). `cross-spawn` transparently rewrites the call so
 * the shim runs, **without** `shell: true` (which would drag in cmd.exe quoting
 * and injection hazards). On macOS/Linux it's a near-transparent pass-through,
 * so existing POSIX behavior is unchanged.
 */
export function spawnProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  return crossSpawn(command, [...args], options);
}

/** Synchronous counterpart of {@link spawnProcess} (same Windows `.cmd` fix). */
export function spawnProcessSync(
  command: string,
  args: readonly string[] = [],
  options: SpawnSyncOptions = {},
) {
  return crossSpawn.sync(command, [...args], options);
}

/**
 * Merge `overrides` into `base` (defaults to `process.env`) **case-insensitively**.
 * On Windows env keys are case-insensitive (`Path` ≡ `PATH`), so a naive spread
 * can leave two keys that disagree — child processes then read whichever the OS
 * picks. This dedupes by lowercased key, letting the override win.
 */
export function mergeProcessEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete out[existing];
    }
    if (value !== undefined) out[key] = value;
  }
  return out;
}
