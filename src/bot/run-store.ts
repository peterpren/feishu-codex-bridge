import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../config/paths';
import type { Block, RunState, Terminal } from '../card/run-state';

const SCHEMA_VERSION = 1 as const;
const MAX_TEXT_CHARS = 900;
const MAX_PREVIEW_CHARS = 160;

export type RunRecordEvent = 'started' | 'finished';
export type RunRecordStatus = 'running' | 'completed' | 'error' | 'interrupted' | 'idle_timeout' | 'bridge_error';
export type RunFailureClass =
  | 'codex_turn_error'
  | 'bridge_error'
  | 'idle_timeout'
  | 'user_interrupted'
  | 'none';

export interface RunRecordContext {
  runId: string;
  chatId: string;
  replyToMessageId: string;
  feishuThreadId?: string;
  cardMessageId?: string;
  codexThreadId: string;
  codexTurnId?: string;
  projectName?: string;
  cwd: string;
  topicTitle?: string;
  requesterOpenId?: string;
  requesterName?: string;
  promptPreview?: string;
  startedAt: string;
}

export interface RunRecordEvidence {
  errorMessage?: string;
  failedToolTitle?: string;
  failedToolExitCode?: number | null;
  failedToolOutput?: string;
  idleTimeoutMinutes?: number;
  logFile?: string;
}

export interface RunRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  event: RunRecordEvent;
  runId: string;
  status: RunRecordStatus;
  ok: boolean;
  chatId: string;
  replyToMessageId: string;
  feishuThreadId?: string;
  cardMessageId?: string;
  codexThreadId: string;
  codexTurnId?: string;
  projectName?: string;
  cwd: string;
  topicTitle?: string;
  requesterOpenId?: string;
  requesterName?: string;
  promptPreview?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  failureClass?: RunFailureClass;
  mainReason?: string;
  evidence?: RunRecordEvidence;
  metrics?: {
    events?: number;
    textChars?: number;
    failedTools?: number;
  };
}

export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function runRecordsFileFor(date: Date, dir = paths.runsDir): string {
  return join(dir, `${date.toISOString().slice(0, 10)}.jsonl`);
}

export async function appendRunRecord(record: RunRecord, opts: { dir?: string } = {}): Promise<string> {
  const file = runRecordsFileFor(new Date(record.startedAt), opts.dir);
  await mkdir(opts.dir ?? paths.runsDir, { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  return file;
}

export function startedRunRecord(ctx: RunRecordContext): RunRecord {
  const record: RunRecord = {
    schemaVersion: SCHEMA_VERSION,
    event: 'started',
    status: 'running',
    ok: false,
    ...ctx,
    promptPreview: truncate(ctx.promptPreview, MAX_PREVIEW_CHARS),
  };
  return cleanRecord(record);
}

export function finishedRunRecord(
  ctx: RunRecordContext,
  input: {
    terminal: Terminal | 'bridge_error';
    endedAt: string;
    state?: RunState;
    bridgeError?: unknown;
    events?: number;
    textChars?: number;
  },
): RunRecord {
  const status = statusFromTerminal(input.terminal);
  const durationMs = Math.max(0, Date.parse(input.endedAt) - Date.parse(ctx.startedAt));
  const summary = summarizeFailure(input.terminal, input.state, input.bridgeError);
  const failedTools = countFailedTools(input.state);
  const record: RunRecord = {
    schemaVersion: SCHEMA_VERSION,
    event: 'finished',
    status,
    ok: status === 'completed',
    ...ctx,
    promptPreview: truncate(ctx.promptPreview, MAX_PREVIEW_CHARS),
    endedAt: input.endedAt,
    durationMs,
    failureClass: summary.failureClass,
    mainReason: summary.mainReason,
    evidence: summary.evidence,
    metrics: {
      events: input.events,
      textChars: input.textChars,
      failedTools,
    },
  };
  return cleanRecord(record);
}

function statusFromTerminal(terminal: Terminal | 'bridge_error'): RunRecordStatus {
  switch (terminal) {
    case 'done':
      return 'completed';
    case 'error':
      return 'error';
    case 'interrupted':
      return 'interrupted';
    case 'idle_timeout':
      return 'idle_timeout';
    case 'bridge_error':
      return 'bridge_error';
    case 'running':
      return 'running';
  }
}

function summarizeFailure(
  terminal: Terminal | 'bridge_error',
  state: RunState | undefined,
  bridgeError: unknown,
): { failureClass?: RunFailureClass; mainReason?: string; evidence?: RunRecordEvidence } {
  if (terminal === 'done') return { failureClass: 'none' };

  if (terminal === 'bridge_error') {
    const message = errorText(bridgeError);
    return {
      failureClass: 'bridge_error',
      mainReason: `Bridge 运行异常：${message}`,
      evidence: withLogFile({ errorMessage: message }),
    };
  }

  if (terminal === 'idle_timeout') {
    const minutes = state?.idleTimeoutMinutes;
    return {
      failureClass: 'idle_timeout',
      mainReason: `超过 ${minutes ?? '?'} 分钟没有收到输出，已自动中止`,
      evidence: withLogFile({ idleTimeoutMinutes: minutes }),
    };
  }

  if (terminal === 'interrupted') {
    if (state?.interruptedReason === 'shutdown') {
      return {
        failureClass: 'bridge_error',
        mainReason: '后台服务重启/关闭中断了本轮运行',
        evidence: withLogFile({}),
      };
    }
    return {
      failureClass: 'user_interrupted',
      mainReason: '用户点击终止按钮中止了本轮运行',
      evidence: withLogFile({}),
    };
  }

  const failed = lastFailedTool(state);
  const message = state?.errorMsg || failed?.tool.title || 'Codex turn 返回错误';
  return {
    failureClass: 'codex_turn_error',
    mainReason: `Codex 运行错误：${message}`,
    evidence: withLogFile({
      errorMessage: state?.errorMsg,
      failedToolTitle: failed?.tool.title,
      failedToolExitCode: failed?.tool.exitCode,
      failedToolOutput: truncate(failed?.tool.output, MAX_TEXT_CHARS),
    }),
  };
}

function lastFailedTool(state: RunState | undefined) {
  const tools = state?.blocks.filter(isFailedToolBlock) ?? [];
  return tools.length ? tools[tools.length - 1] : undefined;
}

function countFailedTools(state: RunState | undefined): number {
  return state?.blocks.filter(isFailedToolBlock).length ?? 0;
}

function isFailedToolBlock(block: Block): block is Extract<Block, { kind: 'tool' }> {
  return block.kind === 'tool' && block.tool.status === 'error';
}

function withLogFile(evidence: RunRecordEvidence): RunRecordEvidence {
  return {
    ...evidence,
    logFile: join(paths.appDir, 'logs', `${new Date().toISOString().slice(0, 10)}.log`),
  };
}

function errorText(err: unknown): string {
  if (err instanceof Error) return truncate(err.message, MAX_TEXT_CHARS) || 'unknown error';
  return truncate(String(err), MAX_TEXT_CHARS) || 'unknown error';
}

function truncate(input: string | undefined, max = MAX_TEXT_CHARS): string | undefined {
  if (!input) return undefined;
  const clean = input.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function cleanRecord<T extends object>(record: T): T {
  const obj = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) delete obj[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)) cleanRecord(value);
  }
  return record;
}
