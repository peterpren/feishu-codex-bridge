import { describe, expect, it } from 'vitest';
import {
  LONG_TASK_REMINDER_MS,
  buildCompletionReminderContent,
  shouldSendCompletionReminder,
} from '../src/card/completion-reminder';

describe('completion reminder policy', () => {
  it('always notifies on errors and watchdog timeouts, and only notifies completed long tasks', () => {
    expect(shouldSendCompletionReminder('error', 1)).toBe(true);
    expect(shouldSendCompletionReminder('idle_timeout', 1)).toBe(true);
    expect(shouldSendCompletionReminder('done', LONG_TASK_REMINDER_MS - 1)).toBe(false);
    expect(shouldSendCompletionReminder('done', LONG_TASK_REMINDER_MS)).toBe(true);
  });

  it('builds a native Feishu mention instead of a plain-text @', () => {
    const content = JSON.parse(
      buildCompletionReminderContent({
        requesterOpenId: 'ou_requester',
        outcome: 'done',
        elapsedMs: LONG_TASK_REMINDER_MS,
        summary: '整理本周项目风险和待办',
      }),
    );
    expect(content.zh_cn.content[0][0]).toEqual({ tag: 'at', user_id: 'ou_requester' });
    expect(content.zh_cn.content[0][1].text).toContain('已完成');
  });
});
