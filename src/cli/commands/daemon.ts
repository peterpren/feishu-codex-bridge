import { ensureOnboarded } from '../../bot/onboarding';
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
  const status = await getServiceAdapter().install();
  console.log('✓ 后台服务已安装并启动（开机自启、崩溃自动拉起）。');
  printStatus(status);
}

export async function runStop(): Promise<void> {
  await getServiceAdapter().uninstall();
  console.log('✓ 后台服务已停止，并已关闭开机自启（已移除 launchd plist）。');
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
  console.log(`plist:     ${status.plistPath}`);
  console.log(`installed: ${status.installed ? 'yes' : 'no'}`);
  console.log(`loaded:    ${status.loaded ? 'yes' : 'no'}`);
  console.log(`pid:       ${status.pid ?? '-'}`);
  console.log(`last exit: ${status.lastExit ?? '-'}`);
  console.log(`stdout:    ${status.stdoutPath}`);
  console.log(`stderr:    ${status.stderrPath}`);

  if (!status.installed) {
    console.log('提示：后台服务尚未安装，运行 `feishu-codex-bridge start`。');
  } else if (!status.loaded) {
    console.log('提示：plist 已存在，但 launchd 当前未加载（试试 `restart`）。');
  }
}
