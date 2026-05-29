import { loadConfig, saveConfig, buildEncryptedAccountConfig } from '../config/store';
import { setSecret } from '../config/keystore';
import { isComplete, secretKeyForApp, type AppConfig } from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { runRegistrationWizard } from './wizard';
import { validateAppCredentials } from '../utils/feishu-auth';
import { buildScopeGrantUrl } from '../config/scopes';
import { resolveCodexBin } from '../agent/codex-appserver/locate';
import { openUrl } from '../utils/open-url';
import { log } from '../core/logger';
import { useBotDir } from '../config/paths';
import { ensureRegistry, addBot, currentBot, loadBots, uniqueName, type BotEntry } from '../config/bots';

export interface OnboardResult {
  cfg: AppConfig;
  secret: string;
}

/** Verify codex CLI is present (needed to run AND to spawn the per-session app-server). */
export function ensureCodex(): boolean {
  if (resolveCodexBin()) return true;
  console.error(
    '✗ 未找到 codex CLI。请先安装 Codex 并登录：\n' +
      '    • 安装：npm i -g @openai/codex（或安装 Codex.app，或用 CODEX_BIN 指向已有二进制）\n' +
      '    • 登录：codex login\n' +
      '  然后重跑。可先用 `feishu-codex-bridge doctor` 自检。',
  );
  return false;
}

/**
 * Bring the active bot to a runnable state and return its config + secret.
 *
 * - Resolves the current bot from the registry (migrating a legacy flat install
 *   on first run). With `allowCreate`, a missing current bot triggers the
 *   scan-QR wizard (named `default`) — this is what makes `run`/`start` "init
 *   if not initialized". Without it (or off a TTY) a missing bot is an error.
 * - Validates credentials and surfaces the scope-grant link (auto-opened).
 *
 * Returns null (after printing why) on any failure.
 */
export async function ensureOnboarded(opts: { allowCreate?: boolean } = {}): Promise<OnboardResult | null> {
  if (!ensureCodex()) return null;

  const reg = await ensureRegistry();
  const entry = currentBot(reg);
  if (!entry) {
    if (!opts.allowCreate) {
      console.error('✗ 尚未配置任何飞书机器人。请先运行 `feishu-codex-bridge bot init`（或前台 `run`）扫码创建。');
      return null;
    }
    return registerNewBot('default');
  }

  useBotDir(entry.appId);
  const cfg = await loadConfig();
  if (!isComplete(cfg)) {
    console.error(`✗ 当前机器人「${entry.name}」(${entry.appId}) 配置缺失或损坏。可 \`bot rm ${entry.name}\` 后重新 \`bot init\`。`);
    return null;
  }
  const secret = await validateAndReport(cfg);
  if (secret === null) return null;
  return { cfg, secret };
}

/**
 * Run the scan-QR wizard to create a brand-new feishu app, persist it (keystore
 * + per-bot config dir + registry), validate, and surface the scope link.
 * `desiredName` defaults to the bot's display name (slugified); pass `'default'`
 * for the implicit first-run from `run`/`start`. Returns null on any failure.
 */
export async function registerNewBot(desiredName?: string): Promise<OnboardResult | null> {
  // The scan needs a human at a terminal. A headless context (the launchd
  // service, CI) must never enter the wizard — `registerApp` would print a QR
  // to a log nobody reads and poll forever. Fail fast with a pointer instead.
  if (!process.stdout.isTTY) {
    console.error(
      '✗ 当前不是交互式终端，无法扫码创建飞书应用。\n' +
        '  请在终端前台运行 `feishu-codex-bridge bot init`（或 `run` / `start`）扫码 onboarding。',
    );
    return null;
  }

  const wizardCfg = await runRegistrationWizard();
  const app = wizardCfg.accounts.app;
  if (typeof app.secret !== 'string') {
    console.error('✗ 向导未返回明文密钥，无法继续。');
    return null;
  }

  // Validate with the plaintext secret before persisting — bad creds shouldn't
  // leave a half-registered bot behind.
  const v = await validateAppCredentials(app.id, app.secret, app.tenant);
  if (!v.ok) {
    console.error(`✗ 应用凭据校验失败：${v.reason}`);
    return null;
  }

  await setSecret(secretKeyForApp(app.id), app.secret);
  useBotDir(app.id); // from here all per-bot files land under bots/<appId>/
  const cfg = await buildEncryptedAccountConfig(app.id, app.tenant, wizardCfg.preferences);
  await saveConfig(cfg);

  const reg = await loadBots();
  const name = uniqueName(reg, desiredName ?? v.botName ?? 'default');
  await addBot({ name, appId: app.id, tenant: app.tenant, botName: v.botName, createdAt: Date.now() });

  console.log(`✓ 已创建机器人「${name}」  bot: ${v.botName ?? '-'}  appId: ${app.id}`);
  log.info('onboard', 'bot-created', { name, appId: app.id, bot: v.botName ?? null });
  showScopeGrant(cfg, v.missingScopes);

  const secret = await resolveAppSecret(cfg);
  return { cfg, secret };
}

/** Resolve secret, validate credentials, print result + scope-grant link. Returns secret or null. */
async function validateAndReport(cfg: AppConfig): Promise<string | null> {
  const secret = await resolveAppSecret(cfg);
  const v = await validateAppCredentials(cfg.accounts.app.id, secret, cfg.accounts.app.tenant);
  if (!v.ok) {
    console.error(`✗ 应用凭据校验失败：${v.reason}`);
    console.error('  应用可能被禁用/未发布；可重跑 `feishu-codex-bridge bot init` 重新扫码。');
    return null;
  }
  console.log(`✓ 凭据校验通过  bot: ${v.botName ?? '-'}  appId: ${cfg.accounts.app.id}`);
  log.info('onboard', 'credentials-ok', { appId: cfg.accounts.app.id, bot: v.botName ?? null });
  showScopeGrant(cfg, v.missingScopes);
  return secret;
}

/**
 * Feishu has no "grant on scan" API, so the only way to enable scopes is this
 * console page. The URL is long and gets buried under the bot's startup logs,
 * so we frame it in a banner AND auto-open the browser — otherwise users miss
 * it and then wonder why @-ing the bot does nothing. Best-effort:
 * `missingScopes` is undefined when the check couldn't run.
 */
function showScopeGrant(cfg: AppConfig, missingScopes: string[] | undefined): void {
  if (missingScopes && missingScopes.length > 0) {
    const url = buildScopeGrantUrl(cfg.accounts.app.id, cfg.accounts.app.tenant);
    const rule = '─'.repeat(64);
    const opened = openUrl(url);
    console.log(`\n${rule}`);
    console.log(`⚠️  还差 ${missingScopes.length} 项权限未开通 —— 不开通则收不到消息、发不出卡片`);
    console.log('   飞书没有「扫码即授权」的接口，只能在浏览器开通（即时生效，无需重启）：');
    console.log(
      opened
        ? '\n   🌐 已自动打开浏览器授权页。若没弹出，手动复制下面链接打开：'
        : '\n   🌐 在浏览器打开下面链接，勾选全部权限 → 确认：',
    );
    console.log(`\n   👉 ${url}\n`);
    console.log(`   （本次缺失：${missingScopes.join('  ')}）`);
    console.log(`${rule}\n`);
  } else if (missingScopes === undefined) {
    log.info('onboard', 'scope-check-skipped', { reason: 'scope list unavailable' });
  }
}

export type { BotEntry };
