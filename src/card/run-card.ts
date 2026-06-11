import {
  actions,
  button,
  card,
  collapsiblePanel,
  collapsiblePanelEl,
  md,
  mdStream,
  noteMd,
  type CardElement,
  type CardObject,
} from './cards';
import {
  reasoningContent,
  type Block,
  type FooterStatus,
  type RunState,
  type ToolEntry,
} from './run-state';
import { renderRichText } from './markdown-render';
import { toolBodyMd, toolHeaderText } from './tool-render';
import { runCardGauge } from './context-gauge';

function gaugeEl(state: RunState): CardElement | null {
  return state.usage ? runCardGauge(state.usage.used, state.usage.window) : null;
}

/** Action ids for the in-topic run card. */
export const RC = {
  stop: 'run.stop',
} as const;

/**
 * Stable element_id of the streamed answer markdown while RUNNING. The answer
 * text is pushed to this element via cardkit.v1.cardElement.content for the
 * native typewriter (see {@link ../card/run-card-stream}); everything else
 * (reasoning / tools / footer) rides whole-card updates. Must be stable across
 * re-renders so the typewriter sees an append-only prefix.
 */
export const ANSWER_EID = 'answer';

const REASONING_MAX = 1500;
/** Collapse N tool calls into one summary panel at/above this count. */
const COLLAPSE_TOOL_THRESHOLD = 3;
/**
 * Serialized-size budget for the terminal "过程" panel's body. Nesting every
 * reasoning/tool panel under one collapsible_panel can push that single element
 * past Feishu's ~30KB per-element limit and 400 the card; over budget we degrade
 * tool blocks to header-only summaries (no output bodies). Mirrors the
 * history-card budget guard. Kept under 30KB for wrapper/answer headroom.
 */
const PROCESS_BODY_BUDGET = 22_000;

/** Routing + render inputs for one run card. */
export interface RunCardState {
  rs: RunState;
  /** identity for ⏹ stop routing (the card's own messageId) */
  cardKey?: string;
  /** topic thread id (known after the topic is created) */
  threadId?: string;
  /** who started this run — only they (or an admin) may ⏹ it (design §5) */
  requesterOpenId?: string;
  /** drop tool blocks from the render (pref) */
  showTools?: boolean;
  /** `![](src) → image_key` for the final answer's images (populated at terminal
   * after upload; absent while streaming, so refs show as text until then). */
  images?: ReadonlyMap<string, string>;
}

/**
 * Render the run card from its structured state (no header; reasoning + tool
 * calls as collapsible panels; text streams in order). Modeled on
 * zara/feishu-claude-code-bridge `src/card/run-renderer.ts`. While running, each
 * whole-card update instantly shows the current full text (no typewriter — see
 * the streaming_mode note in {@link ../card/cards}); growth tracks the model in
 * throttled chunks.
 *
 * Two layouts: while RUNNING everything streams expanded (reasoning, tools and
 * preamble text inline) so the user watches progress live; once TERMINAL the
 * whole "process" (reasoning + tools + every text block except the final one)
 * folds into a single collapsed panel and only the final answer stays open —
 * see {@link renderTerminal}.
 */
export function buildRunCard(rc: RunCardState): CardObject {
  const state = rc.rs;
  const running = state.terminal === 'running';
  const elements = running ? renderRunning(state, rc) : renderTerminal(state, rc);
  return card(elements, { streaming: running, summary: summaryText(state) });
}

/**
 * Live layout: reasoning panel, then tool panels, then ONE streamed answer
 * element, then footer + ⏹. Text blocks are concatenated into a single
 * {@link mdStream} element ({@link ANSWER_EID}) so the answer can be driven by
 * the element-level typewriter (cardElement.content) — that needs one stable,
 * append-only text element, which is incompatible with interleaving text and
 * tool panels. Tools therefore render above the answer (matching the terminal
 * fold), not inline between text runs.
 */
function renderRunning(state: RunState, rc: RunCardState): CardElement[] {
  const elements: CardElement[] = [];

  const reasoning = reasoningContent(state);
  if (reasoning) elements.push(reasoningPanel(reasoning, state.reasoningActive));

  const showTools = rc.showTools !== false;
  const tools: ToolEntry[] = [];
  const textParts: string[] = [];
  for (const b of state.blocks) {
    if (b.kind === 'tool') {
      if (showTools) tools.push(b.tool);
    } else if (b.content.trim()) {
      textParts.push(b.content);
    }
  }
  if (tools.length > 0) elements.push(...renderToolGroup(tools, false));

  // Single streamed answer element. Only emitted once there's text, so its first
  // appearance is one whole-card update that establishes the element; subsequent
  // growth streams via cardElement.content. Stable element_id ⇒ append-only prefix.
  const answer = textParts.join('\n\n');
  if (answer) elements.push(mdStream(answer, ANSWER_EID));

  if (state.footer) elements.push(footerStatus(state.footer));
  if (rc.cardKey) elements.push(actions([button('⏹ 终止', { a: RC.stop, m: rc.cardKey }, 'danger')]));
  const gauge = gaugeEl(state);
  if (gauge) elements.push(gauge);
  return elements;
}

/**
 * Terminal layout: fold the process (reasoning + tools + every non-final text
 * block) into one collapsed panel and surface only the final answer below it.
 * The final answer is the last non-empty text block (codex emits preamble /
 * progress messages before the real reply). Interrupt / error / timeout still
 * land here — whatever process happened folds away and the status note shows;
 * a partial answer (if any text streamed) stays visible above the note.
 */
function renderTerminal(state: RunState, rc: RunCardState): CardElement[] {
  const elements: CardElement[] = [];

  const answerIdx = lastTextIndex(state.blocks);
  const answer = answerIdx >= 0 ? (state.blocks[answerIdx] as Extract<Block, { kind: 'text' }>).content.trim() : '';

  // Everything except the final answer block is "process". (A block after the
  // answer can only be a trailing tool call — keep it folded with the rest.)
  const processBlocks = state.blocks.filter((_, i) => i !== answerIdx);
  const blocks = rc.showTools === false ? processBlocks.filter((b) => b.kind !== 'tool') : processBlocks;
  const reasoning = reasoningContent(state);
  const processEls = buildProcessBody(reasoning, blocks);
  if (processEls.length > 0) {
    const toolCount = blocks.reduce((n, b) => (b.kind === 'tool' ? n + 1 : n), 0);
    elements.push(
      collapsiblePanelEl({
        title: processTitle(Boolean(reasoning), toolCount),
        expanded: false,
        border: 'grey',
        elements: processEls,
      }),
    );
  }

  // Terminal answer: split out uploaded images into img elements and drop any
  // ```feishu-card fence (it's hoisted into a standalone clean card). Streaming
  // still renders plain md (renderRunning) — images aren't uploaded until now.
  if (answer) elements.push(...renderRichText(answer, rc.images));

  if (state.terminal === 'interrupted') {
    elements.push(
      noteMd(
        state.interruptedReason === 'shutdown'
          ? '_后台服务重启/关闭，本轮已中断。请重新发送指令。_'
          : '_⏹ 已被中断_',
      ),
    );
  } else if (state.terminal === 'idle_timeout') {
    elements.push(noteMd(`_⏱ ${state.idleTimeoutMinutes ?? 0} 分钟无响应，已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  } else if (state.terminal === 'done' && !answer) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  const gauge = gaugeEl(state);
  if (gauge) elements.push(gauge);
  return elements;
}

/** Index of the last non-empty text block (the final answer), or -1 if none. */
function lastTextIndex(blocks: Block[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.kind === 'text' && b.content.trim()) return i;
  }
  return -1;
}

/**
 * Body of the terminal "过程" panel. Renders reasoning + interleaved text/tool
 * groups (tools finalized). Guards the ~30KB per-element limit: if the rich body
 * (with tool-output bodies) exceeds {@link PROCESS_BODY_BUDGET}, rebuild it with
 * every tool group degraded to a header-only summary.
 */
function buildProcessBody(reasoning: string, blocks: Block[]): CardElement[] {
  const rich = processElements(reasoning, blocks, false);
  if (estimateSize(rich) <= PROCESS_BODY_BUDGET) return rich;
  return processElements(reasoning, blocks, true);
}

function processElements(reasoning: string, blocks: Block[], compactTools: boolean): CardElement[] {
  const out: CardElement[] = [];
  if (reasoning) out.push(reasoningPanel(reasoning, false));
  for (const group of groupBlocks(blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) out.push(md(group.content));
    } else {
      out.push(...renderToolGroup(group.tools, true, compactTools));
    }
  }
  return out;
}

function processTitle(hasReasoning: boolean, toolCount: number): string {
  const parts: string[] = [];
  if (hasReasoning) parts.push('🧠 思考');
  if (toolCount > 0) parts.push(`🧰 ${toolCount} 个工具调用`);
  const detail = parts.length > 0 ? `：${parts.join(' · ')}` : '';
  return `🗂 **过程${detail}**（点击展开）`;
}

/** Rough serialized size of an element list, for the process-panel budget. */
function estimateSize(els: CardElement[]): number {
  let n = 0;
  for (const el of els) n += JSON.stringify(el).length;
  return n;
}

/** Button-less version — used to demote a previous turn's card. */
export function buildRunCardPlain(rc: RunCardState): CardObject {
  return buildRunCard({ ...rc, cardKey: undefined });
}

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
type Group = ToolGroup | TextGroup;

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean, compact = false): CardElement[] {
  if (tools.length === 0) return [];
  // compact (process-panel over budget): header-only summary, drop output bodies.
  if (compact) return [collapsedToolSummary(tools, true)];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  if (finalized) return [collapsedToolSummary(tools, true)];
  // running: collapse prior tools into a summary, keep the latest one visible
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: CardElement[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}

function reasoningPanel(content: string, active: boolean): CardElement {
  return collapsiblePanel({
    title: active ? '🧠 **思考中**' : '🧠 **思考完成，点击查看**',
    expanded: active,
    border: 'grey',
    body: truncate(content, REASONING_MAX),
  });
}

function toolPanel(tool: ToolEntry, expanded: boolean): CardElement {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool) || '_无输出_',
  });
}

/**
 * N tool calls as one collapsed panel — only the per-tool header line is kept
 * (no bodies). Nesting full output panels can blow past Feishu's ~30KB
 * per-element limit and 400 the whole card stream.
 */
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): CardElement {
  const suffix = finalized ? '（已结束）' : '';
  return collapsiblePanel({
    title: `☕ **${tools.length} 个工具调用${suffix}**`,
    expanded: false,
    border: 'blue',
    body: tools.map((t) => `- ${toolHeaderText(t)}`).join('\n'),
  });
}

function footerStatus(status: Exclude<FooterStatus, null>): CardElement {
  const text = status === 'thinking' ? '🧠 正在思考' : status === 'tool_running' ? '🧰 正在调用工具' : '✍️ 正在输出';
  return noteMd(text);
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
