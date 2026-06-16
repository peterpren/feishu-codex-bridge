import { resolve } from 'node:path';
import { log } from '../../core/logger';
import type {
  AgentBackend,
  AgentEvent,
  AgentInput,
  AgentRun,
  AgentThread,
  CompactResult,
  HistoryTool,
  HistoryTurn,
  McpServerConfig,
  ModelInfo,
  PermissionMode,
  ReasoningEffort,
  ResumeThreadOptions,
  ServiceTier,
  ServiceTierInfo,
  StartThreadOptions,
  ThreadHistory,
  ThreadSummary,
  TurnOptions,
} from '../types';
import type { CloudDocFolder } from '../../project/registry';
import { AppServerClient } from './app-server-client';
import { mapNotification } from './event-map';
import { codexVersion, resolveCodexBin } from './locate';
import type { Thread, ThreadItem, Turn } from './protocol';

const APPROVAL_POLICY = 'never';
const AUTO_COMPACT_OFF_LIMIT = 1_000_000_000;

/**
 * Map a permission tier to the thread/start|resume params that enforce it.
 * 'full' (or unset) keeps the historical danger-full-access. 'qa'/'write' send a
 * custom codex permissions profile ("feishu") whose filesystem rules confine
 * BOTH reads and writes to the workspace roots (cwd). The profile is platform-
 * agnostic config; codex translates it to whatever OS sandbox the host has:
 *   - macOS  → Seatbelt (verified: thread/start reports activePermissionProfile
 *     .id="feishu", reads outside cwd like ~/.ssh are denied).
 *   - Windows → WindowsRestrictedToken (the elevated backend enforces deny-read;
 *     an unelevated one that can't enforce it refuses to run — never leaks).
 * `:minimal` keeps the read access codex needs to run commands at all.
 *
 * fail-closed: on Linux / WSL codex's sandbox only ro-binds the disk (writes
 * blocked, READS still open — Landlock read-restriction is unimplemented) AND it
 * does NOT refuse, so a privacy tier there would silently run unconfined. We must
 * NEVER do that — so 'qa'/'write' are gated to macOS + Windows; on any other
 * platform we throw BEFORE spawn (a clear run error, never a downgrade).
 *
 * NOTE (Windows): enforcement is codex's, not ours — verify on a real Windows
 * host (ask the bot to read a file outside cwd → it must refuse) before trusting
 * the read-only tiers with an untrusted external group.
 */
export function sandboxParams(
  mode: PermissionMode | undefined,
  network: boolean | undefined,
): Record<string, unknown> {
  if ((mode ?? 'full') === 'full') return { sandbox: 'danger-full-access' };
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error(
      '「项目内只读 / 项目内读写」靠操作系统沙箱把读写锁进项目文件夹，目前只有 macOS 与原生 Windows 能强制执行。当前平台（Linux / WSL 只挡写、不限制读取，无法保证不泄露隐私）已拒绝启动（绝不降级为完全访问）。请改用「完全访问」、把 Codex 跑进容器/隔离环境，或在 macOS / Windows 上运行。',
    );
  }
  return {
    config: {
      default_permissions: 'feishu',
      permissions: {
        feishu: {
          filesystem: {
            ':minimal': 'read',
            ':workspace_roots': { '.': mode === 'write' ? 'write' : 'read' },
          },
          network: { enabled: Boolean(network) },
        },
      },
    },
  };
}

export function withAutoCompact(
  params: Record<string, unknown>,
  autoCompact: boolean | undefined,
): Record<string, unknown> {
  if (autoCompact !== false) return params;
  const config = (params.config as Record<string, unknown> | undefined) ?? {};
  return { ...params, config: { ...config, model_auto_compact_token_limit: AUTO_COMPACT_OFF_LIMIT } };
}

interface ThreadSessionOptions {
  cwd: string;
  model?: string;
  serviceTier?: ServiceTier;
  mode?: PermissionMode;
  network?: boolean;
  cloudDocFolder?: CloudDocFolder;
  autoCompact?: boolean;
  mcpServers?: McpServerConfig[];
}

type ThreadSessionParams = {
  cwd: string;
  approvalPolicy: typeof APPROVAL_POLICY;
  developerInstructions: string;
  model?: string;
  serviceTier?: ServiceTier | null;
} & Record<string, unknown>;

function workspaceRoot(cwd: string): string {
  return resolve(cwd);
}

function codexServiceTier(tier: ServiceTier | undefined): ServiceTier | null | undefined {
  if (tier === undefined) return undefined;
  return tier === 'standard' ? null : tier;
}

export function buildThreadSessionParams(opts: ThreadSessionOptions): ThreadSessionParams {
  const root = workspaceRoot(opts.cwd);
  const sandbox = withAutoCompact(sandboxParams(opts.mode, opts.network), opts.autoCompact);
  const serviceTier = codexServiceTier(opts.serviceTier);
  return {
    cwd: root,
    approvalPolicy: APPROVAL_POLICY,
    ...sandbox,
    developerInstructions: bridgeDeveloperInstructions({ cloudDocFolder: opts.cloudDocFolder, mcpServers: opts.mcpServers }),
    ...(opts.model ? { model: opts.model } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
  };
}

/**
 * Bridge-scoped developer guidance, injected ONLY into threads this bridge
 * starts (never the user's own codex usage). Teaches the two output conventions
 * the bridge renders: real-file image refs, and the ```feishu-card fence that
 * the bridge turns into a standalone Feishu card (see card/markdown-render). It
 * is purely additive (a developer message, not baseInstructions) so codex's
 * normal behavior is unchanged when neither convention is invoked.
 */
const BRIDGE_DEVELOPER_INSTRUCTIONS = [
  '你现在通过「飞书桥」与用户对话：你的回复会被渲染成飞书消息。请遵守两条输出约定。',
  '',
  '1) 图片：要配图时，用标准 Markdown 图片语法 ![说明](路径) 引用一个【真实存在】的图片，',
  '飞书桥会自动上传并在飞书里渲染。路径可以是相对当前工作目录的相对路径、工作目录内的绝对路径，',
  '或一个 http(s) 图片 URL。绝不要编造不存在的图片占位（例如写 ![管理台截图] 却没有对应文件）——',
  '没有真实图片就不要写图片语法。',
  '',
  '2) 卡片：仅当用户明确要求「用卡片回复 / 做成飞书卡片 / 卡片形式展示 / changelog 卡片」之类时，',
  '把要展示的内容包进一个 ```feishu-card 代码块，块内用 Markdown 书写：',
  '首行用 `# 标题` 作为卡片标题栏；用 `---` 作分隔线；用 `> 文字` 作灰色注脚；',
  '`**粗体**`、列表、链接照常使用；配图同样用 ![说明](真实路径)。',
  '不要手写飞书卡片的 JSON。普通问答正常回复即可，只有用户要卡片时才用 ```feishu-card 代码块。',
].join('\n');

export function bridgeDeveloperInstructions(opts: { cloudDocFolder?: CloudDocFolder; mcpServers?: McpServerConfig[] } = {}): string {
  const folder = opts.cloudDocFolder;
  const sections = [BRIDGE_DEVELOPER_INSTRUCTIONS];
  if (folder?.token) {
    const createAs = folder.createAs ?? 'user';
    sections.push(
      [
        '3) 飞书云文档：当用户要求创建、输出、保存飞书云文档时，默认保存到当前会话配置的云空间文件夹。',
        `默认 folder_token：${folder.token}`,
        folder.url ? `文件夹链接：${folder.url}` : '',
        `创建文档时优先使用：lark-cli docs +create --api-version v2 --as ${createAs} --parent-token ${folder.token} --content '<title>标题</title><p>内容</p>'`,
        '除非用户本轮明确指定其它位置，不要改用 my_library 或其它父目录。',
        '如果 lark-cli 权限不足或目录不可访问，直接说明需要为当前 lark-cli 用户授权或给该文件夹授权。',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  if ((opts.mcpServers ?? []).some((s) => s.enabled !== false)) {
    sections.push(FOOD_MCP_DEVELOPER_INSTRUCTIONS);
  }
  return sections.join('\n\n');
}

const FOOD_MCP_DEVELOPER_INSTRUCTIONS = [
  '3) 餐饮 MCP：当前项目可能启用了瑞幸咖啡 / 麦当劳 MCP。',
  '可以用 MCP 查询地址、门店、菜单、商品、优惠、配送/自提信息和预览订单。',
  '创建订单前必须先向用户复述：品牌、门店或配送地址、商品、数量、规格、优惠、预计金额、取餐/配送方式，并等待用户明确确认。',
  '不要替用户支付。MCP 返回支付链接或待支付订单时，只把支付入口交给用户本人处理。',
  '不要输出、保存或转述任何 MCP Token、Authorization header 或环境变量值。',
].join('\n');
/** Hard ceiling on a history read so a wedged codex can't hang the resume card. */
const READ_HISTORY_TIMEOUT_MS = 20_000;
const COMPACT_TIMEOUT_MS = 120_000;

/** Reject `p` if it hasn't settled within `ms` (the timer never keeps the event
 * loop alive past resolution). */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function toUserInput(input: AgentInput): unknown[] {
  const out: unknown[] = [];
  if (input.text) out.push({ type: 'text', text: input.text, text_elements: [] });
  for (const path of input.images ?? []) out.push({ type: 'localImage', path });
  return out;
}

class CodexThread implements AgentThread {
  private currentTurnId: string | undefined;

  constructor(
    private readonly client: AppServerClient,
    readonly codexThreadId: string,
    private model: string | undefined,
    private effort: ReasoningEffort | undefined,
    private serviceTier: ServiceTier | undefined,
  ) {}

  runStreamed(input: AgentInput, turn?: TurnOptions): AgentRun {
    const self = this;
    this.currentTurnId = undefined;
    // Per-turn overrides persist for subsequent turns (matches turn/start semantics).
    if (turn?.model) this.model = turn.model;
    if (turn?.effort) this.effort = turn.effort;
    if (turn?.serviceTier) this.serviceTier = turn.serviceTier;
    async function* gen(): AsyncGenerator<AgentEvent> {
      const params: Record<string, unknown> = {
        threadId: self.codexThreadId,
        input: toUserInput(input),
      };
      if (self.model) params.model = self.model;
      if (self.effort) params.effort = self.effort;
      const serviceTier = codexServiceTier(self.serviceTier);
      if (serviceTier !== undefined) params.serviceTier = serviceTier;

      // turn/start stays in flight for the whole turn (events arrive via
      // notifications), so we can't await it up front. But if it *rejects* —
      // bad params, thread gone, auth failure — codex emits no notification
      // that maps to done/error, so the stream loop below would block until the
      // idle watchdog fires and the user sees a bogus "已超时" instead of the
      // real cause. Race the rejection against the stream and surface it. (A
      // clean child exit closes the stream on its own, ending the loop.)
      let startError: Error | undefined;
      const startFailed: Promise<'start-failed'> = new Promise((resolve) => {
        self.client.request('turn/start', params).then(undefined, (err: unknown) => {
          startError = err instanceof Error ? err : new Error(String(err));
          log.fail('agent', startError, { phase: 'turn/start' });
          resolve('start-failed');
        });
      });

      const stream = self.client.stream()[Symbol.asyncIterator]();
      while (true) {
        const step = await Promise.race([stream.next(), startFailed]);
        if (step === 'start-failed') {
          yield { type: 'error', message: startError?.message ?? 'turn/start 请求失败', willRetry: false };
          return;
        }
        if (step.done) return;
        const ev = mapNotification(step.value);
        if (!ev) continue;
        if (ev.type === 'turn_started') self.currentTurnId = ev.turnId;
        yield ev;
        if (ev.type === 'done') return;
        if (ev.type === 'error' && !ev.willRetry) return;
      }
    }
    return { events: gen(), turnId: () => self.currentTurnId };
  }

  async steer(input: AgentInput, expectedTurnId: string): Promise<void> {
    await this.client.request('turn/steer', {
      threadId: this.codexThreadId,
      expectedTurnId,
      input: toUserInput(input),
    });
  }

  async abort(turnId: string): Promise<void> {
    await this.client.request('turn/interrupt', { threadId: this.codexThreadId, turnId });
  }

  async compact(): Promise<CompactResult> {
    let startError: Error | undefined;
    const startFailed: Promise<'start-failed'> = new Promise((resolve) => {
      this.client.request('thread/compact/start', { threadId: this.codexThreadId }).then(undefined, (err: unknown) => {
        startError = err instanceof Error ? err : new Error(String(err));
        log.fail('agent', startError, { phase: 'thread/compact/start' });
        resolve('start-failed');
      });
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout: Promise<'timeout'> = new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout('timeout'), COMPACT_TIMEOUT_MS);
    });

    const stream = this.client.stream()[Symbol.asyncIterator]();
    let compacted = false;
    let usage: CompactResult['usage'] = null;
    try {
      while (true) {
        const step = await Promise.race([stream.next(), startFailed, timeout]);
        if (step === 'start-failed') throw startError ?? new Error('thread/compact/start 请求失败');
        if (step === 'timeout') throw new Error(`压缩超时（Codex 未在 ${COMPACT_TIMEOUT_MS / 1000}s 内完成）`);
        if (step.done) break;
        const ev = mapNotification(step.value);
        if (!ev) continue;
        if (ev.type === 'context_usage') usage = { usedTokens: ev.usedTokens, contextWindow: ev.contextWindow };
        else if (ev.type === 'context_compacted') compacted = true;
        else if (ev.type === 'error' && !ev.willRetry) throw new Error(ev.message);
        else if (ev.type === 'done') break;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    return { compacted, usage };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export class CodexAppServerBackend implements AgentBackend {
  readonly id = 'codex-appserver';
  readonly displayName = 'Codex (app-server)';
  private modelCache: ModelInfo[] | null = null;

  async isAvailable(): Promise<boolean> {
    const bin = resolveCodexBin();
    return bin !== null && codexVersion(bin) !== null;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache) return this.modelCache;
    const bin = resolveCodexBin();
    if (!bin) return STATIC_MODELS;
    const client = new AppServerClient({ bin, cwd: process.cwd(), clientName: 'feishu-codex-bridge-models' });
    try {
      await client.connect();
      const res = await client.request<{ data?: RawModel[] }>('model/list', { limit: 50 });
      const models = (res.data ?? []).map(mapModel);
      this.modelCache = models.length ? models : STATIC_MODELS;
      return this.modelCache;
    } catch (err) {
      log.fail('agent', err, { phase: 'model/list' });
      return STATIC_MODELS;
    } finally {
      await client.close();
    }
  }

  async listThreads(cwd: string, limit = 15): Promise<ThreadSummary[]> {
    const bin = resolveCodexBin();
    if (!bin) return [];
    const client = new AppServerClient({ bin, cwd, clientName: 'feishu-codex-bridge-threads' });
    try {
      await client.connect();
      const res = await client.request<{ data?: RawThread[] }>('thread/list', {
        cwd,
        limit,
        sortKey: 'created_at',
        sortDirection: 'desc',
      });
      return (res.data ?? [])
        .filter((t) => !t.ephemeral)
        .map((t) => ({
          codexThreadId: t.id,
          preview: t.preview ?? '',
          createdAt: t.createdAt ?? 0,
          updatedAt: t.updatedAt ?? t.createdAt ?? 0,
          name: t.name ?? undefined,
        }));
    } catch (err) {
      log.fail('agent', err, { phase: 'thread/list' });
      return [];
    } finally {
      await client.close();
    }
  }

  async readHistory(cwd: string, codexThreadId: string, maxTurns = 10): Promise<ThreadHistory> {
    const empty: ThreadHistory = { turns: [], totalTurns: 0 };
    const bin = resolveCodexBin();
    if (!bin) return empty;
    // Short-lived client (same spawn→connect→request→close shape as listThreads).
    // thread/read does NOT start a turn or load the thread live — it just reads
    // the rollout, so there's no process to keep and no token cost. The session
    // is resumed lazily on the topic's first message via resolveThread.
    const client = new AppServerClient({ bin, cwd, clientName: 'feishu-codex-bridge-history' });
    try {
      // Bound the whole connect+read: if codex hangs, time out → catch → finally
      // close() (which SIGKILLs the child), so no orphan and the card resolves.
      const read = (async () => {
        await client.connect();
        return client.request<{ thread: Thread }>('thread/read', { threadId: codexThreadId, includeTurns: true });
      })();
      read.catch(() => undefined); // close() may reject this late; swallow it
      const res = await withDeadline(read, READ_HISTORY_TIMEOUT_MS, 'thread/read');
      const thread = res.thread;
      const all = (Array.isArray(thread?.turns) ? thread.turns : [])
        .map(mapTurn)
        .filter((t) => t.userText || t.assistantText || t.tools.length);
      const totalTurns = all.length;
      const turns = totalTurns > maxTurns ? all.slice(totalTurns - maxTurns) : all;
      return {
        turns,
        totalTurns,
        name: thread?.name ?? undefined,
        preview: thread?.preview ?? undefined,
        createdAt: thread?.createdAt,
        updatedAt: thread?.updatedAt,
      };
    } catch (err) {
      log.fail('agent', err, { phase: 'thread/read', codexThreadId });
      return empty;
    } finally {
      await client.close();
    }
  }

  async startThread(opts: StartThreadOptions): Promise<AgentThread> {
    const params = buildThreadSessionParams(opts);
    const client = await this.spawn(params.cwd, opts.mcpServers);
    const res = await client.request<{ thread: { id: string } }>('thread/start', {
      ...params,
    });
    return new CodexThread(client, res.thread.id, opts.model, opts.effort, opts.serviceTier);
  }

  async resumeThread(opts: ResumeThreadOptions): Promise<AgentThread> {
    const params = buildThreadSessionParams(opts);
    const client = await this.spawn(params.cwd, opts.mcpServers);
    const res = await client.request<{ thread: { id: string } }>('thread/resume', {
      threadId: opts.codexThreadId,
      ...params,
    });
    return new CodexThread(client, res.thread.id, opts.model, opts.effort, opts.serviceTier);
  }

  private async spawn(cwd: string, mcpServers?: McpServerConfig[]): Promise<AppServerClient> {
    const bin = resolveCodexBin();
    if (!bin) throw new Error('codex CLI not found (set CODEX_BIN or install @openai/codex)');
    const client = new AppServerClient({ bin, cwd, mcpServers });
    await client.connect();
    return client;
  }
}

/** Skip codex's injected boilerplate so it never shows as a "user message". */
function isBoilerplateUserText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<environment_context>') || t.startsWith('# AGENTS.md instructions');
}

/**
 * Fold one codex {@link Turn}'s items into a renderable {@link HistoryTurn}.
 * Mirrors event-map.ts's item handling but also captures `userMessage` (the
 * stream path never emits the user's own input, so that case is unique here).
 */
function mapTurn(turn: Turn): HistoryTurn {
  const userParts: string[] = [];
  const assistantParts: string[] = [];
  const reasoningParts: string[] = [];
  const tools: HistoryTool[] = [];
  for (const item of (turn.items ?? []) as ThreadItem[]) {
    switch (item.type) {
      case 'userMessage': {
        const text = item.content
          .map((c) => (c.type === 'text' ? c.text : c.type === 'mention' ? `@${c.name}` : ''))
          .join('')
          .trim();
        if (text && !isBoilerplateUserText(text)) userParts.push(text);
        break;
      }
      case 'agentMessage':
        if (item.text.trim()) assistantParts.push(item.text);
        break;
      case 'reasoning': {
        const r = (item.content.length ? item.content : item.summary).join('\n').trim();
        if (r) reasoningParts.push(r);
        break;
      }
      case 'commandExecution':
        tools.push({
          title: item.command,
          output: item.aggregatedOutput ?? undefined,
          exitCode: item.exitCode,
          failed: item.status === 'failed' || item.status === 'declined' || (item.exitCode ?? 0) !== 0,
        });
        break;
      case 'fileChange':
        tools.push({ title: '编辑文件', failed: item.status === 'failed' || item.status === 'declined' });
        break;
      case 'webSearch':
        tools.push({ title: `联网搜索：${item.query}` });
        break;
      case 'mcpToolCall':
        tools.push({ title: `MCP：${item.server} / ${item.tool}`, failed: item.status === 'failed' || Boolean(item.error) });
        break;
      case 'dynamicToolCall':
        tools.push({ title: item.namespace ? `工具调用：${item.namespace} / ${item.tool}` : `工具调用：${item.tool}`, failed: item.status === 'failed' || item.success === false });
        break;
      // plan / contextCompaction / review-mode / image* — omitted from the digest
      default:
        break;
    }
  }
  return {
    userText: userParts.join('\n\n'),
    assistantText: assistantParts.join('\n\n'),
    reasoning: reasoningParts.join('\n\n'),
    tools,
    startedAt: turn.startedAt ?? undefined,
  };
}

interface RawThread {
  id: string;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  name?: string | null;
  ephemeral?: boolean;
}

interface RawModel {
  id: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: ReasoningEffort }[];
  defaultReasoningEffort?: ReasoningEffort;
  additionalSpeedTiers?: string[];
  serviceTiers?: ServiceTierInfo[];
}

function mapModel(m: RawModel): ModelInfo {
  const serviceTiers = m.serviceTiers?.length
    ? m.serviceTiers
    : (m.additionalSpeedTiers ?? []).map((id) => ({ id, name: id, description: '' }));
  return {
    id: m.id,
    displayName: m.displayName ?? m.id,
    description: m.description ?? '',
    hidden: m.hidden ?? false,
    isDefault: m.isDefault ?? false,
    supportedEfforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
    defaultEffort: m.defaultReasoningEffort ?? 'medium',
    serviceTiers,
  };
}

const STATIC_MODELS: ModelInfo[] = [
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    description: '默认模型',
    hidden: false,
    isDefault: true,
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    serviceTiers: [
      { id: 'standard', name: '标准', description: '' },
      { id: 'fast', name: '快速', description: '' },
    ],
  },
];
