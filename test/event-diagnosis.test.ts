import { describe, expect, it } from 'vitest';
import {
  diagnoseEventSubscription,
  OPTIONAL_EVENTS,
  pollEventSubscription,
  REQUIRED_EVENTS,
  summarizeEventDiagnosis,
} from '../src/utils/event-diagnosis';
import { APP_VERSION_SCOPES, GRANT_SCOPES, REQUIRED_SCOPES } from '../src/config/scopes';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fetchStub(
  over: { token?: unknown; tokenStatus?: number; versions?: unknown; versionsStatus?: number } = {},
): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0]) => {
    const u = String(url);
    if (u.includes('tenant_access_token')) {
      return jsonResponse(over.token ?? { code: 0, tenant_access_token: 't-x' }, over.tokenStatus ?? 200);
    }
    if (u.includes('app_versions')) {
      return jsonResponse(over.versions ?? { code: 0, data: { items: [] } }, over.versionsStatus ?? 200);
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
}

const ALL_EVENTS = [...REQUIRED_EVENTS, ...OPTIONAL_EVENTS];

describe('diagnoseEventSubscription', () => {
  it('reports ok when latest published version has the required message event', async () => {
    const d = await diagnoseEventSubscription(
      'cli_x',
      's',
      'feishu',
      fetchStub({
        versions: { code: 0, data: { items: [{ version: '1.0.2', status: 1, events: ['im.message.receive_v1'] }] } },
      }),
    );
    expect(d.state).toBe('ok');
    expect(d.version).toBe('1.0.2');
    expect(d.missingRequired).toEqual([]);
    expect(d.missingOptional).toEqual([...OPTIONAL_EVENTS]);
  });

  it('reports ok with no optional misses when all tracked events are present', async () => {
    const d = await diagnoseEventSubscription(
      'cli_x',
      's',
      'feishu',
      fetchStub({ versions: { code: 0, data: { items: [{ version: '2.0.0', status: 1, events: ALL_EVENTS }] } } }),
    );
    expect(d.state).toBe('ok');
    expect(d.missingOptional).toEqual([]);
    expect(d.events).toEqual(ALL_EVENTS);
  });

  it('reports missing when a published version lacks im.message.receive_v1', async () => {
    const d = await diagnoseEventSubscription(
      'cli_x',
      's',
      'feishu',
      fetchStub({
        versions: { code: 0, data: { items: [{ version: '1.0.0', status: 1, events: ['application.bot.menu_v6'] }] } },
      }),
    );
    expect(d.state).toBe('missing');
    expect(d.missingRequired).toEqual(['im.message.receive_v1']);
  });

  it('reports unpublished when no approved version exists', async () => {
    expect((await diagnoseEventSubscription('cli_x', 's', 'feishu', fetchStub())).state).toBe('unpublished');
    expect(
      (
        await diagnoseEventSubscription(
          'cli_x',
          's',
          'feishu',
          fetchStub({ versions: { code: 0, data: { items: [{ version: '1.0.0', status: 3, events: ALL_EVENTS }] } } }),
        )
      ).state,
    ).toBe('unpublished');
  });

  it('reports unchecked with a scope hint when app_versions cannot be read', async () => {
    const d = await diagnoseEventSubscription(
      'cli_x',
      's',
      'feishu',
      fetchStub({ versions: { code: 99991672, msg: 'no permission' } }),
    );
    expect(d.state).toBe('unchecked');
    expect(d.reason).toContain('99991672');
    expect(d.reason).toContain('application:application.app_version:readonly');
  });

  it('never throws on network failure', async () => {
    const boom = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const d = await diagnoseEventSubscription('cli_x', 's', 'feishu', boom);
    expect(d.state).toBe('unchecked');
    expect(d.reason).toContain('ECONNRESET');
  });
});

describe('summarizeEventDiagnosis', () => {
  it('renders readable summaries for all states', () => {
    expect(summarizeEventDiagnosis({ state: 'ok', version: '1.0.2' })).toContain('已生效');
    expect(summarizeEventDiagnosis({ state: 'missing', missingRequired: ['im.message.receive_v1'] })).toContain(
      'im.message.receive_v1',
    );
    expect(summarizeEventDiagnosis({ state: 'unpublished' })).toContain('从未发布');
    expect(summarizeEventDiagnosis({ state: 'unchecked', reason: 'HTTP 503' })).toContain('HTTP 503');
  });
});

describe('pollEventSubscription', () => {
  it('returns once diagnosis flips to ok', async () => {
    let calls = 0;
    const flip = (async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes('tenant_access_token')) return jsonResponse({ code: 0, tenant_access_token: 't-x' });
      calls++;
      const events = calls >= 2 ? ['im.message.receive_v1'] : [];
      return jsonResponse({ code: 0, data: { items: [{ version: '1.0.0', status: 1, events }] } });
    }) as typeof fetch;
    const d = await pollEventSubscription('cli_x', 's', 'feishu', { intervalMs: 1, timeoutMs: 1000, fetchFn: flip });
    expect(d?.state).toBe('ok');
  });

  it('returns null on timeout', async () => {
    const d = await pollEventSubscription('cli_x', 's', 'feishu', { intervalMs: 5, timeoutMs: 20, fetchFn: fetchStub() });
    expect(d).toBeNull();
  });
});

describe('APP_VERSION_SCOPES', () => {
  it('is preselected in grant URL scope set but does not block REQUIRED_SCOPES', () => {
    expect(GRANT_SCOPES).toContain(APP_VERSION_SCOPES[0]);
    expect(REQUIRED_SCOPES as readonly string[]).not.toContain(APP_VERSION_SCOPES[0]);
  });
});
