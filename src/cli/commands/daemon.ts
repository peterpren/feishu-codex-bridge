import { ensureOnboarded, confirmReadyForDaemon } from '../../bot/onboarding';
import { getServiceAdapter, type ServiceStatus } from '../../service/adapter';

/**
 * Daemon lifecycle. `start` installs a launchd agent whose body runs `run`
 * (so the background process is the same bridge the user runs in the
 * foreground). Onboarding happens here in the foreground first — this terminal
 * has a TTY for the scan — so the detached service never enters the wizard.
 */
export async function runStart(): Promise<void> {
  const ready = await ensureOnboarded({ allowCreate: true });
  if (!ready) {
    process.exitCode = 1;
    return;
  }
  // Don't daemonize a bot that can't receive messages — block until the
  // operator has finished authorizing (scopes granted, events subscribed,
  // version published).
  if (!(await confirmReadyForDaemon(ready))) {
    process.exitCode = 1;
    return;
  }
  const status = await getServiceAdapter().install();
  console.log(
    process.platform === 'win32'
      ? '✓ 后台服务已安装并启动（登录自启；注意：Windows 计划任务无崩溃自动拉起）。'
      : '✓ 后台服务已安装并启动（开机自启、崩溃自动拉起）。',
  );
  printStatus(status);
}

export async function runStop(): Promise<void> {
  await getServiceAdapter().uninstall();
  console.log('✓ 后台服务已停止，并已关闭自启（已移除服务定义）。');
}

export async function runRestart(): Promise<void> {
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
