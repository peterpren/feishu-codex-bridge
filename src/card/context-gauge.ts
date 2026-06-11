import { card, colorNote, hr, note, type CardElement, type CardObject, type NoteColor } from './cards';

export const CTX_WARN = 0.7;
export const CTX_HIGH = 0.85;
export const CTX_CRIT = 0.95;

export interface CtxTier {
  level: 0 | 1 | 2 | 3;
  color: NoteColor;
  dot: string;
  advice: string;
}

export function ctxTier(frac: number): CtxTier {
  if (frac >= CTX_CRIT) return { level: 3, color: 'red', dot: '🔴', advice: '强烈建议 `/compact` 压缩' };
  if (frac >= CTX_HIGH) return { level: 2, color: 'orange', dot: '🟠', advice: '建议 `/compact` 压缩' };
  if (frac >= CTX_WARN) return { level: 1, color: 'yellow', dot: '🟡', advice: '可考虑 `/compact` 压缩' };
  return { level: 0, color: 'green', dot: '🟢', advice: '' };
}

export function ctxPercent(used: number, window: number | null): number | null {
  if (!window || window <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / window) * 100)));
}

function k(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.max(0, Math.round(n)));
}

export function runCardGauge(used: number, window: number | null): CardElement | null {
  const pct = ctxPercent(used, window);
  if (pct === null || !window) return null;
  const frac = used / window;
  if (frac < CTX_WARN) return null;
  const t = ctxTier(frac);
  return colorNote(`${t.dot} 上下文 ${pct}% · ${k(used)}/${k(window)} · ${t.advice}`, t.color);
}

export function buildContextCard(used: number, window: number | null): CardObject {
  const pct = ctxPercent(used, window);
  if (pct === null) {
    const line = used > 0 ? `🧠 已用 ${k(used)} tokens（上下文窗口未知）` : '🧠 还没有用量数据，跑一轮对话后再看 `/context`。';
    return card([note(line)], { summary: '上下文用量' });
  }
  const t = ctxTier(used / window!);
  const els: CardElement[] = [colorNote(`${t.dot} **上下文 ${pct}%** · ${k(used)}/${k(window!)} tokens`, t.color)];
  els.push(note(t.level >= 1 ? `${t.advice}：总结早前对话、释放空间。` : '空间充足，无需压缩。'));
  return card(els, { summary: '上下文用量' });
}

const COMPACT_SPINNER = ['◐', '◓', '◑', '◒'];

export function buildCompactingCard(tick = 0): CardObject {
  const spin = COMPACT_SPINNER[((tick % COMPACT_SPINNER.length) + COMPACT_SPINNER.length) % COMPACT_SPINNER.length];
  return card([colorNote(`🗜️ 正在压缩上下文 ${spin}`, 'blue'), note('总结早前对话、释放空间，请稍候。')], {
    summary: '正在压缩上下文',
  });
}

export function buildCompactedCard(
  usage: { usedTokens: number; contextWindow: number | null } | null,
  before?: { used: number; window: number | null } | null,
): CardObject {
  const els: CardElement[] = [colorNote('✅ 上下文压缩完成', 'green')];
  const pct = usage ? ctxPercent(usage.usedTokens, usage.contextWindow) : null;
  const dropped = usage != null && before != null && usage.usedTokens < before.used;
  if (usage && pct !== null && usage.contextWindow && (dropped || before == null)) {
    const beforePct = before ? ctxPercent(before.used, before.window) : null;
    const from = dropped && beforePct !== null ? `${beforePct}% → ` : '';
    els.push(note(`早前对话已总结归档，现已用 ${from}${pct}%（${k(usage.usedTokens)}/${k(usage.contextWindow)} tokens）。`));
  } else {
    els.push(note('早前对话已总结归档、腾出空间继续；发下一条消息后，`/context` 即可看到占用下降。'));
  }
  return card(els, { summary: '上下文压缩完成' });
}

export function buildCompactFailedCard(message: string): CardObject {
  return card([colorNote(`⚠️ 压缩失败：${message}`, 'red')], { summary: '压缩失败' });
}

export function buildAutoCompactCard(): CardObject {
  return card(
    [
      hr(),
      colorNote('🗜️ ─── 上下文已自动压缩 ───', 'blue'),
      note('早前对话已总结归档、腾出空间继续；最近的上下文保留。'),
    ],
    { summary: '上下文已自动压缩' },
  );
}
