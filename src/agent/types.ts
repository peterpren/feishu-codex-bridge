/**
 * Backend-agnostic agent interface. The codex app-server implementation lives
 * in ./codex-appserver; this layer lets the bot orchestrator stay decoupled
 * from codex internals (and lets us swap to exec / SDK / remote later).
 */

import type { CloudDocFolder } from '../project/registry';

/**
 * Keep this in step with the app-server's model/list response. New Codex
 * models can expose higher effort tiers before the generated protocol types
 * in this repository are refreshed, so the Bridge must preserve them instead
 * of silently downgrading a user's selection.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type ServiceTier = string;

export interface ServiceTierInfo {
  id: ServiceTier;
  name: string;
  description: string;
}

/**
 * Permission tier for a project's codex sandbox:
 *   'qa'    — read-only, confined to the project folder (cwd). External-group Q&A.
 *   'write' — read/write, confined to the project folder.
 *   'full'  — danger-full-access (whole machine + network); the historical default.
 * 'qa'/'write' are enforced via a custom codex permissions profile (see backend),
 * whose read-confinement codex can enforce on macOS (Seatbelt) and native Windows
 * (restricted token); on Linux/WSL it can't, so those tiers fail-closed there.
 */
export type PermissionMode = 'qa' | 'write' | 'full';

export interface AgentInput {
  text?: string;
  /** absolute local image paths (codex reads them directly) */
  images?: string[];
}

export interface ModelInfo {
  id: string;
  displayName: string;
  description: string;
  supportedEfforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort;
  serviceTiers: ServiceTierInfo[];
  isDefault: boolean;
  hidden: boolean;
}

/** A past codex thread, for the "恢复历史会话" picker (from thread/list). */
export interface ThreadSummary {
  /** codex thread id (pass to resumeThread) */
  codexThreadId: string;
  /** first user message preview */
  preview: string;
  /** unix seconds */
  createdAt: number;
  updatedAt: number;
  /** optional user-facing title */
  name?: string;
}

/** One past tool/command/file/web call in a resumed session's transcript. */
export interface HistoryTool {
  /** short header — the shell command, or a label like '编辑文件' / '联网搜索' */
  title: string;
  /** aggregated stdout/stderr, if any (renderer truncates) */
  output?: string;
  /** process exit code for command executions */
  exitCode?: number | null;
  /** the call errored / was declined */
  failed?: boolean;
}

/** One user→assistant exchange in a resumed session (a codex Turn). */
export interface HistoryTurn {
  /** the user's prompt for this turn ('' for a tool-only / boilerplate turn) */
  userText: string;
  /** the assistant's reply (agent messages concatenated) */
  assistantText: string;
  /** the assistant's reasoning, if surfaced ('' if none) */
  reasoning: string;
  /** tool/command/file/web calls in this turn, in arrival order */
  tools: HistoryTool[];
  /** unix seconds when the turn started, if known */
  startedAt?: number;
}

/**
 * A resumed codex thread's transcript, for the "恢复历史会话" history card —
 * normalized off the app-server `thread/read` (includeTurns) turns so the card
 * layer never touches codex protocol shapes.
 */
export interface ThreadHistory {
  /** turns kept for display, oldest→newest (the most recent `turns.length`) */
  turns: HistoryTurn[];
  /** total non-empty turns in the thread before truncation (>= turns.length) */
  totalTurns: number;
  /** user-facing thread title, if set */
  name?: string;
  /** first user message preview */
  preview?: string;
  /** unix seconds */
  createdAt?: number;
  updatedAt?: number;
}

/** Normalized stream events, mapped from app-server notifications. */
export type AgentEvent =
  | { type: 'system'; threadId: string }
  | { type: 'turn_started'; turnId: string }
  | { type: 'text_delta'; itemId: string; delta: string }
  | { type: 'text'; itemId: string; text: string }
  | { type: 'thinking_delta'; itemId: string; delta: string }
  | { type: 'thinking'; itemId: string; text: string }
  | { type: 'tool_use'; itemId: string; title: string; detail?: string }
  | { type: 'tool_result'; itemId: string; output?: string; exitCode?: number | null }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'context_usage'; usedTokens: number; contextWindow: number | null }
  | { type: 'context_compacted' }
  | { type: 'done'; turnId: string }
  | { type: 'error'; message: string; willRetry: boolean };

export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  /** current turn id, available after `turn_started` */
  turnId(): string | undefined;
}

export interface CompactResult {
  compacted: boolean;
  usage: { usedTokens: number; contextWindow: number | null } | null;
}

/** Per-turn overrides (apply to this turn and persist for subsequent turns). */
export interface TurnOptions {
  model?: string;
  effort?: ReasoningEffort;
  serviceTier?: ServiceTier;
}

export interface AgentThread {
  readonly codexThreadId: string;
  /** start a turn, streaming events until turn completion/error */
  runStreamed(input: AgentInput, turn?: TurnOptions): AgentRun;
  /** inject input into the in-flight turn (引导) */
  steer(input: AgentInput, expectedTurnId: string): Promise<void>;
  /** interrupt the in-flight turn (watchdog 中止) */
  abort(turnId: string): Promise<void>;
  /** summarize older context and resolve after the background compaction finishes */
  compact(): Promise<CompactResult>;
  /** terminate the underlying app-server process */
  close(): Promise<void>;
}

export interface McpServerConfig {
  name: string;
  url: string;
  bearerTokenEnvVar?: string;
  bearerTokenSecretId?: string;
  enabled?: boolean;
  title?: string;
}

export interface StartThreadOptions {
  cwd: string;
  model?: string;
  effort?: ReasoningEffort;
  serviceTier?: ServiceTier;
  /** permission tier; undefined → 'full' (preserves legacy danger-full-access) */
  mode?: PermissionMode;
  /** let the sandboxed agent's shell reach the network (qa/write only; full is
   * always networked). Default false. */
  network?: boolean;
  /** default Feishu Drive folder for docs created by this thread */
  cloudDocFolder?: CloudDocFolder;
  /** Codex built-in auto context compaction. Undefined = keep Codex default. */
  autoCompact?: boolean;
  /** Project-scoped MCP servers injected into this app-server process. */
  mcpServers?: McpServerConfig[];
}

export interface ResumeThreadOptions extends StartThreadOptions {
  codexThreadId: string;
}

export interface AgentBackend {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  listModels(): Promise<ModelInfo[]>;
  /** recent codex threads under `cwd`, newest first (for resume picker) */
  listThreads(cwd: string, limit?: number): Promise<ThreadSummary[]>;
  /**
   * A past thread's transcript for the resume history card — reads it via
   * `thread/read` (includeTurns) WITHOUT starting a turn or holding the session
   * live. Keeps the last `maxTurns` turns; never throws (returns empty on fail).
   */
  readHistory(cwd: string, codexThreadId: string, maxTurns?: number): Promise<ThreadHistory>;
  startThread(opts: StartThreadOptions): Promise<AgentThread>;
  resumeThread(opts: ResumeThreadOptions): Promise<AgentThread>;
}
