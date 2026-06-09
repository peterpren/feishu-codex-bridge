import {
  currentVersion,
  daemonRunning,
  installLatest,
  isDevSource,
  isNewer,
  latestVersion,
  manualInstallCommand,
  restartDaemon,
  updateSourceLabel,
} from '../../service/update';

/**
 * `feishu-codex-bridge update` — self-update from the configured npm package and, if a
 * background daemon is running, restart it so the new code takes effect. With
 * `--check`, only report whether a newer version exists (no install).
 */
export async function runUpdate(opts: { check?: boolean } = {}): Promise<void> {
  const current = currentVersion();
  console.log(`当前版本：v${current}`);
  console.log(`查询最新版本…（${updateSourceLabel()}）`);
  const latest = await latestVersion();

  if (!latest) {
    console.log('⚠️ 查不到最新版本（网络或 npm registry 访问问题）。');
    process.exitCode = 1;
    return;
  }
  if (!isNewer(latest, current)) {
    console.log(`✓ package 版本已是最新（v${current}）。`);
    if (opts.check) return;
    console.log('仍将重新安装 npm 最新包（适用于刚发布但本地缓存未刷新的情况）。');
  }

  if (isNewer(latest, current)) console.log(`发现新版本：v${current} → v${latest}`);
  if (opts.check) {
    console.log('运行 `feishu-codex-bridge update` 安装更新。');
    return;
  }
  if (isDevSource()) {
    console.log('检测到源码开发模式（仓库内有 .git）。请用：git pull --ff-only && npm i && npm run build && feishu-codex-bridge restart');
    return;
  }

  console.log(`开始全局安装最新版（${manualInstallCommand()}）…`);
  const res = await installLatest({ inherit: true });
  if (!res.ok) {
    console.log(`❌ 安装失败：${res.message}`);
    console.log(`可在终端手动执行：${manualInstallCommand()}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 已更新到 v${latest}`);

  if (daemonRunning()) {
    console.log('重启后台服务以加载新版本…');
    try {
      await restartDaemon();
      console.log('✓ 后台服务已重启，新版本已生效。');
    } catch (err) {
      console.log(`⚠️ 自动重启失败：${err instanceof Error ? err.message : String(err)}`);
      console.log('请手动执行：feishu-codex-bridge restart');
    }
  } else {
    console.log('未检测到运行中的后台 daemon；下次 `start` / `run` 即用新版本。');
  }
}
