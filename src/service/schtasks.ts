import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../config/paths';
import {
  ensureLogFiles,
  serviceStderrPath,
  serviceStdoutPath,
  type ServiceStatus,
} from './common';

/**
 * Windows background service via Task Scheduler (`schtasks`). Mirrors the
 * launchd adapter: a single user-level task whose body runs `feishu-codex-bridge
 * run`, triggered `ONLOGON` (login autostart). Modeled on the schtasks approach
 * in feishu-claude-code-bridge.
 *
 * Task Scheduler has no crash-restart equivalent to launchd's `KeepAlive`; the
 * `ONLOGON` trigger only re-launches at the next login. That's an accepted gap
 * for the Windows port — `restart` re-runs the task in place.
 */
export const WINDOWS_TASK_NAME = 'feishu-codex-bridge';

/** The `.cmd` wrapper the scheduled task invokes (carries PATH + log redirect). */
function launcherCmdPath(): string {
  return join(paths.appDir, 'service-launcher.cmd');
}

/** Absolute path to the installed bin entry (same resolution as launchd). */
function resolveCliBinPath(): string {
  const distDir = dirname(fileURLToPath(import.meta.url));
  return resolve(distDir, '..', 'bin', 'feishu-codex-bridge.mjs');
}

/**
 * Build the launcher `.cmd`. schtasks `/TR` can take a command directly, but we
 * need (a) stdout/stderr redirection and (b) a PATH override so child tools
 * (codex, lark-cli) resolve under the minimal Task Scheduler environment — a
 * `.cmd` is the natural home for both. `@echo off` keeps the wrapper's own lines
 * out of the log; `>>`/`2>>` append so history survives restarts. CRLF endings
 * because cmd.exe is the interpreter.
 */
export function buildLauncherCmd(): string {
  const nodePath = process.execPath;
  const cliBinPath = resolveCliBinPath();
  const pathEnv = process.env.PATH ?? '';
  return [
    '@echo off',
    `set "PATH=${pathEnv}"`,
    `"${nodePath}" "${cliBinPath}" run >> "${serviceStdoutPath()}" 2>> "${serviceStderrPath()}"`,
    '',
  ].join('\r\n');
}

interface SchtasksResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

function runSchtasks(args: string[]): SchtasksResult {
  // schtasks.exe is a real binary (not a .cmd shim), so node spawnSync is fine.
  const r = spawnSync('schtasks', args, { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

function schtasksError(command: string, r: SchtasksResult): Error {
  const out = [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join('\n');
  return new Error(`${command} 失败（exit ${r.status ?? 'unknown'}）${out ? `：${out}` : ''}`);
}

async function writeLauncherCmd(): Promise<void> {
  const cmdPath = launcherCmdPath();
  await mkdir(dirname(cmdPath), { recursive: true });
  await ensureLogFiles();
  await writeFile(cmdPath, buildLauncherCmd(), 'utf8');
}

/**
 * Install (or overwrite) the scheduled task and start it now. `/SC ONLOGON`
 * gives login autostart; `/RL LIMITED` runs as the current user without admin
 * elevation; `/F` overwrites an existing task. The `ONLOGON` trigger won't fire
 * until the next login, so we `/Run` to start immediately (parity with launchd's
 * `RunAtLoad`).
 */
export async function installSchtask(): Promise<ServiceStatus> {
  await writeLauncherCmd();

  const create = runSchtasks([
    '/Create',
    '/F',
    '/SC',
    'ONLOGON',
    '/RL',
    'LIMITED',
    '/TN',
    WINDOWS_TASK_NAME,
    '/TR',
    `"${launcherCmdPath()}"`,
  ]);
  if (!create.ok) throw schtasksError('schtasks /Create', create);

  const run = runSchtasks(['/Run', '/TN', WINDOWS_TASK_NAME]);
  if (!run.ok) throw schtasksError('schtasks /Run', run);

  return statusSchtask();
}

export async function uninstallSchtask(): Promise<void> {
  // Best-effort end of the running instance, then delete the registration.
  runSchtasks(['/End', '/TN', WINDOWS_TASK_NAME]);
  const del = runSchtasks(['/Delete', '/F', '/TN', WINDOWS_TASK_NAME]);
  // `/Delete` fails if the task doesn't exist — that's fine for an idempotent stop.
  if (!del.ok && isTaskRegistered()) throw schtasksError('schtasks /Delete', del);
  if (existsSync(launcherCmdPath())) await rm(launcherCmdPath(), { force: true });
}

/** schtasks has no native restart — end, wait for it to stop, run again. */
export async function restartSchtask(): Promise<ServiceStatus> {
  if (!isTaskRegistered()) {
    throw new Error(`计划任务未安装：${WINDOWS_TASK_NAME}（先运行 \`feishu-codex-bridge start\`）`);
  }
  runSchtasks(['/End', '/TN', WINDOWS_TASK_NAME]); // best-effort; ignore if not running
  await waitUntilStopped();
  const run = runSchtasks(['/Run', '/TN', WINDOWS_TASK_NAME]);
  if (!run.ok) throw schtasksError('schtasks /Run', run);
  return statusSchtask();
}

export function statusSchtask(): ServiceStatus {
  const installed = isTaskRegistered();
  const raw = installed ? describeTask() : '';
  return {
    platformName: 'Task Scheduler (Windows)',
    installed,
    running: installed && /Status:\s+Running/i.test(raw),
    servicePath: WINDOWS_TASK_NAME,
    stdoutPath: serviceStdoutPath(),
    stderrPath: serviceStderrPath(),
    // `Process ID:` only appears in verbose output while the task is running.
    pid: raw.match(/Process ID:\s*(\d+)/i)?.[1],
    // `Last Result: 0` ⇒ last run succeeded. Surface it as the exit code.
    lastExit: raw.match(/Last Result:\s*(-?\d+)/i)?.[1],
    raw,
  };
}

/** `/Query` returns 0 iff the task is registered. Output is discarded here. */
export function isTaskRegistered(): boolean {
  const r = spawnSync('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

/** Sync run-state check (used by the `daemonRunning` fast path). */
export function schtaskRunning(): boolean {
  if (!isTaskRegistered()) return false;
  return /Status:\s+Running/i.test(describeTask());
}

function describeTask(): string {
  const r = runSchtasks(['/Query', '/V', '/FO', 'LIST', '/TN', WINDOWS_TASK_NAME]);
  return r.stdout || r.stderr || '';
}

async function waitUntilStopped(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!schtaskRunning()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Tail the service logs. Windows has no `tail`, so this is pure Node: print the
 * last ~100 lines of each file, then (when `follow`) poll for appended bytes
 * until interrupted (Ctrl+C).
 */
export async function tailSchtaskLogs(follow: boolean): Promise<void> {
  await ensureLogFiles();
  const files = [serviceStdoutPath(), serviceStderrPath()];

  for (const f of files) {
    const tail = await lastLines(f, 100);
    if (tail) process.stdout.write(`\n===== ${f} =====\n${tail}\n`);
  }
  if (!follow) return;

  const offsets = new Map<string, number>(files.map((f) => [f, fileSize(f)]));
  await new Promise<void>((resolvePromise) => {
    const onSigint = (): void => {
      clearInterval(timer);
      process.off('SIGINT', onSigint);
      resolvePromise();
    };
    process.on('SIGINT', onSigint);
    const timer = setInterval(() => {
      for (const f of files) {
        const size = fileSize(f);
        const from = offsets.get(f) ?? 0;
        if (size > from) {
          offsets.set(f, size);
          createReadStream(f, { start: from, end: size - 1, encoding: 'utf8' }).pipe(process.stdout, {
            end: false,
          });
        } else if (size < from) {
          offsets.set(f, size); // truncated/rotated — reset
        }
      }
    }, 700);
  });
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

async function lastLines(file: string, n: number): Promise<string> {
  try {
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    return lines.slice(-n - 1).join('\n').trimEnd();
  } catch {
    return '';
  }
}
