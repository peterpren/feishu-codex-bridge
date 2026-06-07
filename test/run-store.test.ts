import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initialState, type RunState } from '../src/card/run-state';
import {
  appendRunRecord,
  finishedRunRecord,
  runRecordsFileFor,
  startedRunRecord,
  type RunRecordContext,
} from '../src/bot/run-store';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-runs-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    const dir = dirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

function ctx(overrides: Partial<RunRecordContext> = {}): RunRecordContext {
  return {
    runId: 'run_test',
    chatId: 'oc_chat',
    replyToMessageId: 'om_reply',
    feishuThreadId: 'omt_thread',
    codexThreadId: 'codex_thread',
    codexTurnId: 'turn_1',
    projectName: '测试项目',
    cwd: '/Users/me/project',
    topicTitle: '测试话题',
    requesterOpenId: 'ou_user',
    requesterName: '任鹏',
    promptPreview: '帮我跑一下测试',
    startedAt: '2026-06-06T15:00:00.000Z',
    ...overrides,
  };
}

describe('run-store', () => {
  it('writes records into an auto-created daily JSONL file', async () => {
    const dir = await tempDir();
    const file = await appendRunRecord(startedRunRecord(ctx()), { dir });
    expect(file).toBe(runRecordsFileFor(new Date('2026-06-06T15:00:00.000Z'), dir));

    const body = await readFile(file, 'utf8');
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({
      event: 'started',
      status: 'running',
      chatId: 'oc_chat',
      feishuThreadId: 'omt_thread',
      codexThreadId: 'codex_thread',
      projectName: '测试项目',
    });
  });

  it('summarizes codex turn errors with failed tool evidence', () => {
    const state: RunState = {
      ...initialState,
      terminal: 'error',
      errorMsg: 'network failed',
      blocks: [
        {
          kind: 'tool',
          tool: {
            id: 'tool_1',
            title: 'npm test',
            status: 'error',
            output: 'expected 1 received 2',
            exitCode: 1,
          },
        },
      ],
    };
    const rec = finishedRunRecord(ctx(), {
      terminal: 'error',
      endedAt: '2026-06-06T15:00:03.000Z',
      state,
      events: 7,
      textChars: 20,
    });

    expect(rec).toMatchObject({
      event: 'finished',
      status: 'error',
      ok: false,
      failureClass: 'codex_turn_error',
      mainReason: 'Codex 运行错误：network failed',
      durationMs: 3000,
      evidence: {
        errorMessage: 'network failed',
        failedToolTitle: 'npm test',
        failedToolExitCode: 1,
      },
      metrics: { events: 7, textChars: 20, failedTools: 1 },
    });
  });

  it('summarizes timeout and bridge errors', () => {
    const timeout = finishedRunRecord(ctx(), {
      terminal: 'idle_timeout',
      endedAt: '2026-06-06T15:02:00.000Z',
      state: { ...initialState, terminal: 'idle_timeout', idleTimeoutMinutes: 2 },
    });
    expect(timeout.status).toBe('idle_timeout');
    expect(timeout.failureClass).toBe('idle_timeout');
    expect(timeout.mainReason).toContain('超过 2 分钟');

    const bridge = finishedRunRecord(ctx(), {
      terminal: 'bridge_error',
      endedAt: '2026-06-06T15:00:01.000Z',
      bridgeError: new Error('card update failed'),
    });
    expect(bridge.status).toBe('bridge_error');
    expect(bridge.failureClass).toBe('bridge_error');
    expect(bridge.mainReason).toBe('Bridge 运行异常：card update failed');
  });
});
