import { describe, expect, it } from 'vitest';
import {
  buildCompactFailedCard,
  buildCompactedCard,
  buildCompactingCard,
  buildContextCard,
  CTX_CRIT,
  CTX_HIGH,
  CTX_WARN,
  ctxPercent,
  ctxTier,
  runCardGauge,
} from '../src/card/context-gauge';

type Div = { text: { content: string; text_color: string } };

describe('ctxTier', () => {
  it('tiers by usage fraction', () => {
    expect(ctxTier(0.1).level).toBe(0);
    expect(ctxTier(CTX_WARN).level).toBe(1);
    expect(ctxTier(CTX_HIGH).level).toBe(2);
    expect(ctxTier(CTX_CRIT).level).toBe(3);
    expect(ctxTier(1.5).level).toBe(3);
  });
});

describe('ctxPercent', () => {
  it('is null when window is unknown and caps at 100', () => {
    expect(ctxPercent(100, null)).toBeNull();
    expect(ctxPercent(100, 0)).toBeNull();
    expect(ctxPercent(50, 100)).toBe(50);
    expect(ctxPercent(200, 100)).toBe(100);
  });
});

describe('runCardGauge', () => {
  it('stays hidden below warning threshold', () => {
    expect(runCardGauge(10, 100)).toBeNull();
    expect(runCardGauge(50, 100)).toBeNull();
  });

  it('renders a compact nudge once the threshold is reached', () => {
    const warn = runCardGauge(70, 100) as unknown as Div;
    expect(warn.text.text_color).toBe('yellow');

    const crit = runCardGauge(96, 100) as unknown as Div;
    expect(crit.text.text_color).toBe('red');
    expect(crit.text.content).toContain('96%');
    expect(crit.text.content).toContain('/compact');
  });
});

describe('context cards', () => {
  it('shows context usage on demand even at low usage', () => {
    expect(JSON.stringify(buildContextCard(10, 100))).toContain('10%');
  });

  it('renders manual compaction states', () => {
    expect(JSON.stringify(buildCompactingCard())).toContain('正在压缩上下文');
    expect(JSON.stringify(buildCompactFailedCard('boom'))).toContain('压缩失败：boom');
    expect(JSON.stringify(buildCompactedCard({ usedTokens: 50_000, contextWindow: 200_000 }))).toContain('25%');
  });

  it('shows before and after percentage only when usage actually dropped', () => {
    const dropped = JSON.stringify(
      buildCompactedCard({ usedTokens: 50_000, contextWindow: 200_000 }, { used: 180_000, window: 200_000 }),
    );
    expect(dropped).toContain('90% → 25%');

    const unchanged = JSON.stringify(
      buildCompactedCard({ usedTokens: 180_000, contextWindow: 200_000 }, { used: 180_000, window: 200_000 }),
    );
    expect(unchanged).not.toContain('%');
    expect(unchanged).toContain('下一条消息');
  });
});
