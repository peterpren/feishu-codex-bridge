import { Command } from 'commander';
import { bridgeVersion } from '../core/version';
import { runDoctor } from './commands/doctor';
import { runRun } from './commands/run';
import { runStart, runStop, runRestart, runStatus, runLogs } from './commands/daemon';
import { runUpdate } from './commands/update';
import { runBotInit, runBotList, runBotUse, runBotRm } from './commands/bot';
import { secretsGet, secretsSet, secretsList, secretsRemove } from './commands/secrets';

const program = new Command();

program
  .name('feishu-codex-bridge')
  .description('把飞书/Lark 桥接到本机 Codex（项目=群, 话题=会话）')
  .version(bridgeVersion());

// ── 进程 / 守护 ──────────────────────────────────────────────
program
  .command('run')
  .description('前台启动活跃机器人（多个则各自独立进程；没配置则先扫码 init；Ctrl+C 优雅退出）')
  .option('--bot <name>', '只启动指定的一个机器人（名字或 appId）')
  .action(async (options: { bot?: string }) => {
    await runRun(options.bot);
  });

program
  .command('start')
  .description('后台 daemon 启动（装 launchd 开机自启；没配置则先扫码 init）')
  .action(async () => {
    await runStart();
  });

program
  .command('stop')
  .description('停止后台 daemon 并关闭开机自启')
  .action(async () => {
    await runStop();
  });

program
  .command('restart')
  .description('重启后台 daemon')
  .action(async () => {
    await runRestart();
  });

program
  .command('status')
  .description('后台 daemon 状态（pid / 日志路径 / 上次退出码）')
  .action(async () => {
    await runStatus();
  });

program
  .command('logs')
  .description('查看后台 daemon 日志')
  .option('-f, --follow', '持续跟随日志')
  .action(async (options: { follow?: boolean }) => {
    await runLogs(Boolean(options.follow));
  });

program
  .command('update')
  .description('从 npm 更新到最新版，并自动重启后台 daemon')
  .option('--check', '只检查有无新版，不安装')
  .action(async (options: { check?: boolean }) => {
    await runUpdate({ check: Boolean(options.check) });
  });

// ── 飞书机器人管理 ───────────────────────────────────────────
const bot = program.command('bot').description('飞书机器人管理（多机器人）');
bot
  .command('init [name]')
  .description('注册一个飞书机器人并授权（可选短名）')
  .action(async (name?: string) => {
    await runBotInit(name);
  });
bot
  .command('list')
  .description('列出已注册的飞书机器人')
  .action(async () => {
    await runBotList();
  });
bot
  .command('use [names...]')
  .description('勾选/指定要同时连接的机器人（多选）；无参数弹交互式勾选框')
  .action(async (names: string[]) => {
    await runBotUse(names ?? []);
  });
bot
  .command('rm <name>')
  .description('移除一个机器人配置')
  .action(async (name: string) => {
    await runBotRm(name);
  });

// ── 杂项 ─────────────────────────────────────────────────────
program
  .command('doctor')
  .description('本地自检：codex / 登录 / lark-cli / 当前机器人配置')
  .action(async () => {
    await runDoctor();
  });

// Internal plumbing — the `secrets-getter` wrapper execs `secrets get` to
// resolve the App Secret from the keystore. Users never call it, so hide it
// from --help (still fully functional, just unlisted).
const secrets = program.command('secrets', { hidden: true }).description('本地加密密钥库（内部）');
secrets
  .command('get')
  .description('exec-provider 端点（从 stdin 读 JSON 请求）')
  .action(async () => {
    await secretsGet();
  });
secrets
  .command('set <id>')
  .description('存储密钥（值从 stdin 读）')
  .action(async (id: string) => {
    await secretsSet(id);
  });
secrets
  .command('list')
  .description('列出密钥 id')
  .action(async () => {
    await secretsList();
  });
secrets
  .command('remove <id>')
  .description('删除密钥')
  .action(async (id: string) => {
    await secretsRemove(id);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
