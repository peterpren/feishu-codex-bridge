import { rm } from 'node:fs/promises';
import { ensureCodex, registerNewBot } from '../../bot/onboarding';
import { loadBots, findBot, setCurrent, removeBot } from '../../config/bots';
import { removeSecret } from '../../config/keystore';
import { secretKeyForApp } from '../../config/schema';
import { botDir } from '../../config/paths';

/** `bot init [name]` — register an additional feishu app via scan-QR + authorize. */
export async function runBotInit(name?: string): Promise<void> {
  if (!ensureCodex()) {
    process.exitCode = 1;
    return;
  }
  const result = await registerNewBot(name);
  if (!result) {
    process.exitCode = 1;
    return;
  }
  console.log('\n下一步（飞书开放平台后台，需手动一次 https://open.feishu.cn/app ）：');
  console.log('  1) 事件与回调 → 长连接 → 订阅：im.message.receive_v1 / card.action.trigger / application.bot.menu_v6');
  console.log('     （可选）「加进已有群」功能再订阅：im.chat.member.bot.added_v1 / im.chat.member.bot.deleted_v1');
  console.log('  2) 创建并发布应用版本');
  console.log('\n`bot list` 查看全部；`bot use <名>` 切换当前；`run` 前台跑 / `start` 后台常驻。\n');
}

/** `bot list` — list registered bots, marking the current one. */
export async function runBotList(): Promise<void> {
  const reg = await loadBots();
  if (reg.bots.length === 0) {
    console.log('（还没有注册任何飞书机器人。运行 `feishu-codex-bridge bot init` 创建。）');
    return;
  }
  console.log('\n已注册的飞书机器人：\n');
  for (const b of reg.bots) {
    const cur = b.appId === reg.current ? '👉' : '  ';
    console.log(`${cur} ${b.name.padEnd(16)} ${b.appId}  [${b.tenant}]${b.botName ? `  ${b.botName}` : ''}`);
  }
  console.log('\n👉 = 当前选中（run / start 启动的就是它）。`bot use <名>` 切换。\n');
}

/** `bot use <name>` — choose which bot run/start will launch. */
export async function runBotUse(name: string): Promise<void> {
  const reg = await loadBots();
  const bot = findBot(reg, name);
  if (!bot) {
    console.error(`✗ 找不到机器人「${name}」。已注册：${botNames(reg.bots)}`);
    process.exitCode = 1;
    return;
  }
  if (reg.current === bot.appId) {
    console.log(`「${bot.name}」已经是当前机器人。`);
    return;
  }
  await setCurrent(bot.appId);
  console.log(`✓ 当前机器人 → 「${bot.name}」(${bot.appId})。前台 \`run\` 直接生效；后台请 \`restart\`。`);
}

/** `bot rm <name>` — remove a bot's config: registry entry + keystore secret + state dir. */
export async function runBotRm(name: string): Promise<void> {
  const reg = await loadBots();
  const bot = findBot(reg, name);
  if (!bot) {
    console.error(`✗ 找不到机器人「${name}」。已注册：${botNames(reg.bots)}`);
    process.exitCode = 1;
    return;
  }
  const after = await removeBot(bot.appId);
  await removeSecret(secretKeyForApp(bot.appId));
  await rm(botDir(bot.appId), { recursive: true, force: true });
  console.log(`✓ 已移除机器人「${bot.name}」(${bot.appId})：注册表 + 密钥 + 状态目录(projects/sessions)。`);

  if (after.bots.length === 0) {
    console.log('  已无任何机器人，`bot init` 重新创建。');
  } else if (after.current) {
    const cur = after.bots.find((b) => b.appId === after.current);
    if (cur) console.log(`  当前机器人现为「${cur.name}」。`);
  } else {
    console.log('  当前机器人未设置，用 `bot use <名>` 选择。');
  }
}

function botNames(bots: { name: string }[]): string {
  return bots.map((b) => b.name).join(', ') || '（无）';
}
