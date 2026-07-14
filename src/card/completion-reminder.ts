/** A completion reminder is intentionally separate from the run card: it
 * creates a native Feishu @notification after the card has reached a terminal
 * state, so the requester can leave the chat without losing a long task. */
export type CompletionReminderOutcome = 'done' | 'error' | 'idle_timeout';

export const LONG_TASK_REMINDER_MS = 3 * 60_000;

export function shouldSendCompletionReminder(outcome: CompletionReminderOutcome, elapsedMs: number): boolean {
  return outcome === 'error' || outcome === 'idle_timeout' || elapsedMs >= LONG_TASK_REMINDER_MS;
}

export function formatCompletionElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

export function buildCompletionReminderContent(input: {
  requesterOpenId: string;
  outcome: CompletionReminderOutcome;
  elapsedMs: number;
  summary?: string;
}): string {
  const task = compactSummary(input.summary);
  const elapsed = formatCompletionElapsed(input.elapsedMs);
  const headline =
    input.outcome === 'done'
      ? ` ✅「${task}」已完成，用时 ${elapsed}`
      : input.outcome === 'idle_timeout'
        ? ` ⏱「${task}」响应超时，已自动终止`
        : ` ⚠️「${task}」执行失败，用时 ${elapsed}`;
  const detail = input.outcome === 'done' ? '结果在上方任务卡片。' : '详情和可继续操作在上方任务卡片。';
  return JSON.stringify({
    zh_cn: {
      title: '',
      content: [
        [
          { tag: 'at', user_id: input.requesterOpenId },
          { tag: 'text', text: headline },
        ],
        [{ tag: 'text', text: detail }],
      ],
    },
  });
}

function compactSummary(summary?: string): string {
  const clean = (summary ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '本轮任务';
  return clean.length > 32 ? `${clean.slice(0, 31)}…` : clean;
}
