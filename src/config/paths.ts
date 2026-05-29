import { homedir } from 'node:os';
import { join } from 'node:path';

const appDir = join(homedir(), '.feishu-codex-bridge');
const larkCliDir = join(appDir, 'lark-cli');
const codexCliDir = join(appDir, 'codex-cli');

/**
 * Per-bot state directory. Each saved bot keeps its own config / projects /
 * sessions / single-instance lock under `~/.feishu-codex-bridge/bots/<appId>/`
 * so switching the active bot (`use`) never mixes one bot's groups with
 * another's. `currentBotDir` defaults to `appDir` (the legacy flat layout) so
 * code that runs before a bot is selected — and pre-migration installs — keeps
 * reading the old top-level files; `useBotDir()` repoints it once the active
 * bot is known.
 */
let currentBotDir = appDir;

export function botDir(appId: string): string {
  return join(appDir, 'bots', appId);
}

/** Point the per-bot paths at `appId`'s directory. Call once at startup. */
export function useBotDir(appId: string): void {
  currentBotDir = botDir(appId);
}

export const paths = {
  appDir,
  cacheDir: appDir,
  /** bot 注册表：保存的全部 bot + 当前选中的 appId */
  botsFile: join(appDir, 'bots.json'),
  /** app id / 租户 / 偏好（当前 bot；不含明文密钥） */
  get configFile(): string {
    return join(currentBotDir, 'config.json');
  },
  /** thread(话题) → codex thread_id + cwd + 会话级配置（当前 bot） */
  get sessionsFile(): string {
    return join(currentBotDir, 'sessions.json');
  },
  /** project(群) → cwd + 默认参数 注册表（当前 bot） */
  get projectsFile(): string {
    return join(currentBotDir, 'projects.json');
  },
  /** 在跑的 start 进程注册中心（同 App 冲突检测；当前 bot） */
  get processesFile(): string {
    return join(currentBotDir, 'processes.json');
  },
  secretsFile: join(appDir, 'secrets.enc'),
  keystoreSaltFile: join(appDir, '.keystore.salt'),
  npmCacheDir: join(appDir, 'npm-cache'),
  /** 空白项目默认落地目录 */
  projectsRootDir: join(appDir, 'projects'),
  larkCliDir,
  larkCliBinDir: join(larkCliDir, 'node_modules', '.bin'),
  codexCliDir,
  codexCliBinDir: join(codexCliDir, 'node_modules', '.bin'),
  /**
   * Thin shell wrapper that lark-cli invokes to resolve secrets from the
   * bridge's encrypted store. Written user-owned and non-symlinked so it
   * passes lark-cli's AssertSecurePath audit.
   */
  secretsGetterScript: join(appDir, 'secrets-getter'),
  mediaDir: join(appDir, 'media'),
};
