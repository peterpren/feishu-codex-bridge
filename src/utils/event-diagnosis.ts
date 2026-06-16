import type { TenantBrand } from '../config/schema';

const ENDPOINTS: Record<TenantBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

/** Core event: without this, message delivery does not reach the bridge. */
export const REQUIRED_EVENTS = ['im.message.receive_v1'] as const;

/** Optional events used by extra features; missing ones do not block startup. */
export const OPTIONAL_EVENTS = [
  'application.bot.menu_v6',
  'drive.notice.comment_add_v1',
  'im.chat.member.bot.added_v1',
  'im.chat.member.bot.deleted_v1',
] as const;

export type EventDiagnosisState = 'unchecked' | 'unpublished' | 'missing' | 'ok';

export interface EventDiagnosis {
  state: EventDiagnosisState;
  /** unchecked: why the read failed, such as missing scope or network failure. */
  reason?: string;
  /** Latest published version number, when available. */
  version?: string;
  /** Events subscribed on the latest published version. */
  events?: string[];
  /** Missing required events; non-empty when state is missing. */
  missingRequired?: string[];
  /** Missing optional events; informational only. */
  missingOptional?: string[];
}

interface TokenResp {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
}

interface VersionListResp {
  code?: number;
  msg?: string;
  data?: { items?: { version?: string; status?: number; events?: string[] }[] };
}

/**
 * Diagnose the event subscription state via the read-only app version API.
 * Failures are returned as unchecked so callers can surface guidance without
 * blocking normal startup.
 */
export async function diagnoseEventSubscription(
  appId: string,
  appSecret: string,
  tenant: TenantBrand,
  fetchFn: typeof fetch = fetch,
): Promise<EventDiagnosis> {
  const base = ENDPOINTS[tenant];
  let token: string;
  try {
    const resp = await fetchFn(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    if (!resp.ok) return { state: 'unchecked', reason: `token HTTP ${resp.status}` };
    const data = (await resp.json()) as TokenResp;
    if (data.code !== 0 || !data.tenant_access_token) {
      return { state: 'unchecked', reason: `token code=${data.code ?? '?'} msg=${data.msg ?? '<no msg>'}` };
    }
    token = data.tenant_access_token;
  } catch (err) {
    return { state: 'unchecked', reason: `网络错误：${err instanceof Error ? err.message : String(err)}` };
  }

  let body: VersionListResp;
  try {
    const resp = await fetchFn(
      `${base}/open-apis/application/v6/applications/${encodeURIComponent(appId)}/app_versions?lang=zh_cn&page_size=50&order=0`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    body = ((await resp.json().catch(() => undefined)) as VersionListResp | undefined) ?? { code: -1, msg: '' };
    if (!resp.ok && body.code === -1) {
      const hint = resp.status === 400 || resp.status === 403 ? '——可能缺 application:application.app_version:readonly 权限' : '';
      return { state: 'unchecked', reason: `HTTP ${resp.status}${hint}` };
    }
  } catch (err) {
    return { state: 'unchecked', reason: `网络错误：${err instanceof Error ? err.message : String(err)}` };
  }

  if (body.code !== 0) {
    const scopeHint =
      body.code === 99991672 || /permission|scope|access/i.test(body.msg ?? '')
        ? '——请在「权限管理」授权 application:application.app_version:readonly 后重试'
        : '';
    return { state: 'unchecked', reason: `code=${body.code ?? '?'} msg=${body.msg ?? '<no msg>'}${scopeHint}` };
  }

  const live = (body.data?.items ?? []).find((v) => v.status === 1);
  if (!live) return { state: 'unpublished' };

  const events = live.events ?? [];
  const has = new Set(events);
  const missingRequired = REQUIRED_EVENTS.filter((e) => !has.has(e));
  const missingOptional = OPTIONAL_EVENTS.filter((e) => !has.has(e));
  return {
    state: missingRequired.length > 0 ? 'missing' : 'ok',
    version: live.version,
    events,
    missingRequired,
    missingOptional,
  };
}

export function summarizeEventDiagnosis(d: EventDiagnosis): string {
  switch (d.state) {
    case 'ok':
      return `✅ 已生效（版本 v${d.version ?? '?'} 已订阅 ${REQUIRED_EVENTS.join(' / ')}）`;
    case 'missing':
      return `❌ 已发布版本 v${d.version ?? '?'} 缺事件：${(d.missingRequired ?? []).join('、')} —— @我 不会有反应`;
    case 'unpublished':
      return '❌ 从未发布过版本 —— 事件订阅尚未生效，@我 不会有反应';
    case 'unchecked':
      return `⚠️ 未能自动检测（${d.reason ?? '未知原因'}）`;
  }
}

export async function pollEventSubscription(
  appId: string,
  appSecret: string,
  tenant: TenantBrand,
  opts: { intervalMs?: number; timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<EventDiagnosis | null> {
  const intervalMs = opts.intervalMs ?? 15_000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await diagnoseEventSubscription(appId, appSecret, tenant, opts.fetchFn ?? fetch);
    if (d.state === 'ok') return d;
    if (Date.now() + intervalMs > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
