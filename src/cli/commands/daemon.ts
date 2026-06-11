import { ensureOnboarded, confirmReadyForDaemon } from '../../bot/onboarding';
import { activeBots, loadBots } from '../../config/bots';
import { getServiceAdapter, type ServiceStatus } from '../../service/adapter';
import { markRestartIntent } from '../../service/restart-notice';

/**
 * Daemon lifecycle. `start` installs ONE launchd/systemd/login service whose
 * body runs `run` (so the background process is the same bridge the user runs
 * in the foreground). When multiple bots are active, that single `run` becomes
 * the multi-process supervisor, so the service layer stays bot-agnostic — no
 * per-bot service definitions to install.
 *
 * Onboarding happens here in the foreground first — this terminal has a TTY for
 * the scan — so the detached service never enters the wizard. With a multi-bot
 * active set we walk every active bot through onboarding + the readiness gate
 * (sequentially, so each bot's scope prompts stay legible).
 */
export async function runStart(): Promise<void> {
  const active = activeBots(await loadBots());

  if (active.length === 0) {
    // Fresh / legacy single-bot install: onboard (maybe scan-create) the
    // implicit current/default bot.
    const ready = await ensureOnboarded({ allowCreate: true });
    if (!ready) {
      process.exitCode = 1;
      return;
    }
    if (!(await confirmReadyForDaemon(ready))) {
      process.exitCode = 1;
      return;
    }
  } else {
    if (active.length > 1) {
      console.log(`\n后台服务将托管 ${active.length} 个机器人（supervisor 多进程，各自独立进程）：`);
      for (const b of active) console.log(`  • ${b.name}  (${b.appId})  [${b.tenant}]`);
      console.log('');
    }
    // Don't daemonize a bot that can't receive messages — block until the
    // operator has finished authorizing each one (scopes granted, events
    // subscribed, version published).
    for (const bot of active) {
      if (active.length > 1) console.log(`\n──── 机器人「${bot.name}」(${bot.appId}) ────`);
      const ready = await ensureOnboarded({ bot: bot.appId });
      if (!ready) {
        process.exitCode = 1;
        return;
      }
      if (!(await confirmReadyForDaemon(ready))) {
        process.exitCode = 1;
        return;
      }
    }
  }

  const status = await getServiceAdapter().install();
  console.log(installedNote());
  printStatus(status);
}

export async function runStop(): Promise<void> {
  await getServiceAdapter().uninstall();
  console.log('✓ 后台服务已停止，并已关闭自启（已移除服务定义）。');
}

export async function runRestart(): Promise<void> {
  await markRestartIntent('manual_restart').catch(() => undefined);
  const status = await getServiceAdapter().restart();
  console.log('✓ 后台服务已重启。');
  printStatus(status);
}

export async function runStatus(): Promise<void> {
  printStatus(await getServiceAdapter().status());
}

export async function runLogs(follow: boolean): Promise<void> {
  await getServiceAdapter().logs(follow);
}

function installedNote(): string {
  switch (process.platform) {
    case 'win32':
      return (
        '✓ 后台服务已安装并启动（登录自启，免管理员）。' +
        '\n  提示：登录自启在下次登录生效；当前已在后台隐藏启动。注意 Windows 登录自启无崩溃自动拉起。'
      );
    case 'linux':
      return (
        '✓ 后台服务已安装并启动（登录自启、崩溃自动拉起）。' +
        '\n  提示：注销后仍保持运行需执行一次 `loginctl enable-linger $USER`。'
      );
    default:
      return '✓ 后台服务已安装并启动（开机自启、崩溃自动拉起）。';
  }
}

function printStatus(status: ServiceStatus): void {
  console.log(`service:   ${status.platformName}`);
  console.log(`path:      ${status.servicePath}`);
  console.log(`installed: ${status.installed ? 'yes' : 'no'}`);
  console.log(`running:   ${status.running ? 'yes' : 'no'}`);
  console.log(`pid:       ${status.pid ?? '-'}`);
  console.log(`last exit: ${status.lastExit ?? '-'}`);
  console.log(`stdout:    ${status.stdoutPath}`);
  console.log(`stderr:    ${status.stderrPath}`);

  if (!status.installed) {
    console.log('提示：后台服务尚未安装，运行 `feishu-codex-bridge start`。');
  } else if (!status.running) {
    console.log('提示：服务已注册但当前未运行（试试 `restart`）。');
  }
}
