import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/agent/types';
import { buildRunCard } from '../src/card/run-card';
import {
  initialState,
  markIdleTimeout,
  markInterrupted,
  reasoningContent,
  reduce,
  type Block,
  type RunState,
} from '../src/card/run-state';

function run(events: AgentEvent[]): RunState {
  let s = initialState;
  for (const ev of events) s = reduce(s, ev);
  return s;
}

/** Top-level body elements of a built run card. */
function bodyEls(card: unknown): Array<Record<string, unknown>> {
  return ((card as { body?: { elements?: Array<Record<string, unknown>> } }).body?.elements ?? []);
}

const texts = (s: RunState): string[] =>
  s.blocks.filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text').map((b) => b.content);
const tools = (s: RunState): Extract<Block, { kind: 'tool' }>[] =>
  s.blocks.filter((b): b is Extract<Block, { kind: 'tool' }> => b.kind === 'tool');

describe('reduce', () => {
  it('starts running with no blocks', () => {
    const s = run([]);
    expect(s.terminal).toBe('running');
    expect(s.blocks).toHaveLength(0);
  });

  it('accumulates text deltas per item, preserving first-seen order', () => {
    const s = run([
      { type: 'text_delta', itemId: 'a', delta: 'hello' },
      { type: 'text_delta', itemId: 'b', delta: 'second' },
      { type: 'text_delta', itemId: 'a', delta: ' world' },
      { type: 'done', turnId: 'turn-1' },
    ]);
    expect(texts(s)).toEqual(['hello world', 'second']);
    expect(s.terminal).toBe('done');
  });

  it('reconciles a streamed item with its completed text', () => {
    const s = run([
      { type: 'text_delta', itemId: 'a', delta: 'partial' },
      { type: 'text', itemId: 'a', text: 'final text' },
    ]);
    expect(texts(s)).toEqual(['final text']);
  });

  it('derives tool status from exit code', () => {
    const s = run([
      { type: 'tool_use', itemId: 'ok', title: 'npm test' },
      { type: 'tool_use', itemId: 'fail', title: 'npm run build' },
      { type: 'tool_result', itemId: 'ok', exitCode: 0 },
      { type: 'tool_result', itemId: 'fail', exitCode: 2 },
    ]);
    const t = tools(s);
    expect(t.map((b) => b.tool.status)).toEqual(['done', 'error']);
  });

  it('treats a missing exit code as success', () => {
    const s = run([
      { type: 'tool_use', itemId: 't1', title: 'custom tool' },
      { type: 'tool_result', itemId: 't1' },
    ]);
    expect(tools(s)[0]!.tool.status).toBe('done');
  });

  it('accumulates reasoning deltas and reconciles the final text', () => {
    const streaming = run([
      { type: 'thinking_delta', itemId: 'r', delta: 'think' },
      { type: 'thinking_delta', itemId: 'r', delta: 'ing' },
    ]);
    expect(reasoningContent(streaming)).toBe('thinking');
    expect(streaming.reasoningActive).toBe(true);

    const final = run([
      { type: 'thinking_delta', itemId: 'r', delta: 'partial' },
      { type: 'thinking', itemId: 'r', text: 'full reasoning' },
    ]);
    expect(reasoningContent(final)).toBe('full reasoning');
  });

  it('captures error terminal state', () => {
    const s = run([
      { type: 'text', itemId: 'm', text: 'hello' },
      { type: 'error', message: 'boom', willRetry: false },
    ]);
    expect(s.terminal).toBe('error');
    expect(s.errorMsg).toBe('boom');
  });

  it('captures context usage for the run card gauge', () => {
    const s = run([{ type: 'context_usage', usedTokens: 70, contextWindow: 100 }]);
    expect(s.usage).toEqual({ used: 70, window: 100 });
  });
});

describe('buildRunCard', () => {
  it('renders no header and streams while running', () => {
    const rs = run([{ type: 'text_delta', itemId: 'a', delta: 'hi' }]);
    const card = buildRunCard({ rs, cardKey: 'm1' }) as { header?: unknown; config: { streaming_mode?: boolean } };
    expect(card.header).toBeUndefined();
    expect(card.config.streaming_mode).toBe(true);
  });

  it('drops tool blocks when showTools is false', () => {
    const rs = run([
      { type: 'tool_use', itemId: 't1', title: 'npm test' },
      { type: 'text', itemId: 'm1', text: 'text only' },
      { type: 'done', turnId: 'turn-1' },
    ]);
    const json = JSON.stringify(buildRunCard({ rs, showTools: false }));
    expect(json).not.toContain('npm test');
    expect(json).toContain('text only');
  });

  it('renders tool detail in the expanded running panel', () => {
    const rs = run([{ type: 'tool_use', itemId: 'mcp-1', title: 'MCP：mcd-mcp / create_order', detail: '参数：{"sku":"burger"}' }]);
    const json = JSON.stringify(buildRunCard({ rs }));

    expect(json).toContain('MCP：mcd-mcp / create_order');
    expect(json).toContain('参数：{\\\"sku\\\":\\\"burger\\\"}');
  });
});

describe('buildRunCard — terminal collapse', () => {
  const fullRun = (): RunState =>
    run([
      { type: 'thinking', itemId: 'r', text: 'pondering' },
      { type: 'text', itemId: 'p1', text: 'preamble msg' },
      { type: 'tool_use', itemId: 't1', title: 'echo hi' },
      { type: 'tool_result', itemId: 't1', exitCode: 0, output: 'out' },
      { type: 'text', itemId: 'a', text: 'FINAL ANSWER' },
      { type: 'done', turnId: 'turn-1' },
    ]);

  it('folds process into one collapsed panel and surfaces only the final answer', () => {
    const card = buildRunCard({ rs: fullRun() });
    const els = bodyEls(card);
    expect(els).toHaveLength(2);

    const [panel, answer] = els;
    // first element: a single collapsed process panel holding reasoning + tools + preamble
    expect(panel!.tag).toBe('collapsible_panel');
    expect(panel!.expanded).toBe(false);
    const panelJson = JSON.stringify(panel);
    expect(panelJson).toContain('pondering');
    expect(panelJson).toContain('preamble msg');
    expect(panelJson).toContain('echo hi');
    // the final answer must NOT be inside the folded panel
    expect(panelJson).not.toContain('FINAL ANSWER');

    // second element: the final answer, plain markdown, outside the panel
    expect(answer!.tag).toBe('markdown');
    expect(answer!.content).toBe('FINAL ANSWER');
  });

  it('turns off streaming on a terminal card', () => {
    const card = buildRunCard({ rs: fullRun() }) as { config: { streaming_mode?: boolean } };
    expect(card.config.streaming_mode).toBeUndefined();
  });

  it('keeps a partial answer above the note when interrupted', () => {
    let rs = run([
      { type: 'tool_use', itemId: 't1', title: 'long task' },
      { type: 'tool_result', itemId: 't1', exitCode: 0 },
      { type: 'text_delta', itemId: 'a', delta: 'partial ans' },
    ]);
    rs = markInterrupted(rs);
    const els = bodyEls(buildRunCard({ rs, cardKey: 'm1' }));
    // process panel, partial answer, interrupted note — and no ⏹ button
    expect(els.some((e) => e.tag === 'collapsible_panel')).toBe(true);
    expect(els.some((e) => e.tag === 'markdown' && e.content === 'partial ans')).toBe(true);
    expect(JSON.stringify(els)).toContain('已被中断');
    expect(JSON.stringify(els)).not.toContain('终止');
  });

  it('explains shutdown-interrupted runs instead of implying a user stop', () => {
    let rs = run([{ type: 'text_delta', itemId: 'a', delta: 'partial ans' }]);
    rs = markInterrupted(rs, 'shutdown');
    const json = JSON.stringify(bodyEls(buildRunCard({ rs, cardKey: 'm1' })));

    expect(json).toContain('后台服务重启/关闭');
    expect(json).toContain('请重新发送指令');
    expect(json).not.toContain('⏹ 已被中断');
    expect(json).not.toContain('终止');
  });

  it('folds process and shows the error note when the agent fails', () => {
    const rs = run([
      { type: 'tool_use', itemId: 't1', title: 'do thing' },
      { type: 'tool_result', itemId: 't1', exitCode: 0 },
      { type: 'error', message: 'boom', willRetry: false },
    ]);
    const json = JSON.stringify(bodyEls(buildRunCard({ rs })));
    expect(json).toContain('collapsible_panel');
    expect(json).toContain('agent 失败：boom');
  });

  it('shows the idle-timeout note', () => {
    let rs = run([{ type: 'tool_use', itemId: 't1', title: 'hang' }]);
    rs = markIdleTimeout(rs, 7);
    expect(JSON.stringify(bodyEls(buildRunCard({ rs })))).toContain('7 分钟无响应');
  });

  it('reports no content when a done run produced no text', () => {
    const rs = run([
      { type: 'tool_use', itemId: 't1', title: 'only tool' },
      { type: 'tool_result', itemId: 't1', exitCode: 0 },
      { type: 'done', turnId: 'turn-1' },
    ]);
    const els = bodyEls(buildRunCard({ rs }));
    expect(els.some((e) => e.tag === 'collapsible_panel')).toBe(true);
    expect(JSON.stringify(els)).toContain('未返回内容');
  });
});
