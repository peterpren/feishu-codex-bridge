import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { paths, useBotDir } from '../../config/paths';
import { ensureRegistry, currentBot } from '../../config/bots';
import { loadConfig } from '../../config/store';
import { isComplete } from '../../config/schema';
import { resolveAppSecret } from '../../config/secret-resolver';
import { buildEventConfigUrl } from '../../config/scopes';
import { resolveCodexBin, codexVersion } from '../../agent/codex-appserver/locate';
import { spawnProcessSync } from '../../platform/spawn';
import { PRODUCT_NAME } from '../../core/branding';
import { diagnoseEventSubscription, summarizeEventDiagnosis } from '../../utils/event-diagnosis';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  warn?: boolean;
}

/**
 * `feishu-codex-bridge doctor` — local self-check.
 * M0 scope: codex CLI + login, lark-cli, config presence. Connection/session
 * checks come online once the bridge runs (M1+).
 */
export async function runDoctor(): Promise<void> {
  const checks: Check[] = [];

  // codex CLI
  const codexBin = resolveCodexBin();
  if (codexBin) {
    const v = codexVersion(codexBin) ?? 'unknown';
    checks.push({ name: 'codex CLI', ok: true, detail: `${v} (${codexBin})` });
  } else {
    checks.push({
      name: 'codex CLI',
      ok: false,
      detail: '未找到。设置 CODEX_BIN，或安装 @openai/codex，或装 Codex.app',
    });
  }

  // codex login (auth file presence — heuristic)
  const codexAuth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  checks.push(
    existsSync(codexAuth)
      ? { name: 'codex 登录', ok: true, detail: codexAuth }
      : { name: 'codex 登录', ok: false, detail: '未登录，运行 `codex login`' },
  );

  // lark-cli
  const larkVer = tryExec('lark-cli', ['--version']);
  checks.push(
    larkVer
      ? { name: 'lark-cli', ok: true, detail: larkVer }
      : { name: 'lark-cli', ok: false, detail: '未找到（onboarding 会装到私有目录）' },
  );

  // bridge config — resolve the current bot (migrating a legacy flat install)
  // and check ITS config dir, not the top-level one.
  const reg = await ensureRegistry();
  const cur = currentBot(reg);
  if (cur) useBotDir(cur.appId);
  if (cur && existsSync(paths.configFile)) {
    checks.push({
      name: 'bridge 配置',
      ok: true,
      detail: `当前机器人「${cur.name}」(${cur.appId})  共 ${reg.bots.length} 个`,
    });
    checks.push(await checkEventSubscription());
  } else if (cur) {
    checks.push({ name: 'bridge 配置', ok: false, detail: `配置文件缺失：${paths.configFile}` });
  } else {
    checks.push({
      name: 'bridge 配置',
      ok: false,
      detail: '未配置，运行 `feishu-codex-bridge run`（或 `bot init`）扫码创建',
    });
  }

  // render
  console.log(`\n🩺 ${PRODUCT_NAME} 自检\n`);
  for (const c of checks) {
    console.log(`  ${c.ok ? (c.warn ? '⚠️' : '✅') : '❌'} ${c.name.padEnd(12)} ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${failed === 0 ? '全部通过 ✓' : `${failed} 项需处理`}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

async function checkEventSubscription(): Promise<Check> {
  try {
    const cfg = await loadConfig();
    if (!isComplete(cfg)) return { name: '事件订阅', ok: false, detail: '配置缺失或损坏，无法读取应用凭据' };
    const app = cfg.accounts.app;
    const secret = await resolveAppSecret(cfg);
    const d = await diagnoseEventSubscription(app.id, secret, app.tenant);
    const detail = `${summarizeEventDiagnosis(d)}  配置页：${buildEventConfigUrl(app.id, app.tenant)}`;
    if (d.state === 'ok') return { name: '事件订阅', ok: true, detail };
    if (d.state === 'unchecked') return { name: '事件订阅', ok: true, warn: true, detail };
    return { name: '事件订阅', ok: false, detail };
  } catch (err) {
    return { name: '事件订阅', ok: true, warn: true, detail: `未能自动检查：${err instanceof Error ? err.message : String(err)}` };
  }
}

function tryExec(cmd: string, args: string[]): string | null {
  try {
    // cross-spawn so a Windows `.cmd` shim (e.g. lark-cli.cmd) resolves instead
    // of being reported as "not found".
    const res = spawnProcessSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (res.status !== 0 || typeof res.stdout !== 'string') return null;
    return res.stdout.trim();
  } catch {
    return null;
  }
}
