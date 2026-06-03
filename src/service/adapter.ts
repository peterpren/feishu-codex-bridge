import type { ServiceStatus } from './common';
import {
  installLaunchd,
  isLoaded as launchdLoaded,
  restartLaunchd,
  statusLaunchd,
  tailLaunchdLogs,
  uninstallLaunchd,
} from './launchd';
import {
  installSchtask,
  restartSchtask,
  schtaskRunning,
  statusSchtask,
  tailSchtaskLogs,
  uninstallSchtask,
} from './schtasks';

export type { ServiceStatus };

export interface ServiceAdapter {
  install(): Promise<ServiceStatus>;
  uninstall(): Promise<void>;
  status(): Promise<ServiceStatus>;
  restart(): Promise<ServiceStatus>;
  logs(follow: boolean): Promise<void>;
}

/**
 * The background-service adapter for the current platform: launchd on macOS,
 * Task Scheduler on Windows. Throws a friendly error on platforms without a
 * background-service implementation (e.g. Linux) — the foreground `run` command
 * works everywhere and is the supported fallback there.
 */
export function getServiceAdapter(): ServiceAdapter {
  if (process.platform === 'darwin') {
    return {
      install: installLaunchd,
      uninstall: uninstallLaunchd,
      status: async () => statusLaunchd(),
      restart: restartLaunchd,
      logs: tailLaunchdLogs,
    };
  }

  if (process.platform === 'win32') {
    return {
      install: installSchtask,
      uninstall: uninstallSchtask,
      status: async () => statusSchtask(),
      restart: restartSchtask,
      logs: tailSchtaskLogs,
    };
  }

  throw new Error(
    'service：当前平台暂不支持后台服务（仅 macOS launchd / Windows 计划任务）。' +
      '请用 `feishu-codex-bridge run` 前台运行' +
      (process.platform === 'linux' ? '；Linux systemd 支持后续提供。' : '。'),
  );
}

/**
 * Sync check: is the OS background service currently running? Used by the update
 * flow to decide whether to restart the daemon. Returns false on platforms
 * without a service implementation (where there's nothing to restart).
 */
export function isServiceRunning(): boolean {
  try {
    if (process.platform === 'darwin') return launchdLoaded();
    if (process.platform === 'win32') return schtaskRunning();
  } catch {
    /* service manager unavailable → treat as not running */
  }
  return false;
}
