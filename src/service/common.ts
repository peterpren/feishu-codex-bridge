import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../config/paths';

/**
 * Platform-agnostic snapshot of the background service, produced by whichever
 * OS service manager backs this platform (launchd on macOS, Task Scheduler on
 * Windows). Callers render these fields without knowing the platform.
 */
export interface ServiceStatus {
  /** Human label of the service manager, e.g. `"launchd (macOS)"`. */
  platformName: string;
  /** The service definition (plist / scheduled task) is registered with the OS. */
  installed: boolean;
  /** The service process is currently alive. */
  running: boolean;
  /** Path or name of the service definition (plist path / task name). */
  servicePath: string;
  stdoutPath: string;
  stderrPath: string;
  pid?: string;
  lastExit?: string;
  /** Raw status output from the underlying tool, for diagnostics. */
  raw: string;
}

/** Service log files live under the app dir, identical across platforms. */
export function serviceStdoutPath(): string {
  return join(paths.appDir, 'service.log');
}

export function serviceStderrPath(): string {
  return join(paths.appDir, 'service.err.log');
}

/** Touch both log files so the service (and `logs` tail) always have a target. */
export async function ensureLogFiles(): Promise<void> {
  await mkdir(paths.appDir, { recursive: true });
  await appendFile(serviceStdoutPath(), '');
  await appendFile(serviceStderrPath(), '');
}
