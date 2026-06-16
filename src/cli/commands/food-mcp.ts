import { resolveCodexBin } from '../../agent/codex-appserver/locate';
import { AppServerClient } from '../../agent/codex-appserver/app-server-client';
import type { ListMcpServerStatusResponse, McpAuthStatus } from '../../agent/codex-appserver/protocol/generated/v2';
import { activeBots, ensureRegistry, findBot, type BotEntry } from '../../config/bots';
import { getSecret, setSecret } from '../../config/keystore';
import { useBotDir } from '../../config/paths';
import { isComplete, type AppConfig } from '../../config/schema';
import { resolveAppSecret } from '../../config/secret-resolver';
import { loadConfig } from '../../config/store';
import { FOOD_MCP_SERVERS, foodMcpEnabled, listProjects, updateProject, withFoodMcpServers, withoutFoodMcpServers } from '../../project/registry';
import { validateAppCredentials } from '../../utils/feishu-auth';

export interface FoodMcpTokenCheck {
  title: string;
  url: string;
  envVar?: string;
  secretId?: string;
  configuredByEnv: boolean;
  configuredBySecret: boolean;
}

export interface FoodMcpProjectCheck {
  botName: string;
  appId: string;
  active: boolean;
  auth: 'ok' | 'failed' | 'not-checked';
  authDetail?: string;
  enabledProjects: string[];
  totalProjects: number;
}

export interface FoodMcpStatusReport {
  tokens: FoodMcpTokenCheck[];
  bots: FoodMcpProjectCheck[];
}

export interface FoodMcpProbeServer {
  name: string;
  title: string;
  authStatus: McpAuthStatus | 'missing';
  toolNames: string[];
  error?: string;
}

export interface FoodMcpProbeReport {
  tokenReady: boolean;
  servers: FoodMcpProbeServer[];
}

export async function runFoodMcpStatus(): Promise<void> {
  const report = await collectFoodMcpStatus();
  console.log(formatFoodMcpStatus(report));
  process.exitCode = foodMcpReady(report) ? 0 : 1;
}

export async function runFoodMcpSetToken(brand: string): Promise<void> {
  const server = resolveFoodMcpServer(brand);
  if (!server?.bearerTokenSecretId) {
    console.error(`找不到品牌「${brand}」。可选：luckin, mcd`);
    process.exitCode = 1;
    return;
  }
  const token = (await readSecretInput(`${server.title ?? server.name} Token：`)).trim();
  if (!token) {
    console.error(`无输入：直接运行 feishu-codex-bridge food-mcp set-token ${brand} 后粘贴 Token，或用 stdin 传入。`);
    process.exitCode = 1;
    return;
  }
  await setSecret(server.bearerTokenSecretId, token);
  console.log(`✓ 已存储 ${server.title ?? server.name} Token：${server.bearerTokenSecretId}`);
  console.log('下一步：feishu-codex-bridge restart && feishu-codex-bridge food-mcp status && feishu-codex-bridge food-mcp probe');
}

export async function runFoodMcpSetProject(projectName: string, enabled: boolean, opts: { bot?: string } = {}): Promise<void> {
  const target = await resolveProjectTarget(projectName, opts.bot);
  if (!target) {
    process.exitCode = 1;
    return;
  }
  useBotDir(target.bot.appId);
  await updateProject(target.projectName, (project) => ({
    mcpServers: enabled ? withFoodMcpServers(project.mcpServers) : withoutFoodMcpServers(project.mcpServers),
  }));
  console.log(`✓ 已${enabled ? '启用' : '停用'}「${target.projectName}」的瑞幸/麦当劳 MCP（bot: ${target.bot.name}）。`);
  console.log('后台服务已在运行时不会自动驱逐旧会话；请执行：feishu-codex-bridge restart');
}

export async function runFoodMcpProbe(): Promise<void> {
  const status = await collectFoodMcpStatus();
  const missing = status.tokens.filter((token) => !token.configuredByEnv && !token.configuredBySecret);
  if (missing.length) {
    console.log(formatFoodMcpProbe({
      tokenReady: false,
      servers: missing.map((token) => ({
        name: token.envVar ?? token.secretId ?? token.title,
        title: token.title,
        authStatus: 'missing',
        toolNames: [],
        error: 'Token 未配置',
      })),
    }));
    process.exitCode = 1;
    return;
  }

  const bin = resolveCodexBin();
  if (!bin) {
    console.error('未找到 codex CLI，无法启动临时 MCP 探测。');
    process.exitCode = 1;
    return;
  }

  const client = new AppServerClient({ bin, cwd: process.cwd(), mcpServers: FOOD_MCP_SERVERS.map((server) => ({ ...server })) });
  try {
    await withTimeout(client.connect(), 20_000, 'app-server initialize');
    const res = await withTimeout(
      client.request<ListMcpServerStatusResponse>('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', limit: 20 }),
      30_000,
      'mcpServerStatus/list',
    );
    const byName = new Map(res.data.map((server) => [server.name, server]));
    const report: FoodMcpProbeReport = {
      tokenReady: true,
      servers: FOOD_MCP_SERVERS.map((server) => {
        const status = byName.get(server.name);
        if (!status) {
          return { name: server.name, title: server.title ?? server.name, authStatus: 'missing', toolNames: [], error: '未返回状态' };
        }
        return {
          name: server.name,
          title: server.title ?? server.name,
          authStatus: status.authStatus,
          toolNames: Object.keys(status.tools ?? {}).sort(),
        };
      }),
    };
    console.log(formatFoodMcpProbe(report));
    process.exitCode = report.servers.every((server) => server.authStatus !== 'missing' && server.toolNames.length > 0) ? 0 : 1;
  } catch (err) {
    console.error(`MCP 探测失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

export async function collectFoodMcpStatus(): Promise<FoodMcpStatusReport> {
  const tokens = await Promise.all(
    FOOD_MCP_SERVERS.map(async (server) => {
      const envVar = server.bearerTokenEnvVar?.trim();
      const secretId = server.bearerTokenSecretId?.trim();
      const configuredByEnv = Boolean(envVar && process.env[envVar]);
      const configuredBySecret = Boolean(secretId && (await getSecret(secretId).catch(() => undefined)));
      return {
        title: server.title ?? server.name,
        url: server.url,
        envVar,
        secretId,
        configuredByEnv,
        configuredBySecret,
      };
    }),
  );

  const reg = await ensureRegistry();
  const active = new Set(activeBots(reg).map((bot) => bot.appId));
  const bots: FoodMcpProjectCheck[] = [];
  for (const bot of reg.bots) {
    useBotDir(bot.appId);
    const auth = active.has(bot.appId) ? await checkBotAuth() : { auth: 'not-checked' as const };
    const projects = await listProjects();
    bots.push({
      botName: bot.name,
      appId: bot.appId,
      active: active.has(bot.appId),
      ...auth,
      enabledProjects: projects.filter((project) => foodMcpEnabled(project)).map((project) => project.name),
      totalProjects: projects.length,
    });
  }

  return { tokens, bots };
}

export function foodMcpReady(report: FoodMcpStatusReport): boolean {
  return (
    report.tokens.every((token) => token.configuredByEnv || token.configuredBySecret) &&
    report.bots.some((bot) => bot.active && bot.auth === 'ok' && bot.enabledProjects.length > 0)
  );
}

export function formatFoodMcpStatus(report: FoodMcpStatusReport): string {
  const lines: string[] = ['餐饮 MCP 状态', ''];

  lines.push('Token');
  for (const token of report.tokens) {
    const configured = token.configuredByEnv || token.configuredBySecret;
    const source = token.configuredByEnv ? '环境变量' : token.configuredBySecret ? '本地密钥库' : '未配置';
    lines.push(`  ${configured ? '✓' : '✗'} ${token.title}：${source}`);
    lines.push(`    端点：${token.url}`);
    if (token.envVar || token.secretId) lines.push(`    位置：${[token.envVar, token.secretId].filter(Boolean).join(' / ')}`);
  }

  lines.push('', '项目');
  if (report.bots.length === 0) {
    lines.push('  ✗ 尚未注册飞书机器人');
  } else {
    for (const bot of report.bots) {
      const mark = bot.active ? '✓' : '-';
      const enabled = bot.enabledProjects.length ? bot.enabledProjects.join('、') : '无';
      lines.push(`  ${mark} ${bot.botName} (${bot.appId})：${enabled}  / 共 ${bot.totalProjects} 个项目  / ${authLabel(bot)}`);
    }
  }

  lines.push('', '配置命令');
  lines.push('  feishu-codex-bridge food-mcp set-token luckin');
  lines.push('  feishu-codex-bridge food-mcp set-token mcd');
  lines.push('  feishu-codex-bridge restart');
  lines.push('  feishu-codex-bridge food-mcp probe');

  lines.push('', foodMcpReady(report) ? '状态：可开始在已启用项目里测试菜单/门店查询。' : '状态：还没就绪，至少缺 Token、活跃项目启用或飞书 bot 授权。');
  return `${lines.join('\n')}\n`;
}

export function formatFoodMcpProbe(report: FoodMcpProbeReport): string {
  const lines: string[] = ['餐饮 MCP 探测', ''];
  for (const server of report.servers) {
    const ok = server.authStatus !== 'missing' && server.toolNames.length > 0;
    lines.push(`  ${ok ? '✓' : '✗'} ${server.title}：${authStatusLabel(server.authStatus)}${server.error ? `（${server.error}）` : ''}`);
    if (server.toolNames.length) {
      const names = server.toolNames.slice(0, 12).join('、');
      const more = server.toolNames.length > 12 ? ` 等 ${server.toolNames.length} 个` : ` 共 ${server.toolNames.length} 个`;
      lines.push(`    工具：${names}${more}`);
    }
  }
  lines.push('', report.tokenReady ? '状态：MCP 可连接；下一步去 Bridge Debug 群做菜单/门店查询。' : '状态：Token 未配置，先写入 Token。');
  return `${lines.join('\n')}\n`;
}

async function checkBotAuth(): Promise<Pick<FoodMcpProjectCheck, 'auth' | 'authDetail'>> {
  const cfg = await loadConfig();
  if (!isComplete(cfg)) return { auth: 'failed', authDetail: '配置不完整' };
  try {
    const app = (cfg as AppConfig).accounts.app;
    const secret = await resolveAppSecret(cfg as AppConfig);
    const result = await validateAppCredentials(app.id, secret, app.tenant);
    return result.ok ? { auth: 'ok', authDetail: result.botName } : { auth: 'failed', authDetail: result.reason ?? '校验失败' };
  } catch (err) {
    return { auth: 'failed', authDetail: err instanceof Error ? err.message : String(err) };
  }
}

function authLabel(bot: Pick<FoodMcpProjectCheck, 'auth' | 'authDetail'>): string {
  if (bot.auth === 'not-checked') return '未检查授权';
  if (bot.auth === 'ok') return `授权正常${bot.authDetail ? `：${bot.authDetail}` : ''}`;
  return `授权失败${bot.authDetail ? `：${bot.authDetail}` : ''}`;
}

async function resolveProjectTarget(projectName: string, botNameOrAppId?: string): Promise<{ bot: BotEntry; projectName: string } | undefined> {
  const name = projectName.trim();
  if (!name) {
    console.error('项目名不能为空。');
    return undefined;
  }
  const reg = await ensureRegistry();
  const bots = botNameOrAppId ? [findBot(reg, botNameOrAppId)].filter((bot): bot is BotEntry => Boolean(bot)) : reg.bots;
  if (botNameOrAppId && bots.length === 0) {
    console.error(`找不到机器人「${botNameOrAppId}」。`);
    return undefined;
  }

  const matches: { bot: BotEntry; projectName: string }[] = [];
  const projectHints: string[] = [];
  for (const bot of bots) {
    useBotDir(bot.appId);
    const projects = await listProjects();
    projectHints.push(`${bot.name}: ${projects.map((project) => project.name).join('、') || '无'}`);
    const project = projects.find((item) => item.name === name);
    if (project) matches.push({ bot, projectName: project.name });
  }

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error(`项目「${name}」存在于多个机器人下，请加 --bot 指定：${matches.map((match) => match.bot.name).join('、')}`);
    return undefined;
  }
  console.error(`找不到项目「${name}」。当前项目：${projectHints.join('；')}`);
  return undefined;
}

function authStatusLabel(status: FoodMcpProbeServer['authStatus']): string {
  switch (status) {
    case 'bearerToken':
      return 'Bearer Token';
    case 'oAuth':
      return 'OAuth';
    case 'notLoggedIn':
      return '未登录';
    case 'unsupported':
      return '无需认证';
    case 'missing':
      return '未连接';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(t);
        resolve(value);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

function resolveFoodMcpServer(brand: string): (typeof FOOD_MCP_SERVERS)[number] | undefined {
  const key = brand.trim().toLowerCase();
  if (['luckin', 'lk', '瑞幸', '瑞幸咖啡'].includes(key)) return FOOD_MCP_SERVERS.find((server) => server.name === 'luckin-coffee');
  if (['mcd', 'mcdonalds', 'mcdonald', '麦当劳'].includes(key)) return FOOD_MCP_SERVERS.find((server) => server.name === 'mcd-mcp');
  return undefined;
}

function readSecretInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return readStdin();
  return readHiddenLine(prompt);
}

function readHiddenLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    const wasRaw = input.isRaw;
    let value = '';
    let settled = false;

    const cleanup = (): void => {
      input.off('data', onData);
      if (typeof input.setRawMode === 'function') input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
    };
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\u0003') return done(new Error('已取消'));
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= ' ') value += ch;
      }
    };

    output.write(prompt);
    input.setEncoding('utf8');
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}
