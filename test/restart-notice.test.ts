import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  markRestartIntent,
  markRestartNoticeSent,
  recordRestartInterruptedRuns,
  restartNoticeForApp,
} from '../src/service/restart-notice';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-restart-notice-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    const dir = dirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('restart notice marker', () => {
  it('is visible once per app within the restart window', async () => {
    const dir = await tempDir();
    const now = new Date('2026-06-11T08:00:00.000Z');
    const notice = await markRestartIntent('manual_restart', { dir, now });

    expect(await restartNoticeForApp('cli_a', { dir, now: new Date('2026-06-11T08:00:10.000Z') })).toMatchObject({
      id: notice.id,
      reason: 'manual_restart',
    });

    await markRestartNoticeSent('cli_a', notice.id, { dir });
    expect(await restartNoticeForApp('cli_a', { dir, now: new Date('2026-06-11T08:00:20.000Z') })).toBeUndefined();
    expect(await restartNoticeForApp('cli_b', { dir, now: new Date('2026-06-11T08:00:20.000Z') })).toMatchObject({
      id: notice.id,
    });
  });

  it('ignores stale restart markers', async () => {
    const dir = await tempDir();
    await markRestartIntent('version_update', { dir, now: new Date('2026-06-11T08:00:00.000Z') });

    expect(await restartNoticeForApp('cli_a', { dir, now: new Date('2026-06-11T08:31:00.000Z') })).toBeUndefined();
  });

  it('loads interrupted run targets per app', async () => {
    const dir = await tempDir();
    await markRestartIntent('manual_restart', { dir, now: new Date('2026-06-11T08:00:00.000Z') });
    await recordRestartInterruptedRuns(
      'cli_a',
      [
        {
          appId: 'cli_a',
          chatId: 'oc_a',
          replyToMessageId: 'om_root',
          replyInThread: true,
          cardMessageId: 'om_card',
          requesterOpenId: 'ou_a',
          requesterName: '张三',
          topicTitle: '天气查询',
        },
      ],
      { dir },
    );

    const noticeA = await restartNoticeForApp('cli_a', { dir, now: new Date('2026-06-11T08:00:10.000Z') });
    expect(noticeA?.runs).toEqual([
      expect.objectContaining({
        appId: 'cli_a',
        chatId: 'oc_a',
        cardMessageId: 'om_card',
        requesterOpenId: 'ou_a',
      }),
    ]);
    const noticeB = await restartNoticeForApp('cli_b', { dir, now: new Date('2026-06-11T08:00:10.000Z') });
    expect(noticeB?.runs).toEqual([]);
  });
});
