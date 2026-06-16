import { withUserAccessToken, type LarkChannel } from '@larksuiteoapi/node-sdk';
import { getPersonalAuthRedirectUri, getPersonalAuthScopes, type AppConfig } from '../config/schema';
import {
  consumePendingPersonalAuth,
  createPendingPersonalAuth,
  getPendingPersonalAuth,
  getPersonalAuthRecord,
  getPersonalAuthTokens,
  removePersonalAuth,
  upsertPersonalAuthRecord,
  type PersonalAuthRecord,
  type PersonalAuthTokens,
} from './auth-store';

const REFRESH_SKEW_MS = 5 * 60_000;

export interface PersonalAuthLink {
  url: string;
  state: string;
  redirectUri: string;
  scopes: string[];
}

export interface PersonalAuthStatus {
  connected: boolean;
  name?: string;
  scopes?: string[];
  accessExpiresAt?: number;
  refreshExpiresAt?: number;
}

export function personalAuthBaseUrl(cfg: AppConfig): string {
  return cfg.accounts.app.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

export async function createPersonalAuthLink(cfg: AppConfig, openId: string, chatId: string): Promise<PersonalAuthLink> {
  const appId = cfg.accounts.app.id;
  const redirectUri = getPersonalAuthRedirectUri(cfg);
  const scopes = getPersonalAuthScopes(cfg);
  const pending = await createPendingPersonalAuth({ appId, openId, chatId, redirectUri, scopes });
  const url = new URL(`${personalAuthBaseUrl(cfg)}/open-apis/authen/v1/authorize`);
  url.searchParams.set('app_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', pending.state);
  url.searchParams.set('scope', scopes.join(' '));
  return { url: url.toString(), state: pending.state, redirectUri, scopes };
}

export function parsePersonalAuthCallback(input: string): { code?: string; state?: string } {
  const raw = input.trim();
  if (!raw) return {};
  try {
    const url = new URL(raw);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    };
  } catch {
    const code = /^code=([^&\s]+)/.exec(raw)?.[1] ?? (/^[A-Za-z0-9_-]{8,}$/.test(raw) ? raw : undefined);
    const state = /(?:^|\s|&)state=([^&\s]+)/.exec(raw)?.[1];
    return { code, state };
  }
}

export async function completePersonalAuth(
  channel: LarkChannel,
  cfg: AppConfig,
  openId: string,
  callbackText: string,
): Promise<PersonalAuthRecord> {
  const appId = cfg.accounts.app.id;
  const parsed = parsePersonalAuthCallback(callbackText);
  if (!parsed.code || !parsed.state) throw new Error('请发送完整回调 URL，里面需要同时包含 code 和 state。');

  const pending = await getPendingPersonalAuth(appId, parsed.state);
  if (!pending) throw new Error('授权 state 不存在或已过期，请重新发送 `/connect` 获取新链接。');
  if (pending.openId !== openId) throw new Error('这个授权链接不是当前用户生成的，请使用自己的 `/connect` 链接。');

  const tokenResp = await channel.rawClient.authen.accessToken.create({
    data: { grant_type: 'authorization_code', code: parsed.code },
  });
  const data = tokenResp.data;
  if (tokenResp.code !== 0 || !data?.access_token) throw new Error(tokenResp.msg || '换取 user_access_token 失败');

  const tokenOpenId = data.open_id || (await fetchUserOpenId(channel, data.access_token));
  if (tokenOpenId && tokenOpenId !== openId) {
    throw new Error('授权用户与当前飞书发言人不一致，已拒绝绑定。');
  }

  const now = Date.now();
  const record: PersonalAuthRecord = {
    appId,
    openId,
    name: data.name,
    unionId: data.union_id,
    tenantKey: data.tenant_key,
    scopes: pending.scopes,
    accessExpiresAt: now + secondsToMs(data.expires_in, 2 * 60 * 60),
    refreshExpiresAt: data.refresh_expires_in ? now + secondsToMs(data.refresh_expires_in, 30 * 24 * 60 * 60) : undefined,
    updatedAt: now,
  };
  await upsertPersonalAuthRecord(record, { accessToken: data.access_token, refreshToken: data.refresh_token });
  await consumePendingPersonalAuth(appId, parsed.state);
  return record;
}

async function fetchUserOpenId(channel: LarkChannel, accessToken: string): Promise<string | undefined> {
  try {
    const info = await channel.rawClient.authen.userInfo.get({}, withUserAccessToken(accessToken));
    return info.data?.open_id;
  } catch {
    return undefined;
  }
}

function secondsToMs(value: number | undefined, fallbackSeconds: number): number {
  const seconds = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallbackSeconds;
  return seconds * 1000;
}

export async function personalAuthStatus(cfg: AppConfig, openId: string): Promise<PersonalAuthStatus> {
  const record = await getPersonalAuthRecord(cfg.accounts.app.id, openId);
  if (!record) return { connected: false };
  return {
    connected: true,
    name: record.name,
    scopes: record.scopes,
    accessExpiresAt: record.accessExpiresAt,
    refreshExpiresAt: record.refreshExpiresAt,
  };
}

export async function disconnectPersonalAuth(cfg: AppConfig, openId: string): Promise<boolean> {
  return removePersonalAuth(cfg.accounts.app.id, openId);
}

export async function getValidPersonalAccessToken(
  channel: LarkChannel,
  cfg: AppConfig,
  openId: string,
): Promise<{ token: string; record: PersonalAuthRecord } | undefined> {
  const appId = cfg.accounts.app.id;
  const record = await getPersonalAuthRecord(appId, openId);
  if (!record) return undefined;
  const tokens = await getPersonalAuthTokens(appId, openId);
  if (!tokens) return undefined;
  if (record.accessExpiresAt - REFRESH_SKEW_MS > Date.now()) return { token: tokens.accessToken, record };
  if (!tokens.refreshToken) throw new Error('个人飞书授权已过期，请重新 `/connect`。');
  return refreshPersonalAccessToken(channel, record, tokens);
}

async function refreshPersonalAccessToken(
  channel: LarkChannel,
  record: PersonalAuthRecord,
  tokens: PersonalAuthTokens,
): Promise<{ token: string; record: PersonalAuthRecord }> {
  if (record.refreshExpiresAt && record.refreshExpiresAt <= Date.now()) {
    throw new Error('个人飞书 refresh_token 已过期，请重新 `/connect`。');
  }
  const resp = await channel.rawClient.authen.refreshAccessToken.create({
    data: { grant_type: 'refresh_token', refresh_token: tokens.refreshToken ?? '' },
  });
  const data = resp.data;
  if (resp.code !== 0 || !data?.access_token) throw new Error(resp.msg || '刷新个人飞书授权失败，请重新 `/connect`。');
  const now = Date.now();
  const nextRecord: PersonalAuthRecord = {
    ...record,
    name: data.name ?? record.name,
    unionId: data.union_id ?? record.unionId,
    tenantKey: data.tenant_key ?? record.tenantKey,
    accessExpiresAt: now + secondsToMs(data.expires_in, 2 * 60 * 60),
    refreshExpiresAt: data.refresh_expires_in ? now + secondsToMs(data.refresh_expires_in, 30 * 24 * 60 * 60) : record.refreshExpiresAt,
    updatedAt: now,
  };
  await upsertPersonalAuthRecord(nextRecord, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
  });
  return { token: data.access_token, record: nextRecord };
}
