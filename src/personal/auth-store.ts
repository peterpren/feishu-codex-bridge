import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { getSecret, removeSecret, setSecret } from '../config/keystore';

const FILE_VERSION = 1;
const PENDING_TTL_MS = 10 * 60_000;

export interface PersonalAuthRecord {
  appId: string;
  openId: string;
  name?: string;
  unionId?: string;
  tenantKey?: string;
  scopes: string[];
  accessExpiresAt: number;
  refreshExpiresAt?: number;
  updatedAt: number;
}

export interface PersonalAuthTokens {
  accessToken: string;
  refreshToken?: string;
}

export interface PendingPersonalAuth {
  appId: string;
  openId: string;
  chatId: string;
  state: string;
  redirectUri: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
}

interface StoreFile {
  version: number;
  records: PersonalAuthRecord[];
  pending: PendingPersonalAuth[];
}

const EMPTY: StoreFile = { version: FILE_VERSION, records: [], pending: [] };

export function personalAuthSecretKey(appId: string, openId: string): string {
  return `personal:${appId}:${openId}`;
}

async function readStore(): Promise<StoreFile> {
  try {
    const text = await readFile(paths.personalAuthFile, 'utf8');
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    return {
      version: FILE_VERSION,
      records: Array.isArray(parsed.records) ? parsed.records : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    throw err;
  }
}

async function writeStore(store: StoreFile): Promise<void> {
  await mkdir(dirname(paths.personalAuthFile), { recursive: true });
  const tmp = `${paths.personalAuthFile}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await chmod(tmp, 0o600);
  await rename(tmp, paths.personalAuthFile);
}

function prunePending(pending: PendingPersonalAuth[], now = Date.now()): PendingPersonalAuth[] {
  return pending.filter((p) => p.expiresAt > now);
}

export async function createPendingPersonalAuth(input: {
  appId: string;
  openId: string;
  chatId: string;
  redirectUri: string;
  scopes: string[];
  now?: number;
}): Promise<PendingPersonalAuth> {
  const now = input.now ?? Date.now();
  const state = randomUUID().replace(/-/g, '');
  const pending: PendingPersonalAuth = {
    appId: input.appId,
    openId: input.openId,
    chatId: input.chatId,
    state,
    redirectUri: input.redirectUri,
    scopes: input.scopes,
    createdAt: now,
    expiresAt: now + PENDING_TTL_MS,
  };
  const store = await readStore();
  store.pending = prunePending(store.pending, now).filter((p) => !(p.appId === input.appId && p.openId === input.openId));
  store.pending.push(pending);
  await writeStore(store);
  return pending;
}

export async function getPendingPersonalAuth(appId: string, state: string, now = Date.now()): Promise<PendingPersonalAuth | undefined> {
  const store = await readStore();
  const pending = prunePending(store.pending, now);
  if (pending.length !== store.pending.length) await writeStore({ ...store, pending });
  return pending.find((p) => p.appId === appId && p.state === state);
}

export async function consumePendingPersonalAuth(appId: string, state: string): Promise<void> {
  const store = await readStore();
  store.pending = store.pending.filter((p) => !(p.appId === appId && p.state === state));
  await writeStore(store);
}

export async function getPersonalAuthRecord(appId: string, openId: string): Promise<PersonalAuthRecord | undefined> {
  return (await readStore()).records.find((r) => r.appId === appId && r.openId === openId);
}

export async function upsertPersonalAuthRecord(record: PersonalAuthRecord, tokens: PersonalAuthTokens): Promise<void> {
  const store = await readStore();
  const records = store.records.filter((r) => !(r.appId === record.appId && r.openId === record.openId));
  records.push(record);
  await setSecret(personalAuthSecretKey(record.appId, record.openId), JSON.stringify(tokens));
  await writeStore({ ...store, records, pending: store.pending.filter((p) => !(p.appId === record.appId && p.openId === record.openId)) });
}

export async function getPersonalAuthTokens(appId: string, openId: string): Promise<PersonalAuthTokens | undefined> {
  const raw = await getSecret(personalAuthSecretKey(appId, openId));
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as Partial<PersonalAuthTokens>;
  if (!parsed.accessToken) return undefined;
  return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
}

export async function removePersonalAuth(appId: string, openId: string): Promise<boolean> {
  const store = await readStore();
  const before = store.records.length;
  store.records = store.records.filter((r) => !(r.appId === appId && r.openId === openId));
  store.pending = store.pending.filter((p) => !(p.appId === appId && p.openId === openId));
  await writeStore(store);
  await removeSecret(personalAuthSecretKey(appId, openId));
  return store.records.length !== before;
}
