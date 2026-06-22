import type { BotAddedEvent, CardActionEvent, CommentEvent, LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { createBackend } from '../agent';
import type { AgentInput, AgentRun, AgentThread, ModelInfo, PermissionMode, ReasoningEffort, ServiceTier, ThreadSummary } from '../agent/types';
import {
  getMaxConcurrentRuns,
  getPendingPolicy,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  isAdmin,
  isChatAllowed,
  isUserAllowedInProject,
  resolveOwner,
  secretKeyForApp,
  type AppAccess,
  type AppConfig,
  type AppPreferences,
  type PendingPolicy,
} from '../config/schema';
import { saveConfig } from '../config/store';
import { CardDispatcher } from '../card/dispatcher';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { RunRender } from '../card/run-render';
import { finalMessageText, finalizeIfRunning, initialState, markIdleTimeout, reduce, type RunState } from '../card/run-state';
import {
  buildHelpCard,
  buildModelCard,
  buildResumeCard,
  buildResumeDoneCard,
  buildResumeErrorCard,
  buildResumeLaunchingCard,
  MC,
  RES,
  type HelpScope,
  type ModelCardState,
  type ResumeCardState,
} from '../card/command-cards';
import { buildHistoryCard, type HistoryCardState } from '../card/history-card';
import { buildPrivateCreatedCard, buildPrivateIntroCard } from '../card/private-cards';
import { ANSWER_EID, buildRunCard, buildRunCardPlain, RC, type RunCardState } from '../card/run-card';
import { RunCardStream } from '../card/run-card-stream';
import {
  buildAutoCompactCard,
  buildCompactFailedCard,
  buildCompactedCard,
  buildCompactingCard,
  buildContextCard,
} from '../card/context-gauge';
import { buildCleanCard, extractCardFences } from '../card/markdown-render';
import { imageSources, uploadOutboundImages } from '../card/outbound-images';
import { log, withTrace } from '../core/logger';
import {
  buildAddAdminCard,
  buildAddAllowedCard,
  buildAdminsCard,
  buildAllowlistCard,
  buildCloudDocFolderFormCard,
  buildDmMenuCard,
  buildDoctorCard,
  buildGroupSettingsCard,
  buildJoinGroupFormCard,
  buildNewProjectDoneCard,
  buildNewProjectFormCard,
  buildPermissionCard,
  buildProjectListCard,
  buildProjectSettingsCard,
  buildRmConfirmCard,
  buildSettingsCard,
  buildUpdateCard,
  buildWorkspaceRootFormCard,
  DM,
  GS,
  type DoctorInfo,
} from '../card/dm-cards';
import { resolveCodexBin, codexVersion } from '../agent/codex-appserver/locate';
import { fetchUsageBundle, UsageError } from '../agent/codex-appserver/usage';
import {
  buildShareConfigCard,
  buildUsageCard,
  buildUsageShareCard,
  parseShareSections,
  type UsageCardState,
} from '../card/usage-cards';
import { serviceStdoutPath, serviceStderrPath } from '../service/common';
import {
  checkUpdate,
  currentVersion,
  daemonRunning,
  installLatest,
  isDevSource,
  manualInstallCommand,
  restartDaemon,
  updateSourceLabel,
} from '../service/update';
import { recordRestartInterruptedRuns, type RestartInterruptedRun } from '../service/restart-notice';
import { bridgeVersion } from '../core/version';
import { paths } from '../config/paths';
import { getSecret } from '../config/keystore';
import { buildEventConfigUrl, buildScopeGrantUrl, CLOUD_DOC_FOLDER_SCOPES, JOIN_GROUP_SCOPES } from '../config/scopes';
import { validateAppCredentials } from '../utils/feishu-auth';
import { diagnoseEventSubscription } from '../utils/event-diagnosis';
import {
  defaultNoMention,
  effectiveMode,
  effectiveNetwork,
  enabledProjectMcpServers,
  getProjectByChatId,
  getProjectByName,
  listProjects,
  parseCloudDocFolder,
  renameProject,
  removeProject,
  turnTier,
  updateProject,
  type CloudDocFolder,
  type Project,
} from '../project/registry';
import { isIsolatedTopicWorkspace, prepareSessionCwd } from '../project/topic-workspace';
import { createPrivateProject, createProject, joinExistingGroup } from '../project/lifecycle';
import { normalizeWorkspaceRoot } from '../project/workspace-root';
import { refreshBranch, setAnnouncement } from '../project/announcement';
import {
  createTopicCloudDocFolder,
  grantProjectCloudDocFolderAccess,
  grantTopicCloudDocFolderAccess,
  permissionRecord,
  renameTopicCloudDocFolder,
} from '../project/cloud-doc-permission';
import { leaveChat, renameChat, transferOwnership } from '../project/group-ops';
import { getSession, listSessions, patchSession, upsertSession, type SessionRecord } from './session-store';
import {
  appendRunRecord,
  finishedRunRecord,
  newRunId,
  startedRunRecord,
  type RunRecord,
  type RunRecordContext,
} from './run-store';
import { handleDmConsole } from './dm-console';
import {
  appendInboundFilesToText,
  collectInboundFiles,
  collectInboundImages,
  messageHasFiles,
  messageHasImages,
} from './media';
import { fetchQuotedMessage, fetchThreadContext, weaveQuote, weaveThreadHistory } from './context-weave';
import { textRequestsCloudDocFolder } from './cloud-doc-intent';
import { pickBridgeDefaults } from './model-defaults';
import { deriveTopicTitle, formatTopicTitleMessage, normalizeManualTopicTitle, type TopicRequester } from './topic-title';
import {
  completePersonalAuth,
  createPersonalAuthLink,
  disconnectPersonalAuth,
  personalAuthStatus,
} from '../personal/oauth';
import {
  detectPersonalDataIntent,
  fetchPersonalDataBundle,
  formatPersonalDataForPrompt,
  parsePersonalDataCommand,
} from '../personal/gateway';
import {
  mentionedPrivateParticipants,
  parsePrivateTaskText,
  privateProjectName,
  privateSourcePrompt,
  type PrivateParticipant,
} from '../project/private-project';
import {
  addCommentReaction,
  buildCommentPrompt,
  postCommentReply,
  removeCommentReaction,
  REPLY_MAX_CHARS,
  resolveComment,
  stripMarkdown,
  SUPPORTED_FILE_TYPES,
} from './comments';
import { Semaphore, withIdleTimeout } from './watchdog';

/**
 * open_id → 姓名 的批量解析（管理员 / 白名单卡展示用）。需 contact:user.base:readonly
 * scope；无 scope / 调用失败则返回空 Map，卡片降级显示 open_id 尾段（见 memberName）。
 */
async function resolveNames(channel: LarkChannel, ids: (string | undefined)[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const out = new Map<string, string>();
  if (uniq.length === 0) return out;
  try {
    const r = await channel.rawClient.contact.v3.user.batch({
      params: { user_ids: uniq, user_id_type: 'open_id' },
    });
    for (const it of r.data?.items ?? []) {
      if (it.open_id && it.name) out.set(it.open_id, it.name);
    }
  } catch (err) {
    log.info('console', 'resolve-names-fail', { n: uniq.length, err: String(err) });
  }
  return out;
}

/** 拉群成员（open_id + 姓名）。该接口**不返回机器人成员**（天然排除 bot），也能拿到
 * 外部租户成员（不受通讯录可见范围限制）。失败 / 无权限返回空数组（调用方降级到手填
 * open_id）。仅取首页（page_size 100），大群配合手填。 */
async function fetchChatMembers(channel: LarkChannel, chatId: string): Promise<{ openId: string; name: string }[]> {
  try {
    const r = await channel.rawClient.im.v1.chatMembers.get({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id', page_size: 100 },
    });
    const out: { openId: string; name: string }[] = [];
    for (const it of r.data?.items ?? []) {
      if (it.member_id) out.push({ openId: it.member_id, name: it.name || `…${it.member_id.slice(-6)}` });
    }
    return out;
  } catch (err) {
    log.info('console', 'fetch-members-fail', { chatId: chatId.slice(-6), err: String(err) });
    return [];
  }
}

/** 所有项目群成员的并集（去重）—— admins 加人的候选源（admins 通常是项目相关的人）。
 * 逐群调 fetchChatMembers，失败的群跳过；不含 bot/应用（接口保证）。 */
async function fetchAllProjectMembers(channel: LarkChannel): Promise<{ openId: string; name: string }[]> {
  const projects = await listProjects();
  // 并发拉各项目群成员（原串行 for-await 在项目多时单次渲染放大成 O(N) 串行调用）。
  const lists = await Promise.all(projects.filter((p) => p.chatId).map((p) => fetchChatMembers(channel, p.chatId)));
  const seen = new Map<string, string>();
  for (const members of lists) {
    for (const m of members) if (!seen.has(m.openId)) seen.set(m.openId, m.name);
  }
  return [...seen].map(([openId, name]) => ({ openId, name }));
}

/**
 * 从 select_person 的提交值（form_value['pick']）里取出 open_id。单选格式飞书未在
 * 类型中声明（可能是字符串 / 数组 / {open_id|id|value}），故 best-effort 兼容多形态，
 * 取第一个 ou_ 开头的 id；取不到时返回 undefined（回调据此跳过写入）。
 */
function pickOpenId(formValue: Record<string, unknown> | undefined): string | undefined {
  const raw = formValue?.pick;
  const cands: unknown[] = Array.isArray(raw) ? raw : [raw];
  for (const c of cands) {
    if (typeof c === 'string' && c.startsWith('ou_')) return c;
    if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>;
      for (const v of [o.open_id, o.id, o.value]) if (typeof v === 'string' && v.startsWith('ou_')) return v;
    }
  }
  return undefined;
}

/** Read a selectMenu's submitted value (form_value[name]) — best-effort across
 * string / array / {value} shapes, mirroring {@link pickOpenId}. */
function selectValue(formValue: Record<string, unknown> | undefined, name: string): string | undefined {
  const c = (() => {
    const raw = formValue?.[name];
    return Array.isArray(raw) ? raw[0] : raw;
  })();
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object') {
    const o = c as Record<string, unknown>;
    for (const v of [o.value, o.id]) if (typeof v === 'string') return v;
  }
  return undefined;
}

/** Narrow an arbitrary string to a PermissionMode, else undefined. */
function asTier(v: string | undefined): PermissionMode | undefined {
  return v === 'qa' || v === 'write' || v === 'full' ? v : undefined;
}

interface ActiveState {
  /** unset only during the brief "reserved, still resolving the thread" window */
  thread?: AgentThread;
  run?: AgentRun;
  /** follow-up turns queued mid-run; each carries its own text + downloaded images */
  queue: AgentInput[];
  /** who started this run — gates destructive ⏹ (design §5) */
  requesterOpenId?: string;
  /** ⏹ 终止: abort the codex turn AND end the local consume loop. Set per-turn
   * while a run is in flight; codex emits no mappable terminal on interrupt, so
   * the loop must be stopped locally rather than waiting on the backend. */
  interrupt?: () => void;
  interruptReason?: RunState['interruptedReason'];
  /** Persisted during shutdown so the restarted bridge can notify the original
   * requester in the same Feishu topic/message node. */
  restartNotice?: RestartInterruptedRun;
}

/** Message-reaction lifecycle controller (see {@link runReaction}). */
interface RunReaction {
  /** the run acquired a concurrency slot and is now running → Typing */
  started: () => void;
  /** the run ended (complete / ⏹ / timeout / error) → DONE */
  done: () => void;
}

export class RecentIdCache {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly maxEntries = 4096,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  /** Returns true when this id was already seen within the TTL. */
  seen(id: string): boolean {
    const now = Date.now();
    this.prune(now);
    const prev = this.entries.get(id);
    if (prev !== undefined && now - prev < this.ttlMs) return true;
    this.entries.set(id, now);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    return false;
  }

  private prune(now: number): void {
    for (const [id, ts] of this.entries) {
      if (now - ts >= this.ttlMs) this.entries.delete(id);
    }
  }
}

export interface Orchestrator {
  onMessage: (msg: NormalizedMessage) => Promise<void>;
  /** `comment` event handler: @bot in a cloud-doc comment → reply in-thread. */
  onComment: (evt: CommentEvent) => Promise<void>;
  /** `botAdded` event: a human added the bot to a group → DM the (admin) adder
   * a bind card to register it as a `joined` project. */
  onBotAddedToChat: (evt: BotAddedEvent) => Promise<void>;
  /** bot removed from a group (im.chat.member.bot.deleted_v1, tapped on the raw
   * dispatcher) → auto-unbind the bound project, if any. */
  onBotRemovedFromChat: (chatId: string) => Promise<void>;
  dispatcher: CardDispatcher;
  /** Close every live codex session (SIGKILLs the app-server children) so a
   *  graceful exit leaves no orphan processes. */
  shutdown: () => Promise<void>;
}

/**
 * The group orchestrator owns all per-bridge run state (codex threads, active
 * turns, concurrency, pending command cards) and exposes both the inbound
 * message handler and the card-action dispatcher so they share that state.
 *
 * Flow (design §3):
 *   p2p                       → DM console (never runs codex).
 *   group @bot, no thread     → bot posts a short title message, then
 *                               reply_in_thread creates the topic → run codex
 *                               (default model/effort/speed; tune later with /model).
 *   group @bot /resume        → history picker → resume a codex thread in a new topic.
 *   group @bot, inside thread → a turn in that session (steer/queue mid-turn);
 *                               /model opens the model/effort picker for it.
 *
 * Group kinds (project.kind): 'multi' (default) = a topic per session, keyed by
 * threadId (the flow above); 'single' = the whole group is one session keyed by
 * chatId, replies quote the message (no topic, runs serialize). 免@ (noMention)
 * lets non-command, non-@ messages run too — multi only inside a topic, single
 * whole-group (needs the im:message.group_msg scope). Multi defaults off;
 * @bot /settings toggles it.
 */
export function createOrchestrator(
  channel: LarkChannel,
  cfg: AppConfig,
  fallbackCwd: string,
): Orchestrator {
  const backend = createBackend();
  const sessions = new Map<string, AgentThread>();
  const recreatedSessions = new Set<string>();
  const active = new Map<string, ActiveState>();
  /** Per-doc serialization for comment runs (see {@link withDocLock}). */
  const docLocks = new Map<string, Promise<void>>();
  const sema = new Semaphore(getMaxConcurrentRuns(cfg));
  const idleMs = getRunIdleTimeoutMs(cfg) ?? 0;
  const seenInbound = new RecentIdCache();
  // pendingPolicy is read per-message (settings card can change it live)
  /** pending /resume cards, keyed by the card's messageId */
  const resumePending = new Map<string, ResumeCardState>();
  /** pending /model cards, keyed by the card's messageId */
  const modelPending = new Map<string, ModelCardState>();
  /** active runs indexed by their run card's messageId (for ⏹ 中止) */
  const runsByCard = new Map<string, ActiveState>();
  /** latest run-card state by messageId (to demote a previous turn's card) */
  const runCards = new Map<string, RunCardState>();
  /** CardKit entity backing each run card, by messageId — drives the native
   * typewriter stream and whole-card (button/settings) updates. */
  const runStreams = new Map<string, RunCardStream>();
  /** the latest settings-bearing run card per topic thread */
  const lastRunCard = new Map<string, string>();
  const lastUsage = new Map<string, { used: number; window: number | null }>();
  const launchPromises = new Set<Promise<unknown>>();
  let modelsCache: ModelInfo[] | null = null;

  function trackLaunch<T>(promise: Promise<T>): Promise<T> {
    launchPromises.add(promise);
    promise.then(
      () => launchPromises.delete(promise),
      () => launchPromises.delete(promise),
    );
    return promise;
  }

  async function listModels(): Promise<ModelInfo[]> {
    if (!modelsCache) modelsCache = await backend.listModels();
    return modelsCache;
  }

  function pickDefault(models: ModelInfo[]): { model: string; effort: ReasoningEffort; serviceTier?: ServiceTier } {
    return pickBridgeDefaults(models);
  }

  function projectCloudDocAdmins(extraOpenId?: string): string[] {
    return [...new Set([resolveOwner(cfg), ...(cfg.preferences?.access?.admins ?? []), extraOpenId].filter((x): x is string => Boolean(x)))];
  }

  function cloudDocAccess(extraOpenId?: string): { adminOpenIds: string[]; appId: string } {
    return { adminOpenIds: projectCloudDocAdmins(extraOpenId), appId: cfg.accounts.app.id };
  }

  function topicCloudDocAccess(project: Project | undefined, requesterOpenId: string): {
    adminOpenIds: string[];
    appId: string;
    collaboratorOpenIds?: string[];
  } {
    const collaborators = project?.private ? (project.participants ?? []).filter((id) => id && id !== requesterOpenId) : [];
    return {
      ...cloudDocAccess(requesterOpenId),
      ...(collaborators.length ? { collaboratorOpenIds: collaborators } : {}),
    };
  }

  function usableCloudDocFolder(folder: CloudDocFolder | undefined): CloudDocFolder | undefined {
    if (!folder?.token) return undefined;
    if (folder.permission && folder.permission.status !== 'granted') return undefined;
    return folder;
  }

  async function prepareTopicCloudDocFolder(
    project: Project | undefined,
    opts: { title: string; requesterOpenId: string; requesterName?: string; existing?: CloudDocFolder },
  ): Promise<{ cloudDocFolder?: CloudDocFolder; cloudDocFolderError?: string }> {
    if (!project?.cloudDocFolder?.token) return {};
    if ((project.kind ?? 'multi') === 'single' && !project.private) return { cloudDocFolder: usableCloudDocFolder(project.cloudDocFolder) };

    if (opts.existing?.token) {
      const result = await grantTopicCloudDocFolderAccess(channel, opts.existing, {
        ...topicCloudDocAccess(project, opts.requesterOpenId),
        title: opts.title,
        requesterOpenId: opts.requesterOpenId,
        requesterName: opts.requesterName,
      });
      const folder = { ...opts.existing, permission: permissionRecord(result) };
      if (result.status === 'granted') return { cloudDocFolder: folder };
      return { cloudDocFolderError: result.error ?? '话题云文档目录授权失败' };
    }

    const result = await createTopicCloudDocFolder(channel, project.cloudDocFolder, {
      ...topicCloudDocAccess(project, opts.requesterOpenId),
      title: opts.title,
      requesterOpenId: opts.requesterOpenId,
      requesterName: opts.requesterName,
    });
    if (result.folder?.permission?.status === 'granted') return { cloudDocFolder: result.folder };
    return { cloudDocFolderError: result.error ?? '话题云文档目录创建失败' };
  }

  function turnNeedsTopicCloudDocFolder(msg: NormalizedMessage, text: string, project: Project | undefined, flat: boolean): boolean {
    if (flat && !project?.private) return false;
    if (!project?.cloudDocFolder?.token) return false;
    return messageHasFiles(msg) || textRequestsCloudDocFolder(text);
  }

  function cloudDocFolderForSession(
    project: Project | undefined,
    rec: SessionRecord | undefined,
    flat: boolean,
  ): { cloudDocFolder?: CloudDocFolder; cloudDocFolderError?: string } {
    if (project?.private) {
      return {
        cloudDocFolder: usableCloudDocFolder(rec?.cloudDocFolder),
        cloudDocFolderError: rec?.cloudDocFolderError,
      };
    }
    if (flat || (project?.kind ?? 'multi') === 'single') return { cloudDocFolder: usableCloudDocFolder(project?.cloudDocFolder) };
    return {
      cloudDocFolder: usableCloudDocFolder(rec?.cloudDocFolder),
      cloudDocFolderError: rec?.cloudDocFolderError,
    };
  }

  async function ensureTopicCloudDocFolderForSession(
    project: Project | undefined,
    sessionKey: string,
    opts: { title: string; requesterOpenId: string; requesterName?: string; existing?: CloudDocFolder },
  ): Promise<{ cloudDocFolder?: CloudDocFolder; cloudDocFolderError?: string }> {
    const cloudDoc = await prepareTopicCloudDocFolder(project, opts);
    if (cloudDoc.cloudDocFolder || cloudDoc.cloudDocFolderError) {
      await patchSession(sessionKey, {
        cloudDocFolder: cloudDoc.cloudDocFolder,
        cloudDocFolderError: cloudDoc.cloudDocFolder ? '' : cloudDoc.cloudDocFolderError,
      }).catch(() => undefined);
    }
    return cloudDoc;
  }

  function withCloudDocFolderHint(
    input: AgentInput,
    folder: CloudDocFolder | undefined,
    error: string | undefined,
    needed: boolean,
  ): AgentInput {
    if (!needed) return input;
    if (input.text?.includes('[Bridge 云文档目录]')) return input;
    const base = input.text?.trim() || '用户本轮需要处理飞书云文档或附件。';
    if (!folder?.token) {
      const tail = error
        ? `[Bridge 云文档目录]\n本轮需要话题云文档子文件夹，但 Bridge 未能创建或授权：${error}。请不要保存到项目父目录或其它默认目录，直接向用户说明需要管理员检查云空间目录权限。`
        : '[Bridge 云文档目录]\n本项目未配置可用的话题云文档子文件夹。请不要保存到其它默认目录，直接向用户说明需要先配置飞书云文档保存文件夹。';
      return { ...input, text: `${base}\n\n${tail}` };
    }
    const createAs = folder.createAs ?? 'user';
    const lines = [
      '[Bridge 云文档目录]',
      '本轮如需创建、导入、上传、输出或保存飞书云文档/文件，请默认使用当前话题的云空间子文件夹。',
      `folder_token: ${folder.token}`,
      folder.url ? `folder_url: ${folder.url}` : '',
      `优先命令示例：lark-cli docs +create --api-version v2 --as ${createAs} --parent-token ${folder.token} --content '<title>标题</title><p>内容</p>'`,
      '除非用户明确指定其它位置，不要改用项目父文件夹、my_library 或其它目录。',
    ].filter(Boolean);
    return { ...input, text: `${base}\n\n${lines.join('\n')}` };
  }

  async function reconcileProjectCloudDocFolderAccess(): Promise<void> {
    for (const project of await listProjects()) {
      if (!project.cloudDocFolder?.token) continue;
      const result = await grantProjectCloudDocFolderAccess(channel, project.cloudDocFolder, {
        ...cloudDocAccess(project.addedBy),
        chatId: project.chatId,
      });
      const cloudDocFolder = { ...project.cloudDocFolder, permission: permissionRecord(result) };
      await updateProject(project.name, { cloudDocFolder });
      if (result.status === 'granted') {
        log.info('project', 'cloud-doc-folder-reconcile', { name: project.name, via: result.via ?? '-' });
      } else {
        log.fail('project', new Error(result.error ?? 'grant failed'), {
          phase: 'cloud-doc-folder-reconcile',
          name: project.name,
        });
      }
    }
  }

  void reconcileProjectCloudDocFolderAccess().catch((err) => log.fail('project', err, { phase: 'cloud-doc-folder-reconcile' }));

  // Feishu gives bots no way to mark a message "已读" (read receipts are a
  // human-client signal), so a reaction stands in for one. Best-effort — a
  // missing im:message.reactions:write_only scope just means no reaction appears.
  async function addReaction(messageId: string, emoji: string): Promise<string | undefined> {
    try {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
      return (r as { data?: { reaction_id?: string } }).data?.reaction_id;
    } catch (err) {
      log.fail('card', err, { phase: 'reaction-add', emoji });
      return undefined;
    }
  }
  function removeReaction(messageId: string, reactionId: string): void {
    void channel.rawClient.im.v1.messageReaction
      .delete({ path: { message_id: messageId, reaction_id: reactionId } })
      .catch((err) => log.fail('card', err, { phase: 'reaction-del' }));
  }

  /**
   * Reaction lifecycle on the triggering message: ⏳ OneSecond while the run
   * waits for a free concurrency slot, 🫳 Typing while it's actually running,
   * then the emoji is removed entirely when it ends (complete / ⏹ 终止 /
   * timeout / error) — no "done" emoji. Transitions are serialized through
   * `chain` so each step removes the prior emoji first.
   */
  function runReaction(messageId: string, queued: boolean): RunReaction {
    let chain: Promise<string | undefined> = addReaction(messageId, queued ? 'OneSecond' : 'Typing');
    let phase = queued ? 0 : 1; // 0 = waiting(OneSecond), 1 = running(Typing), 2 = done(cleared)
    const swap = (emoji: string): void => {
      chain = chain.then(async (prevId) => {
        if (prevId) removeReaction(messageId, prevId);
        return addReaction(messageId, emoji);
      });
    };
    return {
      started: () => {
        if (phase < 1) {
          phase = 1;
          swap('Typing');
        }
      },
      done: () => {
        if (phase < 2) {
          phase = 2;
          chain = chain.then((prevId) => {
            if (prevId) removeReaction(messageId, prevId);
            return undefined;
          });
        }
      },
    };
  }

  // ── inbound messages ──────────────────────────────────────────────
  const onMessage = async (msg: NormalizedMessage): Promise<void> => {
    if (seenInbound.seen(`message:${msg.messageId}`)) {
      log.info('intake', 'dedupe', {
        chatType: msg.chatType,
        threadId: msg.threadId ?? null,
        msgId: msg.messageId,
      });
      return;
    }

    log.info('intake', 'recv', {
      chatType: msg.chatType,
      mentionedBot: msg.mentionedBot,
      threadId: msg.threadId ?? null,
      preview: msg.content.slice(0, 40),
    });

    const text = msg.content.trim();
    const cmd = parseCommand(text);

    if (msg.chatType === 'p2p') {
      if (cmd === 'connect') {
        if (!(await allowConnectHere(msg, text, undefined, false))) return;
        await handleConnectCommand(msg, text, false);
        return;
      }
      if (cmd === 'me') {
        await handlePersonalStatusCommand(msg, text, false);
        return;
      }
      await handleDmConsole(channel, cfg, msg);
      return;
    }

    const project = await getProjectByChatId(msg.chatId);
    // @门：没 @ 时只在「项目群 + 明确命令 / 免@ 适用」才响应。免@ multi 默认关且
    // 仅话题内生效，single 整群；非项目群一律不响应非 @ 消息。
    if (!msg.mentionedBot && !(project && shouldRespondWithoutMention(project, msg))) return;
    if (!isChatAllowed(cfg, msg.chatId) || !isUserAllowedInProject(cfg, project, msg.senderId)) {
      log.info('intake', 'reject', { reason: 'not_allowed', chatId: msg.chatId.slice(-6) });
      return;
    }

    // The bot is in a group not bound to any project (e.g. it was just added and
    // the admin hasn't finished binding in DM yet). Don't run codex in the
    // fallback cwd for an unbound group — only nudge toward binding when @ed.
    if (!project) {
      log.info('intake', 'unbound-group', { chatId: msg.chatId.slice(-6), atBot: msg.mentionedBot });
      if (msg.mentionedBot) {
        await channel
          .send(
            msg.chatId,
            { markdown: '本群还没绑定为项目。请**把我拉进群的管理员**在与我的私聊里完成绑定后再 @我。' },
            { replyTo: msg.messageId },
          )
          .catch(() => undefined);
      }
      return;
    }

    // Single-session group: the whole group is one session keyed by chatId. No
    // topics — reply by quoting (引用回复); runs serialize per chatId (active[chatId]).
    // Commands: /settings (群设置) + /model. /resume has no topic list here.
    if ((project?.kind ?? 'multi') === 'single') {
      const ts = turnSession(msg.chatId, project, msg.senderId);
      if (cmd === 'connect') {
        if (!(await allowConnectHere(msg, text, project, false))) return;
        await handleConnectCommand(msg, text, false);
        return;
      }
      if (cmd === 'me') {
        await handlePersonalDataCommand(msg, text, project, ts);
        return;
      }
      if (cmd === 'help') {
        await postHelpCard(msg, project.private ? 'private' : 'single', false, project);
        return;
      }
      if (cmd === 'settings') {
        await postGroupSettings(msg, project);
        return;
      }
      if (cmd === 'model') {
        await postModelCard(msg, ts.sessionKey, false);
        return;
      }
      if (cmd === 'context') {
        await postContextCard(msg, ts.sessionKey, false);
        return;
      }
      if (cmd === 'compact') {
        await runCompact(msg, ts.sessionKey, false, ts);
        return;
      }
      if (cmd === 'rename') {
        if (project.private) {
          await renamePrivateProject(msg, text, project);
          return;
        }
        await channel
          .send(msg.chatId, { markdown: '`/rename 新名字` 只适用于多话题群里的具体话题。' }, { replyTo: msg.messageId })
          .catch(() => undefined);
        return;
      }
      if (cmd === 'private') {
        await channel
          .send(msg.chatId, { markdown: '当前已经是单会话群，不需要再创建私密群。请直接发消息继续。' }, { replyTo: msg.messageId })
          .catch(() => undefined);
        return;
      }
      if (await handlePersonalDataIntent(msg, text, project, ts)) return;
      handleTurn(msg, text, ts.sessionKey, true, project, ts);
      return;
    }

    // Multi (default): inside a topic → a turn in that session. /model and
    // /rename are topic-scoped commands; /settings + /resume aren't topic-scoped,
    // so they fall through as normal turns.
    if (msg.threadId) {
      if (cmd === 'connect') {
        if (!(await allowConnectHere(msg, text, project, true))) return;
        await handleConnectCommand(msg, text, true);
        return;
      }
      if (cmd === 'me') {
        await channel
          .send(msg.chatId, { markdown: '`/me` 个人飞书资料只在私密协作群里启用。请先用 `/private` 拉一个私密群。' }, { replyTo: msg.messageId, replyInThread: true })
          .catch(() => undefined);
        return;
      }
      if (cmd === 'help') {
        await postHelpCard(msg, 'topic', true, project);
        return;
      }
      const ts = turnSession(msg.threadId, project, msg.senderId);
      if (!(await ensureTopicActorAllowed(msg, msg.threadId))) return;
      if (cmd === 'private') {
        startPrivateGroup(msg, text, project);
        return;
      }
      if (cmd === 'model') {
        await postModelCard(msg, ts.sessionKey, true);
        return;
      }
      if (cmd === 'context') {
        await postContextCard(msg, ts.sessionKey, true);
        return;
      }
      if (cmd === 'compact') {
        await runCompact(msg, ts.sessionKey, true, ts);
        return;
      }
      if (cmd === 'rename') {
        await renameTopic(msg, text);
        return;
      }
      handleTurn(msg, text, ts.sessionKey, false, project, ts);
      return;
    }
    // Main group area: /resume opens the history picker; /settings opens the
    // group-settings card; /model only makes sense inside a topic; anything else
    // directly creates a topic + runs.
    if (cmd === 'help') {
      await postHelpCard(msg, 'main', false, project);
      return;
    }
    if (cmd === 'connect') {
      if (!(await allowConnectHere(msg, text, project, false))) return;
      await handleConnectCommand(msg, text, false);
      return;
    }
    if (cmd === 'me') {
      await channel
        .send(msg.chatId, { markdown: '`/me` 个人飞书资料只在私密协作群里启用。请先用 `/private` 拉一个私密群。' }, { replyTo: msg.messageId })
        .catch(() => undefined);
      return;
    }
    if (cmd === 'resume') {
      await postResumeCard(msg);
      return;
    }
    if (cmd === 'settings') {
      await postGroupSettings(msg, project);
      return;
    }
    if (cmd === 'private') {
      startPrivateGroup(msg, text, project);
      return;
    }
    if (cmd === 'model' || cmd === 'context' || cmd === 'compact') {
      await channel
        .send(msg.chatId, { markdown: `\`/${cmd}\` 需要在话题里使用（先 @我 开个话题）。` }, { replyTo: msg.messageId })
        .catch(() => undefined);
      return;
    }
    if (cmd === 'rename') {
      await channel
        .send(msg.chatId, { markdown: '`/rename 新名字` 需要在话题里使用。' }, { replyTo: msg.messageId })
        .catch(() => undefined);
      return;
    }
    startTopicDirectly(msg, text, project);
  };

  /** Parse a leading slash command; null otherwise. */
  function parseCommand(text: string):
    | 'resume'
    | 'model'
    | 'settings'
    | 'help'
    | 'rename'
    | 'private'
    | 'context'
    | 'compact'
    | 'connect'
    | 'me'
    | null {
    const m = /^\/([\w-]+)/.exec(text);
    const name = m?.[1]?.toLowerCase();
    return name === 'resume' ||
      name === 'model' ||
      name === 'settings' ||
      name === 'help' ||
      name === 'rename' ||
      name === 'private' ||
      name === 'context' ||
      name === 'compact' ||
      name === 'connect' ||
      name === 'me'
      ? name
      : null;
  }

  function parseRenameTitle(text: string): string {
    return normalizeManualTopicTitle(text.replace(/^\/rename\b/i, ''));
  }

  /** Whether to respond to a non-@ message in a project group.
   * Slash commands (/help /resume /settings /model /rename /private) respond without @
   * because they're explicit. File messages inside an existing topic also
   * respond without @: Feishu file cards cannot @ the bot, and the topic actor
   * gate below still limits this to the topic owner/admin.
   * For normal messages, single applies to the whole group; multi applies only
   * inside a topic. Plain chatter in the main area still needs @, so a random
   * sentence never opens a new topic.
   * 即使开了免@，若普通消息 @了所有人 或 @了具体的(非机器人)用户,说明是定向给别人的,
   * bot 不插话；/private 是显式命令，允许携带 @参与者。(此函数仅在 !mentionedBot 时调用,
   * 故 @到 bot 的情况已被排除。) */
  function shouldRespondWithoutMention(project: Project, msg: NormalizedMessage): boolean {
    if (msg.mentionAll) return false;
    if (parseCommand(msg.content.trim()) !== null) return true;
    if (msg.mentions.some((m) => !m.isBot)) return false;
    if (msg.threadId && messageHasFiles(msg)) return true;
    if (!(project.noMention ?? defaultNoMention(project))) return false;
    if ((project.kind ?? 'multi') === 'single') return true;
    return Boolean(msg.threadId);
  }

  async function ensureTopicActorAllowed(msg: NormalizedMessage, threadId: string): Promise<boolean> {
    const rec = await getSession(threadId);
    const owner = rec?.topicRequesterOpenId;
    if (!owner || owner === msg.senderId || isAdmin(cfg, msg.senderId)) return true;
    const ownerLabel = rec?.topicRequesterName ? `「${rec.topicRequesterName}」` : `…${owner.slice(-6)}`;
    await channel
      .send(
        msg.chatId,
        { markdown: `这个话题由 ${ownerLabel} 发起。为避免改到别人话题的文件，只有话题发起人或管理员可以在这里驱动 Codex。请回主群区 @我 开自己的话题。` },
        { replyTo: msg.messageId, replyInThread: true },
      )
      .catch(() => undefined);
    log.info('intake', 'topic-owner-denied', { threadId, owner: owner.slice(-6), sender: msg.senderId.slice(-6) });
    return false;
  }

  /** 非管理员触发 owner-only 命令(/resume、/settings)时的统一无权限提示。
   * design §5: 管理类命令仅 bot owner(=admins[]) 可用；对话类(/model、/help)对所有人开放。 */
  async function denyAdminCommand(msg: NormalizedMessage, cmd: 'resume' | 'settings'): Promise<void> {
    await channel
      .send(msg.chatId, { markdown: `⚠️ \`/${cmd}\` 仅 bot 管理员可用。` }, { replyTo: msg.messageId })
      .catch(() => undefined);
    log.info('intake', 'cmd-denied', { cmd });
  }

  /** @bot /settings in a group: post the in-group settings card (owner/admin-gated). */
  async function postGroupSettings(msg: NormalizedMessage, project?: Project): Promise<void> {
    if (project && !(await canManageProjectSettings(project, msg.senderId))) {
      const reason = project.private ? '仅私密群发起人或管理员可用。' : '仅 bot 管理员可用。';
      await channel.send(msg.chatId, { markdown: `⚠️ \`/settings\` ${reason}` }, { replyTo: msg.messageId }).catch(() => undefined);
      return;
    }
    if (!project && !isAdmin(cfg, msg.senderId)) {
      await denyAdminCommand(msg, 'settings');
      return;
    }
    if (!project) {
      await channel
        .send(msg.chatId, { markdown: '本群未绑定项目，请先在私聊里新建项目。' }, { replyTo: msg.messageId })
        .catch(() => undefined);
      return;
    }
    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      await sendManagedCard(channel, msg.chatId, buildGroupSettingsCard(project), msg.messageId);
      log.info('card', 'group-settings', { project: project.name });
    });
  }

  async function privateRequesterOpenId(project: Project): Promise<string | undefined> {
    if (!project.private) return undefined;
    const rec = await getSession(project.chatId);
    return rec?.topicRequesterOpenId ?? project.participants?.[0];
  }

  async function canManageProjectSettings(project: Project, openId: string | undefined): Promise<boolean> {
    if (!openId) return false;
    if (isAdmin(cfg, openId)) return true;
    if (!project.private) return false;
    return (await privateRequesterOpenId(project)) === openId;
  }

  function connectArg(text: string): string {
    return text.replace(/^\/connect\b/i, '').trim();
  }

  function isConnectStatusOrRevoke(text: string): boolean {
    const arg = connectArg(text);
    return /^(status|状态|revoke|disconnect|解绑|取消授权)$/i.test(arg);
  }

  async function allowConnectHere(msg: NormalizedMessage, text: string, project: Project | undefined, inThread: boolean): Promise<boolean> {
    if (project?.private || isConnectStatusOrRevoke(text)) return true;
    const target = msg.chatType === 'p2p' ? '先到项目群里使用 `/private` 创建一个私密协作群' : '先用 `/private` 创建私密协作群';
    await channel
      .send(
        msg.chatId,
        { markdown: `个人飞书授权请在私密协作群里完成。请${target}，再在那个私密群里发送 \`/connect\`。` },
        { replyTo: msg.messageId, replyInThread: inThread },
      )
      .catch(() => undefined);
    return false;
  }

  async function handleConnectCommand(msg: NormalizedMessage, text: string, inThread: boolean): Promise<void> {
    const arg = connectArg(text);
    const reply = (markdown: string): Promise<void> =>
      channel
        .send(msg.chatId, { markdown }, { replyTo: msg.messageId, replyInThread: inThread })
        .then(() => undefined, () => undefined);

    if (/^(status|状态)$/i.test(arg)) {
      await reply(formatPersonalAuthStatus(await personalAuthStatus(cfg, msg.senderId)));
      return;
    }
    if (/^(revoke|disconnect|解绑|取消授权)$/i.test(arg)) {
      const removed = await disconnectPersonalAuth(cfg, msg.senderId);
      await reply(removed ? '✅ 已解除你的个人飞书授权。' : '你还没有绑定个人飞书授权。');
      return;
    }
    if (arg) {
      try {
        const record = await completePersonalAuth(channel, cfg, msg.senderId, arg);
        await reply(
          `✅ 已绑定你的个人飞书权限${record.name ? `：${record.name}` : ''}。\n\n后续在私密协作群里可以直接自然语言提需求，例如：\n· 帮我查一下我飞书里有没有玉豆相关资料\n· 基于我上周的会议纪要，整理一下待办`,
        );
      } catch (err) {
        await reply(`❌ 绑定失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    const link = await createPersonalAuthLink(cfg, msg.senderId, msg.chatId);
    await reply(
      [
        '🔐 **绑定个人飞书权限**',
        '',
        '1. 打开下面链接并完成授权：',
        link.url,
        '',
        '2. 授权后浏览器会跳到一个回调地址。如果页面显示“无法连接服务器”，这是测试版的正常现象，说明授权 code 已经写进地址栏。',
        '',
        '3. 不要刷新页面，把地址栏里的完整 URL 复制回来，发送：',
        '`/connect 回调URL`',
        '',
        `回调地址需要先在飞书开放平台配置：\`${link.redirectUri}\``,
        `本次 state：\`${link.state}\`，10 分钟内有效。`,
      ].join('\n'),
    );
  }

  async function handlePersonalStatusCommand(msg: NormalizedMessage, text: string, inThread: boolean): Promise<void> {
    const parsed = parsePersonalDataCommand(text);
    if (parsed.kind === 'status') {
      await channel
        .send(msg.chatId, { markdown: formatPersonalAuthStatus(await personalAuthStatus(cfg, msg.senderId)) }, { replyTo: msg.messageId, replyInThread: inThread })
        .catch(() => undefined);
      return;
    }
    await channel
      .send(
        msg.chatId,
        {
          markdown:
            '`/me` 是调试入口。正式使用时，请先在私密协作群发送 `/connect` 绑定权限，然后直接自然语言提需求，例如“帮我查一下我飞书里的预算复盘资料”。',
        },
        { replyTo: msg.messageId, replyInThread: inThread },
      )
      .catch(() => undefined);
  }

  async function handlePersonalDataCommand(
    msg: NormalizedMessage,
    text: string,
    project: Project,
    perm: { sessionKey: string } & TurnPerm,
  ): Promise<void> {
    const reply = (markdown: string): Promise<void> =>
      channel.send(msg.chatId, { markdown }, { replyTo: msg.messageId }).then(() => undefined, () => undefined);
    const parsed = parsePersonalDataCommand(text);
    if (parsed.kind === 'status') {
      await reply(formatPersonalAuthStatus(await personalAuthStatus(cfg, msg.senderId)));
      return;
    }
    if (parsed.kind === 'help') {
      await reply('`/me` 是调试入口。正式使用时，在私密协作群里先 `/connect`，然后直接自然语言提需求。\n\n调试用法：\n· `/me docs 关键词`\n· `/me minutes 关键词`\n· `/me status`');
      return;
    }
    if (!project.private) {
      await reply('`/me` 个人飞书资料只在私密协作群里启用。请先在项目群用 `/private` 拉一个私密群。');
      return;
    }
    if (!parsed.kind || !['docs', 'minutes'].includes(parsed.kind)) {
      await reply('用法：`/me docs 关键词` 或 `/me minutes 关键词`。');
      return;
    }
    try {
      const bundle = await fetchPersonalDataBundle(channel, cfg, {
        kind: parsed.kind,
        query: parsed.query,
        appId: cfg.accounts.app.id,
        openId: msg.senderId,
        chatId: msg.chatId,
        messageId: msg.messageId,
        projectName: project.name,
      });
      const label = parsed.kind === 'minutes' ? '会议纪要/妙记' : '个人文档';
      const prompt = [
        `用户要求基于其个人飞书权限查询${label}：${parsed.query || '(未指定关键词)'}`,
        '',
        formatPersonalDataForPrompt(bundle),
        '',
        '请基于以上搜索结果和正文摘录回答。若结果不足以回答，直接说明还需要用户补充更明确的关键词或文档链接。',
      ].join('\n');
      await handleTurn(msg, prompt, perm.sessionKey, true, project, perm);
    } catch (err) {
      await reply(`❌ 个人飞书资料读取失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handlePersonalDataIntent(
    msg: NormalizedMessage,
    text: string,
    project: Project,
    perm: { sessionKey: string } & TurnPerm,
  ): Promise<boolean> {
    if (!project.private) return false;
    const intent = detectPersonalDataIntent(text);
    if (!intent) return false;

    const reply = (markdown: string): Promise<void> =>
      channel.send(msg.chatId, { markdown }, { replyTo: msg.messageId }).then(() => undefined, () => undefined);
    const status = await personalAuthStatus(cfg, msg.senderId);
    if (!status.connected) {
      await reply('这条需求需要读取你的个人飞书资料。请先在本私密协作群发送 `/connect` 完成授权；授权后再直接用自然语言提需求。');
      return true;
    }

    try {
      const bundle = await fetchPersonalDataBundle(channel, cfg, {
        kind: intent.kind,
        query: intent.query,
        appId: cfg.accounts.app.id,
        openId: msg.senderId,
        chatId: msg.chatId,
        messageId: msg.messageId,
        projectName: project.name,
      });
      const label = intent.kind === 'minutes' ? '会议纪要/妙记' : '个人文档';
      const prompt = [
        `用户原始需求：${text}`,
        '',
        `Bridge 已按当前发言人的个人飞书权限查询${label}。`,
        '',
        formatPersonalDataForPrompt(bundle),
        '',
        '请基于用户原始需求、当前会话上下文，以及以上个人飞书搜索结果回答。若结果不足以支撑结论，直接说明需要更明确的关键词、文档链接或会议范围。',
      ].join('\n');
      await handleTurn(msg, prompt, perm.sessionKey, true, project, perm);
    } catch (err) {
      await reply(`❌ 个人飞书资料读取失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  function formatPersonalAuthStatus(status: Awaited<ReturnType<typeof personalAuthStatus>>): string {
    if (!status.connected) return '还没有绑定个人飞书权限。发送 `/connect` 获取授权链接。';
    const lines = [`✅ 已绑定个人飞书权限${status.name ? `：${status.name}` : ''}`];
    if (status.accessExpiresAt) lines.push(`Access Token 到期：${new Date(status.accessExpiresAt).toLocaleString('zh-CN', { hour12: false })}`);
    if (status.refreshExpiresAt) lines.push(`Refresh Token 到期：${new Date(status.refreshExpiresAt).toLocaleString('zh-CN', { hour12: false })}`);
    lines.push('', '解除绑定：`/connect revoke`');
    return lines.join('\n');
  }

  /** A turn's resolved permission, by sender role. `roleSuffix` is set only when
   * the project splits admin/guest tiers — then the session key is namespaced by
   * it so a guest never shares the admin thread (sandbox + codex history). */
  type TurnPerm = { mode?: PermissionMode; network?: boolean; autoCompact?: boolean; roleSuffix?: 'admin' | 'guest' };

  /** Pick this sender's tier (admin vs guest) for `project`. */
  function turnPerm(project: Project | undefined, senderId: string): TurnPerm {
    if (!project) return {};
    const t = turnTier(project, isAdmin(cfg, senderId));
    return { mode: t.mode, network: effectiveNetwork(project), autoCompact: project.autoCompact, roleSuffix: t.split ? t.role : undefined };
  }

  /** As {@link turnPerm}, plus the role-namespaced session key (only namespaced
   * when the project splits tiers — keeps existing single-tier sessions intact). */
  function turnSession(
    baseKey: string,
    project: Project | undefined,
    senderId: string,
  ): { sessionKey: string } & TurnPerm {
    const perm = turnPerm(project, senderId);
    return { sessionKey: perm.roleSuffix ? `${baseKey}#${perm.roleSuffix}` : baseKey, ...perm };
  }

  function feishuThreadIdFromSessionKey(key: string | undefined): string | undefined {
    return key?.split('#')[0];
  }

  async function collectTurnInput(msg: NormalizedMessage, text: string, cwd: string): Promise<AgentInput> {
    const hasFiles = messageHasFiles(msg);
    const files = hasFiles ? await collectInboundFiles(channel, msg, cwd) : [];
    const images = messageHasImages(msg) ? await collectInboundImages(channel, msg) : undefined;
    let body = hasFiles ? appendInboundFilesToText(text, files, true) : text;
    if (msg.replyToMessageId) {
      const quoted = await fetchQuotedMessage(channel, msg.replyToMessageId);
      body = weaveQuote(body, quoted);
    }
    return {
      text: body,
      images,
    };
  }

  function msgTime(msg: NormalizedMessage): number {
    return Number(msg.createTime) || Date.now();
  }

  async function weaveTopicContextForTurn(
    msg: NormalizedMessage,
    text: string,
    flat: boolean,
    freshSession: boolean,
    priorLastSeenAt: number | undefined,
  ): Promise<string> {
    if (!msg.threadId || flat || (!freshSession && priorLastSeenAt === undefined)) return text;
    const history = await fetchThreadContext(channel, msg.threadId, {
      sinceTime: freshSession ? 0 : priorLastSeenAt,
      excludeMessageId: msg.messageId,
    });
    return weaveThreadHistory(text, history);
  }

  /**
   * A turn in a session keyed by `sessionKey` — the topic's threadId (multi) or
   * the chatId (single, `flat`). steer/queue mid-turn; otherwise reserve + run.
   * `flat` = reply by quoting (no reply_in_thread / topic), for single groups.
   */
  async function handleTurn(
    msg: NormalizedMessage,
    text: string,
    sessionKey: string,
    flat: boolean,
    project: Project | undefined,
    perm: TurnPerm,
  ): Promise<void> {
    // Mid-turn: steer (引导) or queue (排队).
    const existing = active.get(sessionKey);
    if (existing) {
      // Download attachments first so the steered/queued turn carries local
      // paths. The session is already held by a running turn, so no reservation
      // race; if the turn finishes while downloading, fall through to a fresh
      // reserved run with the same prepared input.
      const rec = await getSession(sessionKey);
      const needsCloudDoc = turnNeedsTopicCloudDocFolder(msg, text, project, flat);
      let cloudDoc = cloudDocFolderForSession(project, rec, flat);
      if (needsCloudDoc && !cloudDoc.cloudDocFolder) {
        const requesterName = rec?.topicRequesterName ?? (await resolveNames(channel, [rec?.topicRequesterOpenId ?? msg.senderId])).get(rec?.topicRequesterOpenId ?? msg.senderId);
        cloudDoc = await ensureTopicCloudDocFolderForSession(project, sessionKey, {
          title: rec?.topicTitle ?? rec?.summary ?? deriveTopicTitle(text),
          requesterOpenId: rec?.topicRequesterOpenId ?? msg.senderId,
          requesterName,
          existing: rec?.cloudDocFolder,
        });
      }
      const rawInput = await collectTurnInput(msg, text, rec?.cwd ?? project?.cwd ?? fallbackCwd);
      const inputText = await weaveTopicContextForTurn(msg, rawInput.text ?? text, flat, false, rec?.lastSeenAt);
      void patchSession(sessionKey, { lastSeenAt: msgTime(msg) }).catch(() => undefined);
      const input = withCloudDocFolderHint({ ...rawInput, text: inputText }, cloudDoc.cloudDocFolder, cloudDoc.cloudDocFolderError, needsCloudDoc);
      const cur = active.get(sessionKey);
      if (!cur) {
        startReservedRun(msg, text, sessionKey, flat, project, perm, input);
        return;
      }
      if (getPendingPolicy(cfg) === 'steer' && cur.run && cur.thread) {
        const tid = cur.run.turnId();
        if (tid) {
          try {
            await cur.thread.steer(input, tid);
            log.info('intake', 'steer', { tid, images: input.images?.length ?? 0, files: messageHasFiles(msg) });
            return;
          } catch (err) {
            log.warn('intake', 'steer-failed', { err: String(err) });
          }
        }
      }
      cur.queue.push(input);
      log.info('intake', 'queued', { depth: cur.queue.length });
      return;
    }

    startReservedRun(msg, text, sessionKey, flat, project, perm);
  }

  /**
   * Reserve `sessionKey` synchronously (before any await) so a second message
   * racing in through the SDK's per-chatId queue sees it and queues instead of
   * double-launching — including a message whose image download just finished
   * and discovered the prior run had ended (handleTurn's fall-through). The
   * synchronous check-then-set is the critical section; everything slow (image
   * download, thread resolution, the codex run) runs **detached** so onMessage
   * returns fast — holding the chatId queue would block sibling topics and the
   * ⏹ card-action (design: 话题=独立 session，应并行).
   */
  function startReservedRun(
    msg: NormalizedMessage,
    text: string,
    sessionKey: string,
    flat: boolean,
    project: Project | undefined,
    perm: TurnPerm,
    preloadedInput?: AgentInput,
  ): void {
    const existing = active.get(sessionKey);
    if (existing) {
      // A run appeared between handleTurn's check and here (we awaited
      // attachment download) — queue onto it rather than launch a second turn.
      existing.queue.push(preloadedInput ?? { text });
      log.info('intake', 'queued', { depth: existing.queue.length });
      return;
    }
    const reserved: ActiveState = { queue: [], requesterOpenId: msg.senderId };
    active.set(sessionKey, reserved);
    void withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      const reaction = runReaction(msg.messageId, !sema.hasFree());
      try {
        const needsCloudDoc = turnNeedsTopicCloudDocFolder(msg, text, project, flat);
        let rec = await getSession(sessionKey);
        const priorLastSeenAt = rec?.lastSeenAt;
        let runCloudDocFolder = usableCloudDocFolder(rec?.cloudDocFolder);
        let runCloudDocFolderError = rec?.cloudDocFolderError;
        if (needsCloudDoc && !runCloudDocFolder && rec) {
          const requesterName =
            rec.topicRequesterName ?? (await resolveNames(channel, [rec.topicRequesterOpenId ?? msg.senderId])).get(rec.topicRequesterOpenId ?? msg.senderId);
          const cloudDoc = await ensureTopicCloudDocFolderForSession(project, sessionKey, {
            title: rec.topicTitle ?? rec.summary ?? deriveTopicTitle(text),
            requesterOpenId: rec.topicRequesterOpenId ?? msg.senderId,
            requesterName,
            existing: rec.cloudDocFolder,
          });
          runCloudDocFolder = cloudDoc.cloudDocFolder;
          runCloudDocFolderError = cloudDoc.cloudDocFolderError;
          rec = await getSession(sessionKey);
        }
        let thread = await resolveThread(sessionKey, msg.chatId, { mode: perm.mode, network: perm.network, autoCompact: perm.autoCompact });
        const freshSession = !thread || recreatedSessions.delete(sessionKey);
        let sessionCwd = rec?.cwd;
        if (!thread) {
          // Unknown session (created before this bridge, or store lost): treat as
          // a fresh session bound to the resolved cwd.
          const cwd = await prepareSessionCwd(project, sessionKey, fallbackCwd, { flat });
          const topicTitle = deriveTopicTitle(text);
          const requesterName = (await resolveNames(channel, [msg.senderId])).get(msg.senderId);
          const cloudDoc = flat && !project?.private
            ? { cloudDocFolder: usableCloudDocFolder(project?.cloudDocFolder) }
            : needsCloudDoc
              ? await prepareTopicCloudDocFolder(project, {
                  title: topicTitle,
                  requesterOpenId: msg.senderId,
                  requesterName,
                })
              : {};
          sessionCwd = cwd;
          thread = await backend.startThread({
            cwd,
            mode: perm.mode,
            network: perm.network,
            autoCompact: perm.autoCompact,
            cloudDocFolder: cloudDoc.cloudDocFolder,
            mcpServers: enabledProjectMcpServers(project),
          });
          sessions.set(sessionKey, thread);
          runCloudDocFolder = cloudDoc.cloudDocFolder;
          runCloudDocFolderError = cloudDoc.cloudDocFolderError;
          await upsertSession({
            threadId: sessionKey,
            chatId: msg.chatId,
            cwd,
            codexThreadId: thread.codexThreadId,
            summary: topicTitle,
            topicRequesterOpenId: msg.senderId,
            topicRequesterName: requesterName,
            cloudDocFolder: cloudDoc.cloudDocFolder,
            cloudDocFolderError: cloudDoc.cloudDocFolder ? '' : cloudDoc.cloudDocFolderError,
            lastSeenAt: msgTime(msg),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        rec = await getSession(sessionKey);
        sessionCwd = rec?.cwd ?? sessionCwd;
        runCloudDocFolder = usableCloudDocFolder(rec?.cloudDocFolder) ?? runCloudDocFolder;
        runCloudDocFolderError = rec?.cloudDocFolderError ?? runCloudDocFolderError;
        const rawInput = preloadedInput ?? (await collectTurnInput(msg, text, sessionCwd ?? (flat ? project?.cwd : fallbackCwd) ?? fallbackCwd));
        const firstText = await weaveTopicContextForTurn(msg, rawInput.text ?? text, flat, freshSession, priorLastSeenAt);
        void patchSession(sessionKey, { lastSeenAt: msgTime(msg) }).catch(() => undefined);
        const runInput = { ...rawInput, text: firstText };
        const input = withCloudDocFolderHint(runInput, runCloudDocFolder, runCloudDocFolderError, needsCloudDoc);
        reserved.thread = thread;
        await trackLaunch(launchRun(
          {
            chatId: msg.chatId,
            replyTo: msg.messageId,
            replyInThread: !flat,
            flat,
            thread,
            firstText: input.text ?? text,
            images: input.images,
            knownThreadId: sessionKey,
            cwd: sessionCwd ?? (flat ? project?.cwd : undefined),
            projectName: project?.name,
            cloudDocFolder: runCloudDocFolder,
            cloudDocFolderError: runCloudDocFolderError,
            requesterOpenId: msg.senderId,
          },
          reaction,
        ));
      } catch (err) {
        active.delete(sessionKey); // release the reservation so the session isn't wedged
        reaction.done();
        log.fail('intake', err);
        await channel
          .send(msg.chatId, { markdown: `❌ ${err instanceof Error ? err.message : String(err)}` }, { replyTo: msg.messageId, replyInThread: !flat })
          .catch(() => undefined);
      }
    });
  }

  /** Reuse an in-memory codex thread, else resume from the persisted store.
   * `perm` carries the bound project's CURRENT permission tier (mode/network),
   * applied when we (re)start a thread here. A LIVE thread keeps the sandbox it
   * was started with (codex binds it at thread/start and never re-reads it), so
   * a tier change can only take effect by EVICTING the live thread first — see
   * evictLiveSessionsForChat, called from the 🔐 权限 handlers. Without that
   * eviction the fast-path below would silently keep a 'full' thread running
   * after the admin switched to read-only. */
  async function resolveThread(
    threadId: string,
    chatId: string,
    perm?: { mode?: PermissionMode; network?: boolean; autoCompact?: boolean },
  ): Promise<AgentThread | undefined> {
    const live = sessions.get(threadId);
    if (live) return live;
    const rec = await getSession(threadId);
    if (!rec) return undefined;
    const project = await getProjectByChatId(chatId);
    const cloudDoc = project?.private
      ? rec.topicRequesterOpenId && rec.cloudDocFolder?.token
        ? await prepareTopicCloudDocFolder(project, {
            title: rec.topicTitle ?? rec.summary,
            requesterOpenId: rec.topicRequesterOpenId,
            requesterName: rec.topicRequesterName,
            existing: rec.cloudDocFolder,
          })
        : { cloudDocFolder: usableCloudDocFolder(rec.cloudDocFolder), cloudDocFolderError: rec.cloudDocFolderError }
      : (project?.kind ?? 'multi') === 'single'
        ? { cloudDocFolder: usableCloudDocFolder(project?.cloudDocFolder) }
        : rec.topicRequesterOpenId && rec.cloudDocFolder?.token
          ? await prepareTopicCloudDocFolder(project, {
              title: rec.topicTitle ?? rec.summary,
              requesterOpenId: rec.topicRequesterOpenId,
              requesterName: rec.topicRequesterName,
              existing: rec.cloudDocFolder,
            })
          : { cloudDocFolder: usableCloudDocFolder(rec.cloudDocFolder), cloudDocFolderError: rec.cloudDocFolderError };
    if (cloudDoc.cloudDocFolder || cloudDoc.cloudDocFolderError) {
      await patchSession(threadId, {
        cloudDocFolder: cloudDoc.cloudDocFolder,
        cloudDocFolderError: cloudDoc.cloudDocFolder ? '' : cloudDoc.cloudDocFolderError,
      }).catch(() => undefined);
    }
    try {
      const resumed = await backend.resumeThread({
        cwd: rec.cwd,
        codexThreadId: rec.codexThreadId,
        model: rec.model,
        effort: rec.effort,
        serviceTier: rec.serviceTier,
        mode: perm?.mode,
        network: perm?.network,
        autoCompact: perm?.autoCompact,
        cloudDocFolder: cloudDoc.cloudDocFolder,
        mcpServers: enabledProjectMcpServers(project),
      });
      sessions.set(threadId, resumed);
      return resumed;
    } catch (err) {
      log.fail('agent', err, { phase: 'resume-on-turn', threadId });
      const cwd = rec.cwd ?? (await prepareSessionCwd(project, threadId, fallbackCwd));
      const fresh = await backend.startThread({
        cwd,
        model: rec.model,
        effort: rec.effort,
        serviceTier: rec.serviceTier,
        mode: perm?.mode ?? (project ? effectiveMode(project) : undefined),
        network: perm?.network ?? (project ? effectiveNetwork(project) : undefined),
        autoCompact: perm?.autoCompact ?? project?.autoCompact,
        cloudDocFolder: cloudDoc.cloudDocFolder,
        mcpServers: enabledProjectMcpServers(project),
      });
      sessions.set(threadId, fresh);
      recreatedSessions.add(threadId);
      return fresh;
    }
  }

  /**
   * Close every LIVE codex thread under `chatId` so a permission-tier change
   * actually rebinds. The codex sandbox is fixed at thread/start|resume and is
   * immutable for the thread's life — so an already-running 'full' thread would
   * keep full-disk read access even after the admin switches the project to
   * read-only. Evicting forces the next turn's resolveThread to re-resume under
   * the new tier (or fail-closed where it can't be enforced).
   */
  async function evictLiveSessionsForChat(chatId: string): Promise<void> {
    let closed = 0;
    for (const rec of await listSessions()) {
      if (rec.chatId !== chatId) continue;
      const live = sessions.get(rec.threadId);
      if (!live) continue;
      sessions.delete(rec.threadId);
      void live.close().catch(() => undefined);
      closed++;
    }
    if (closed) log.info('console', 'tier-evict', { chatId, closed });
  }

  /** Group @bot (no topic): create a titled topic + run with the default model.
   * Detached — onMessage must return fast (see {@link handleTurn}); a new
   * topic has a unique reply target so no same-topic reservation is needed. */
  function startTopicDirectly(msg: NormalizedMessage, text: string, project?: Project): void {
    void withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      // 🫳 Typing on receive (⏳ OneSecond if a slot isn't free) → ✅ DONE once
      // the topic is created (onTopicCreated, below). For this path the acked
      // action is "建话题", not the full reply — so DONE fires on first card,
      // unlike an in-topic turn (see handleTurn).
      const reaction = runReaction(msg.messageId, !sema.hasFree());
      const cwd = await prepareSessionCwd(project, msg.messageId, fallbackCwd);
      // The topic creator's role decides this new topic's tier; roleSuffix (when
      // tiers are split) namespaces the persisted session so the other role gets
      // its own thread on its first message (see turnSession / adoptThreadId).
      const perm = turnPerm(project, msg.senderId);
      // lazy banner branch refresh (design §3.2) — best-effort, non-blocking
      if (project) void refreshBranch(channel, project).catch(() => undefined);
      const { model, effort, serviceTier } = pickDefault(await listModels());
      const firstText = text || '你好，我们开始吧。';
      const topicTitle = deriveTopicTitle(firstText);
      const requesterName = (await resolveNames(channel, [msg.senderId])).get(msg.senderId);
      const needsCloudDoc = turnNeedsTopicCloudDocFolder(msg, firstText, project, false);
      const cloudDoc = needsCloudDoc
        ? await prepareTopicCloudDocFolder(project, {
            title: topicTitle,
            requesterOpenId: msg.senderId,
            requesterName,
          })
        : {};
      let thread: AgentThread;
      try {
        thread = await backend.startThread({
          cwd,
          model,
          effort,
          serviceTier,
          mode: perm.mode,
          network: perm.network,
          autoCompact: perm.autoCompact,
          cloudDocFolder: cloudDoc.cloudDocFolder,
          mcpServers: enabledProjectMcpServers(project),
        });
      } catch (err) {
        reaction.done();
        log.fail('card', err, { phase: 'start-topic' });
        await channel
          .send(msg.chatId, { markdown: `❌ 启动失败：${err instanceof Error ? err.message : String(err)}` }, { replyTo: msg.messageId })
          .catch(() => undefined);
        return;
      }
      // Download any attached/forwarded media so the opening turn can see it.
      const rawInput = await collectTurnInput(msg, firstText, cwd);
      const input = withCloudDocFolderHint(rawInput, cloudDoc.cloudDocFolder, cloudDoc.cloudDocFolderError, needsCloudDoc);
      log.info('card', 'start', {
        project: project?.name ?? '(unregistered)',
        model,
        effort,
        serviceTier,
        images: input.images?.length ?? 0,
        files: messageHasFiles(msg),
        title: topicTitle,
        cloudDocFolder: cloudDoc.cloudDocFolder?.token ?? null,
        cloudDocFolderError: cloudDoc.cloudDocFolderError ?? null,
      });
      await trackLaunch(launchRun(
        {
          chatId: msg.chatId,
          replyTo: msg.messageId,
          replyInThread: true,
          topicTitle,
          topicRequesterOpenId: msg.senderId,
          topicRequesterName: requesterName,
          thread,
          firstText: input.text ?? firstText,
          images: input.images,
          model,
          effort,
          serviceTier,
          cwd,
          projectName: project?.name,
          summary: topicTitle,
          cloudDocFolder: cloudDoc.cloudDocFolder,
          cloudDocFolderError: cloudDoc.cloudDocFolder ? '' : cloudDoc.cloudDocFolderError,
          requesterOpenId: msg.senderId,
          lastSeenAt: msgTime(msg),
          roleSuffix: perm.roleSuffix,
        },
        reaction,
        () => reaction.done(), // topic created → ✅ DONE (don't wait for the reply)
      ));
    }).catch((err) => log.fail('intake', err));
  }

  function startPrivateGroup(msg: NormalizedMessage, text: string, parent: Project): void {
    void withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      const reaction = runReaction(msg.messageId, !sema.hasFree());
      try {
        const mentionedParticipants = mentionedPrivateParticipants(msg.senderId, msg.mentions);
        const participantIds = mentionedParticipants.map((p) => p.openId);
        const names = await resolveNames(channel, [msg.senderId, ...participantIds]);
        const participants: PrivateParticipant[] = [
          { openId: msg.senderId, name: names.get(msg.senderId) ?? msg.senderName },
          ...mentionedParticipants.map((p) => ({ openId: p.openId, name: p.name ?? names.get(p.openId) })),
        ];
        const taskText = parsePrivateTaskText(text, msg.mentions);
        const title = deriveTopicTitle(taskText || '私密协作');
        const privateProject = await createPrivateProject(channel, {
          parent,
          title,
          ownerOpenId: msg.senderId,
          participantOpenIds: participantIds,
          sourceThreadId: msg.threadId,
          sourceMessageId: msg.messageId,
        });
        const joinedIds = new Set(privateProject.participants ?? [msg.senderId]);
        const actualParticipants = participants.filter((p) => joinedIds.has(p.openId));
        const failedParticipants = participants.filter((p) => p.openId !== msg.senderId && !joinedIds.has(p.openId));
        await sendManagedCard(
          channel,
          msg.chatId,
          buildPrivateCreatedCard({ title, projectName: parent.name, participants: actualParticipants, failedParticipants }),
          msg.messageId,
          Boolean(msg.threadId),
        ).catch((err) => log.fail('card', err, { phase: 'private-created-card' }));

        const intro = await sendManagedCard(
          channel,
          privateProject.chatId,
          buildPrivateIntroCard({
            title,
            parentProjectName: parent.name,
            participants: actualParticipants,
            failedParticipants,
            sourceThreadId: msg.threadId,
          }),
        );
        const requesterName = actualParticipants[0]?.name;
        const needsCloudDoc = turnNeedsTopicCloudDocFolder(msg, taskText, privateProject, true);
        const cloudDoc = needsCloudDoc
          ? await prepareTopicCloudDocFolder(privateProject, {
              title,
              requesterOpenId: msg.senderId,
              requesterName,
            })
          : {};
        const { model, effort, serviceTier } = pickDefault(await listModels());
        const perm = turnPerm(privateProject, msg.senderId);
        const thread = await backend.startThread({
          cwd: privateProject.cwd,
          model,
          effort,
          serviceTier,
          mode: perm.mode,
          network: perm.network,
          autoCompact: perm.autoCompact,
          cloudDocFolder: cloudDoc.cloudDocFolder,
          mcpServers: enabledProjectMcpServers(privateProject),
        });
        sessions.set(privateProject.chatId, thread);

        const sourceHistory = msg.threadId
          ? await fetchThreadContext(channel, msg.threadId, {
              excludeMessageId: msg.messageId,
              limit: 12,
            })
          : [];
        const sourceText = privateSourcePrompt({
          taskText,
          parentProjectName: parent.name,
          parentChatId: parent.chatId,
          sourceThreadId: msg.threadId,
          sourceMessageId: msg.messageId,
          participants: actualParticipants,
        });
        const rawInput = await collectTurnInput(msg, weaveThreadHistory(sourceText, sourceHistory), privateProject.cwd);
        const input = withCloudDocFolderHint(rawInput, cloudDoc.cloudDocFolder, cloudDoc.cloudDocFolderError, needsCloudDoc);
        const now = Date.now();
        await upsertSession({
          threadId: privateProject.chatId,
          chatId: privateProject.chatId,
          cwd: privateProject.cwd,
          codexThreadId: thread.codexThreadId,
          model,
          effort,
          serviceTier,
          summary: title,
          topicTitle: title,
          topicRequesterOpenId: msg.senderId,
          topicRequesterName: requesterName,
          cloudDocFolder: cloudDoc.cloudDocFolder,
          cloudDocFolderError: cloudDoc.cloudDocFolder ? '' : cloudDoc.cloudDocFolderError,
          lastSeenAt: msgTime(msg),
          createdAt: now,
          updatedAt: now,
        });
        active.set(privateProject.chatId, { thread, queue: [], requesterOpenId: msg.senderId });
        log.info('intake', 'private-start', {
          parent: parent.name,
          private: privateProject.name,
          participants: actualParticipants.length,
          failedParticipants: failedParticipants.length,
          cloudDocFolder: cloudDoc.cloudDocFolder?.token ?? null,
        });
        void trackLaunch(
          launchRun({
            chatId: privateProject.chatId,
            replyTo: intro.messageId,
            flat: true,
            knownThreadId: privateProject.chatId,
            thread,
            firstText: input.text ?? sourceText,
            images: input.images,
            model,
            effort,
            serviceTier,
            cwd: privateProject.cwd,
            projectName: privateProject.name,
            summary: title,
            cloudDocFolder: cloudDoc.cloudDocFolder,
            cloudDocFolderError: cloudDoc.cloudDocFolder ? '' : cloudDoc.cloudDocFolderError,
            requesterOpenId: msg.senderId,
            lastSeenAt: msgTime(msg),
          }),
        ).catch((err) => {
          active.delete(privateProject.chatId);
          log.fail('intake', err, { phase: 'private-launch' });
        });
        reaction.done();
      } catch (err) {
        reaction.done();
        log.fail('intake', err, { phase: 'private-create' });
        await channel
          .send(
            msg.chatId,
            { markdown: `❌ 创建私密协作群失败：${err instanceof Error ? err.message : String(err)}` },
            { replyTo: msg.messageId, replyInThread: Boolean(msg.threadId) },
          )
          .catch(() => undefined);
      }
    }).catch((err) => log.fail('intake', err, { phase: 'private-trace' }));
  }

  async function sendTopicTitleMessage(chatId: string, title: string, requester?: TopicRequester): Promise<string | undefined> {
    try {
      const sent = await channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: formatTopicTitleMessage(title, requester) }),
        },
      });
      const messageId = (sent as { data?: { message_id?: string } }).data?.message_id;
      if (!messageId) log.warn('intake', 'topic-title-message-missing-id', { title });
      return messageId;
    } catch (err) {
      log.fail('intake', err, { phase: 'topic-title-message' });
      return undefined;
    }
  }

  async function listResumeThreads(project: Project | undefined, cwd: string): Promise<{
    threads: ThreadSummary[];
    threadCwds: Record<string, string>;
  }> {
    const byId = new Map<string, ThreadSummary>();
    const threadCwds: Record<string, string> = {};
    if (project && isIsolatedTopicWorkspace(project)) {
      for (const s of (await listSessions()).filter((x) => x.chatId === project.chatId)) {
        byId.set(s.codexThreadId, {
          codexThreadId: s.codexThreadId,
          preview: s.summary,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          name: s.topicTitle ?? s.summary,
        });
        threadCwds[s.codexThreadId] = s.cwd;
      }
    }
    for (const t of await backend.listThreads(cwd)) {
      if (!byId.has(t.codexThreadId)) byId.set(t.codexThreadId, t);
      if (!threadCwds[t.codexThreadId]) threadCwds[t.codexThreadId] = cwd;
    }
    const threads = [...byId.values()].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    return { threads, threadCwds };
  }

  /** Group @bot /resume: post the history picker for this project. Owner-only
   * (admins[]) — 恢复会话会改变上下文，属管理类命令；非管理员收到无权限提示。 */
  async function postResumeCard(msg: NormalizedMessage): Promise<void> {
    if (!isAdmin(cfg, msg.senderId)) {
      await denyAdminCommand(msg, 'resume');
      return;
    }
    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      const project = await getProjectByChatId(msg.chatId);
      const cwd = project?.cwd ?? fallbackCwd;
      const { threads, threadCwds } = await listResumeThreads(project, cwd);
      const state: ResumeCardState = {
        chatId: msg.chatId,
        originalMsgId: msg.messageId,
        requesterOpenId: msg.senderId,
        cwd,
        projectName: project?.name,
        threads,
        threadCwds,
        createdAt: Date.now(),
      };
      const res = await sendManagedCard(channel, msg.chatId, buildResumeCard(state), msg.messageId);
      pruneResumePending();
      resumePending.set(res.messageId, state);
      log.info('card', 'resume', { project: project?.name ?? '(unregistered)', threads: threads.length });
    });
  }

  /** @bot /model: post the model/effort picker for the session keyed by
   * `sessionKey` (topic threadId for multi, chatId for single). */
  async function postModelCard(msg: NormalizedMessage, sessionKey: string, inThread: boolean): Promise<void> {
    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      const [models, rec] = await Promise.all([listModels(), getSession(sessionKey)]);
      const def = pickDefault(models);
      const state: ModelCardState = {
        chatId: msg.chatId,
        threadId: sessionKey,
        requesterOpenId: msg.senderId,
        models,
        model: rec?.model ?? def.model,
        effort: rec?.effort ?? def.effort,
        serviceTier: rec?.serviceTier ?? def.serviceTier,
        createdAt: Date.now(),
      };
      const res = await sendManagedCard(channel, msg.chatId, buildModelCard(state), msg.messageId, inThread);
      pruneModelPending();
      modelPending.set(res.messageId, state);
      log.info('card', 'model', { threadId: sessionKey, model: state.model, effort: state.effort, serviceTier: state.serviceTier ?? null });
    });
  }

  async function postContextCard(msg: NormalizedMessage, sessionKey: string, inThread: boolean): Promise<void> {
    const u = lastUsage.get(sessionKey);
    await sendManagedCard(channel, msg.chatId, buildContextCard(u?.used ?? 0, u?.window ?? null), msg.messageId, inThread).catch(
      (err) => log.fail('card', err, { phase: 'context' }),
    );
  }

  const COMPACT_ANIM_INTERVAL_MS = 800;

  async function runCompact(
    msg: NormalizedMessage,
    sessionKey: string,
    inThread: boolean,
    perm: TurnPerm,
  ): Promise<void> {
    const reply = (markdown: string): Promise<void> =>
      channel
        .send(msg.chatId, { markdown }, { replyTo: msg.messageId, replyInThread: inThread })
        .then(() => undefined, () => undefined);

    if (active.get(sessionKey)) {
      await reply('⏳ 这一轮还在跑，结束后再 `/compact`。');
      return;
    }
    const thread = await resolveThread(sessionKey, msg.chatId, {
      mode: perm.mode,
      network: perm.network,
      autoCompact: perm.autoCompact,
    });
    if (!thread) {
      await reply('这个会话还没开始，先发条消息聊两句再 `/compact`。');
      return;
    }

    let cardMsgId: string | undefined;
    try {
      const sent = await sendManagedCard(channel, msg.chatId, buildCompactingCard(0), msg.messageId, inThread);
      cardMsgId = sent.messageId;
    } catch (err) {
      log.fail('card', err, { phase: 'compact-start-card' });
    }

    let stop = false;
    const wakers: Array<() => void> = [];
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolveSleep) => {
        const t = setTimeout(resolveSleep, ms);
        wakers.push(() => {
          clearTimeout(t);
          resolveSleep();
        });
      });
    const anim = (async () => {
      let tick = 0;
      while (!stop && cardMsgId) {
        await sleep(COMPACT_ANIM_INTERVAL_MS);
        if (stop || !cardMsgId) break;
        tick++;
        await updateManagedCard(channel, cardMsgId, buildCompactingCard(tick)).catch(() => undefined);
      }
    })();

    const settle = async (result: object): Promise<void> => {
      stop = true;
      wakers.forEach((w) => w());
      await anim;
      if (cardMsgId && (await updateManagedCard(channel, cardMsgId, result))) return;
      await sendManagedCard(channel, msg.chatId, result, msg.messageId, inThread).catch((err) =>
        log.fail('card', err, { phase: 'compact-settle' }),
      );
    };

    const before = lastUsage.get(sessionKey) ?? null;
    try {
      const { usage } = await thread.compact();
      if (usage) lastUsage.set(sessionKey, { used: usage.usedTokens, window: usage.contextWindow });
      else lastUsage.delete(sessionKey);
      log.info('intake', 'compact', { sessionKey, used: usage?.usedTokens ?? null, before: before?.used ?? null });
      await settle(buildCompactedCard(usage, before));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const unsupported = /method not found|-32601|unknown (method|request)|compact/i.test(message);
      log.fail('intake', err, { phase: 'compact' });
      await settle(buildCompactFailedCard(unsupported ? '当前 Codex 版本不支持 /compact，请升级后再试。' : message));
    }
  }

  async function renameTopic(msg: NormalizedMessage, text: string): Promise<void> {
    const threadId = msg.threadId;
    if (!threadId) return;
    const title = parseRenameTitle(text);
    if (!title) {
      await channel
        .send(msg.chatId, { markdown: '用法：`/rename 新话题名`' }, { replyTo: msg.messageId, replyInThread: true })
        .catch(() => undefined);
      return;
    }
    const rec = await getSession(threadId);
    const titleMessageId = rec?.topicTitleMessageId ?? (await findTopicTitleMessageId(channel, threadId));
    if (!titleMessageId) {
      await channel
        .send(
          msg.chatId,
          { markdown: '这个话题没有可重命名的标题消息。只有新版自动短标题创建的话题支持 `/rename`。' },
          { replyTo: msg.messageId, replyInThread: true },
        )
        .catch(() => undefined);
      return;
    }
    try {
      await channel.rawClient.im.v1.message.update({
        path: { message_id: titleMessageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({
            text: formatTopicTitleMessage(title, {
              openId: rec?.topicRequesterOpenId,
              name: rec?.topicRequesterName,
            }),
          }),
        },
      });
      const sessionPatch: Partial<Omit<SessionRecord, 'threadId'>> = {
        summary: title,
        topicTitle: title,
        topicTitleMessageId: titleMessageId,
      };
      let folderRenameStatus: 'renamed' | 'failed' | 'none' = 'none';
      let folderRenameError = '';
      if (rec?.cloudDocFolder?.token) {
        const renamed = await renameTopicCloudDocFolder(rec.cloudDocFolder, {
          title,
          requesterName: rec.topicRequesterName,
        });
        if (renamed.folder) {
          sessionPatch.cloudDocFolder = renamed.folder;
          sessionPatch.cloudDocFolderError = '';
          folderRenameStatus = 'renamed';
        } else {
          folderRenameError = renamed.error ?? '话题云文档目录重命名失败';
          sessionPatch.cloudDocFolderError = folderRenameError;
          folderRenameStatus = 'failed';
        }
      }
      await patchSession(threadId, sessionPatch);
      const tail =
        folderRenameStatus === 'renamed'
          ? '\n云文档子文件夹已同步重命名。'
          : folderRenameStatus === 'failed'
            ? `\n\n⚠️ 云文档子文件夹重命名失败：${folderRenameError}`
            : '';
      await channel
        .send(msg.chatId, { markdown: `已重命名为：${title}${tail}` }, { replyTo: msg.messageId, replyInThread: true })
        .catch(() => undefined);
      log.info('intake', 'topic-rename', { threadId, title, folder: folderRenameStatus });
    } catch (err) {
      log.fail('intake', err, { phase: 'topic-rename', threadId });
      await channel
        .send(
          msg.chatId,
          { markdown: `重命名失败：${err instanceof Error ? err.message : String(err)}` },
          { replyTo: msg.messageId, replyInThread: true },
        )
        .catch(() => undefined);
    }
  }

  async function renamePrivateProject(msg: NormalizedMessage, text: string, project: Project): Promise<void> {
    if (!(await canManageProjectSettings(project, msg.senderId))) {
      await channel
        .send(msg.chatId, { markdown: '⚠️ `/rename` 仅私密群发起人或管理员可用。' }, { replyTo: msg.messageId })
        .catch(() => undefined);
      return;
    }

    const title = parseRenameTitle(text);
    if (!title) {
      await channel.send(msg.chatId, { markdown: '用法：`/rename 新私密群名`' }, { replyTo: msg.messageId }).catch(() => undefined);
      return;
    }

    try {
      const rec = await getSession(project.chatId);
      await renameChat(channel, project.chatId, title);

      const sourceId = project.sourceThreadId ?? project.sourceMessageId ?? project.chatId;
      const registryName = project.parentProjectName
        ? privateProjectName({ name: project.parentProjectName }, title, sourceId)
        : title;
      const renamedProject = (await renameProject(project.name, registryName)) ?? { ...project, name: registryName };

      const sessionPatch: Partial<Omit<SessionRecord, 'threadId'>> = {
        summary: title,
        topicTitle: title,
      };
      let folderRenameStatus: 'renamed' | 'failed' | 'none' = 'none';
      let folderRenameError = '';
      if (rec?.cloudDocFolder?.token) {
        const renamed = await renameTopicCloudDocFolder(rec.cloudDocFolder, {
          title,
          requesterName: rec.topicRequesterName,
        });
        if (renamed.folder) {
          sessionPatch.cloudDocFolder = renamed.folder;
          sessionPatch.cloudDocFolderError = '';
          folderRenameStatus = 'renamed';
        } else {
          folderRenameError = renamed.error ?? '私密群云文档目录重命名失败';
          sessionPatch.cloudDocFolderError = folderRenameError;
          folderRenameStatus = 'failed';
        }
      }
      await patchSession(project.chatId, sessionPatch);
      await setAnnouncement(channel, renamedProject).catch((err) => log.fail('project', err, { phase: 'private-rename-announcement' }));

      const tail =
        folderRenameStatus === 'renamed'
          ? '\n云文档子文件夹已同步重命名。'
          : folderRenameStatus === 'failed'
            ? `\n\n⚠️ 云文档子文件夹重命名失败：${folderRenameError}`
            : '';
      await channel.send(msg.chatId, { markdown: `已重命名为：${title}${tail}` }, { replyTo: msg.messageId }).catch(() => undefined);
      log.info('intake', 'private-rename', { chatId: project.chatId, title, folder: folderRenameStatus });
    } catch (err) {
      log.fail('intake', err, { phase: 'private-rename', chatId: project.chatId });
      await channel
        .send(msg.chatId, { markdown: `重命名失败：${err instanceof Error ? err.message : String(err)}` }, { replyTo: msg.messageId })
        .catch(() => undefined);
    }
  }

  /** `/help`: post the command cheat-sheet for the caller's current scope. */
  async function postHelpCard(
    msg: NormalizedMessage,
    scope: HelpScope,
    inThread = false,
    project?: Project,
  ): Promise<void> {
    const noMention = project ? (project.noMention ?? defaultNoMention(project)) : true;
    const canManageSettings = project ? await canManageProjectSettings(project, msg.senderId) : isAdmin(cfg, msg.senderId);
    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      await sendManagedCard(channel, msg.chatId, buildHelpCard(scope, noMention, canManageSettings), msg.messageId, inThread).catch((err) =>
        log.fail('card', err, { cmd: 'help', scope }),
      );
      log.info('card', 'help', { scope });
    });
  }

  // ── card actions ──────────────────────────────────────────────────
  const dispatcher = new CardDispatcher(channel, cfg);
  const PENDING_TTL_MS = 30 * 60_000; // abandoned config cards expire after 30 min

  // A card update issued from inside a cardAction handler must land AFTER Feishu
  // is done with the click's interaction window — Feishu locks the card during
  // that window and discards an update that arrives inside it (official "处理卡片
  //回调"). A hard collision throws cardkit err 200810 (caught + retried below);
  // but a near-miss returns HTTP 200 yet the *client* still snaps the card back
  // to its pre-click state — silent, so the 200810 retry never fires and the
  // update is simply lost (symptom: "点一下没反应 / 要点两下"). We learned 150ms is
  // inside that soft window; 500ms clears it reliably. These console cards aren't
  // high-frequency, so the latency is worth the determinism. Cards must be
  // CardKit entities (sendManagedCard) for the update to target them —
  // im.v1.message.patch only does "unconditional".
  const CARD_SETTLE_MS = 500;
  // `c` may be a card object or a (possibly async) builder. Passing a builder
  // lets a handler return *immediately* (so the SDK acks the click's callback
  // right away, closing the interaction window) while any slow work — API
  // calls, createProject — runs inside the settle, after the ack. Awaiting slow
  // work in the handler instead holds the callback open and the next click's
  // update collides with the still-open window (err 200810 → revert).
  //
  // `fallbackChatId`: byMessageId mappings are per-process (lost on restart), so
  // a card sent before a restart is an orphan — updateManagedCard finds no entity
  // and no-ops, leaving a dead card (the "返回菜单又没用了" after I restart). When a
  // chatId is given we self-heal by posting a fresh managed card instead (no
  // recall — the stale one just sits above).
  const settleUpdate = (
    msgId: string,
    c: object | (() => object | Promise<object>),
    fallbackChatId?: string,
  ): void => {
    const armedAt = Date.now();
    void (async () => {
      await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
      const card = typeof c === 'function' ? await c() : c;
      const ok = await updateManagedCard(channel, msgId, card);
      log.info('console', 'settle-update', { msgId, ok, waitedMs: Date.now() - armedAt, fallback: !ok && !!fallbackChatId });
      if (!ok && fallbackChatId) {
        await sendManagedCard(channel, fallbackChatId, card).catch((err) =>
          log.fail('console', err, { phase: 'settle-fallback' }),
        );
      }
    })();
  };
  function pruneResumePending(): void {
    const now = Date.now();
    for (const [k, s] of resumePending) if (now - s.createdAt > PENDING_TTL_MS) resumePending.delete(k);
  }
  function pruneModelPending(): void {
    const now = Date.now();
    for (const [k, s] of modelPending) if (now - s.createdAt > PENDING_TTL_MS) modelPending.delete(k);
  }

  /**
   * Resolve + authorize a command-card (/model, /resume) action. Only the
   * original requester may act on their card (design §5); chat/user must still
   * be allowed; expired cards are dropped.
   */
  function authPending<T extends { createdAt: number; requesterOpenId: string; chatId: string }>(
    map: Map<string, T>,
    evt: CardActionEvent,
  ): T | undefined {
    const state = map.get(evt.messageId);
    if (!state) return undefined;
    if (Date.now() - state.createdAt > PENDING_TTL_MS) {
      map.delete(evt.messageId);
      return undefined;
    }
    const op = evt.operator?.openId ?? '';
    if (op !== state.requesterOpenId || !isChatAllowed(cfg, state.chatId)) {
      log.info('card', 'action-denied', { reason: 'not-allowed' });
      return undefined;
    }
    return state;
  }

  dispatcher
    .on(MC.model, ({ evt, option }) => {
      const state = authPending(modelPending, evt);
      if (!state || !option) return;
      settleUpdate(evt.messageId, async () => {
        state.model = option;
        // re-pick a valid effort if the new model doesn't support the current one
        const m = state.models.find((x) => x.id === option);
        if (m && m.supportedEfforts.length && !m.supportedEfforts.includes(state.effort)) {
          state.effort = m.defaultEffort;
        }
        if (state.serviceTier !== 'fast') {
          state.serviceTier = 'standard';
        }
        await patchSession(state.threadId, { model: state.model, effort: state.effort, serviceTier: state.serviceTier });
        state.note = `✅ 已切换模型「${m?.displayName ?? option}」，下一轮生效`;
        return buildModelCard(state);
      });
    })
    .on(MC.effort, ({ evt, option }) => {
      const state = authPending(modelPending, evt);
      if (!state || !option) return;
      settleUpdate(evt.messageId, async () => {
        state.effort = option as ReasoningEffort;
        await patchSession(state.threadId, { effort: state.effort });
        state.note = '✅ 已设置推理，下一轮生效';
        return buildModelCard(state);
      });
    })
    .on(MC.speed, ({ evt, option }) => {
      const state = authPending(modelPending, evt);
      if (!state || !option) return;
      settleUpdate(evt.messageId, async () => {
        state.serviceTier = option;
        await patchSession(state.threadId, { serviceTier: state.serviceTier });
        state.note = '✅ 已设置速度，下一轮生效';
        return buildModelCard(state);
      });
    })
    .on(RES.pick, ({ evt, value }) => {
      const state = authPending(resumePending, evt);
      const codexThreadId = typeof value.t === 'string' ? value.t : undefined;
      if (!state || !codexThreadId || state.launching) return;
      state.launching = true;
      settleUpdate(evt.messageId, buildResumeLaunchingCard(state));
      // detach: don't hold the cardAction callback for the whole resume + run
      void resumeFromCard(evt, state, codexThreadId);
    });

  /** Run-card actions: gated by chat/user allow lists (design §5). */
  const runAllowed = (evt: CardActionEvent): boolean => isChatAllowed(cfg, evt.chatId);
  /**
   * Owner-or-admin gate for run-card controls. Killing/altering someone else's
   * run is destructive (design §5: 杀别人的 run 限 admins), and `allowedUsers`
   * defaults to "everyone", so the allow-list alone is not enough. Only the run
   * starter (requester) or an admin may ⏹/⚙️ it.
   */
  const runOwnerOrAdmin = (evt: CardActionEvent, ownerOpenId?: string): boolean => {
    if (!runAllowed(evt)) return false;
    const op = evt.operator?.openId ?? '';
    return op === ownerOpenId || isAdmin(cfg, op);
  };

  // run card buttons (design §3.3). ⏹ aborts the codex turn AND ends the local
  // consume loop (st.interrupt) — codex emits no mappable terminal on
  // turn/interrupt, so waiting on the backend would hang the card forever.
  dispatcher
    .on(RC.stop, ({ evt, value }) => {
      const key = typeof value.m === 'string' ? value.m : evt.messageId;
      const st = runsByCard.get(key);
      if (!st) {
        if (!runAllowed(evt)) return;
        log.info('card', 'stale-run-stop', { key });
        void channel
          .send(
            evt.chatId,
            { markdown: 'ℹ️ 这张运行卡片已经不在当前后台进程里，通常是后台重启或任务已结束。请重新发送指令。' },
            { replyTo: evt.messageId },
          )
          .catch((err) => log.fail('card', err, { phase: 'stale-run-stop-reply' }));
        return;
      }
      if (!runOwnerOrAdmin(evt, st.requesterOpenId)) {
        void channel
          .send(evt.chatId, { markdown: '⚠️ 只有本轮发起人或管理员可以终止这次运行。' }, { replyTo: evt.messageId })
          .catch((err) => log.fail('card', err, { phase: 'run-stop-denied-reply' }));
        return;
      }
      st.interruptReason = 'user';
      st.interrupt?.();
      log.info('card', 'action', { actionId: 'run.stop', stopped: Boolean(st.interrupt) });
    });

  // DM management console buttons (design §3.1). Admin-gated; sub-views patch
  // the same card in place, each carrying a ⬅️ 菜单 back button.
  const dmAdmin = (openId?: string): boolean => isAdmin(cfg, openId ?? '');
  // DM cards are CardKit entities (sendManagedCard); update them via the
  // settle-then-cardkit path so the click's callback acks first. Passing the
  // whole evt lets settleUpdate self-heal an orphaned (post-restart) card by
  // re-posting to evt.chatId.
  const patch = (evt: CardActionEvent, c: object | (() => object | Promise<object>)): void =>
    settleUpdate(evt.messageId, c, evt.chatId);

  /** open_id→姓名 三级兜底（管理员/白名单卡展示用）：
   *  1) resolveNames：contact.batch（需 contact:user.base:readonly）；
   *  2) 项目群成员名：im:chat:readonly 已开就够，含外部成员，是 contact 没开时的主力；
   *  3) 卡片回调自带的操作者姓名（若 operator 带 name）。都拿不到才降级尾号。 */
  const namesWithOperator = async (
    evt: CardActionEvent,
    ids: (string | undefined)[],
  ): Promise<Map<string, string>> => {
    const m = await resolveNames(channel, ids);
    if (ids.some((id) => id && !m.has(id))) {
      for (const mem of await fetchAllProjectMembers(channel)) if (!m.has(mem.openId)) m.set(mem.openId, mem.name);
    }
    const op = evt.operator as { openId?: string; name?: string } | undefined;
    if (op?.openId && op.name && !m.has(op.openId)) m.set(op.openId, op.name);
    return m;
  };

  function applyPref(evt: CardActionEvent, mut: (p: AppPreferences) => void): void {
    if (!dmAdmin(evt.operator?.openId)) return;
    const prefs: AppPreferences = { ...(cfg.preferences ?? {}) };
    mut(prefs);
    cfg.preferences = prefs;
    // persist in the background; the card only needs the in-memory cfg
    void saveConfig(cfg).catch((err) => log.fail('console', err, { phase: 'save-config' }));
    patch(evt, buildSettingsCard(cfg));
  }

  // Back-to-menu: the settings card is button-only (never locks) and the
  // new-project form isn't locked until it's submitted, so 返回 always lands on
  // a card we can update in place — no recall, no fresh entity needed.
  const freshMenu = (evt: CardActionEvent): void => {
    patch(evt, buildDmMenuCard());
  };

  // 📊 Codex 用量：loading 卡先落地（取数走网络 1~3s），结果再原地覆盖。错误按
  // UsageError.kind 渲染对应的提示卡（未登录 / API-key 模式 / 需重登 / 波动重试）。
  // 孤儿卡自愈（与 settleUpdate 的 fallbackChatId 同语义）：重启后 byMessageId 映射
  // 已丢，updateManagedCard 返回 false（不抛错、.catch 兜不住）——loading 阶段就改发
  // 一张新卡并把结果更新指向它，否则旧菜单卡上这颗按钮就是「点了毫无反应」的死按钮。
  const runUsage = (evt: CardActionEvent, force: boolean): void => {
    if (!dmAdmin(evt.operator?.openId)) return;
    void (async () => {
      await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
      let msgId = evt.messageId;
      const okLoading = await updateManagedCard(channel, msgId, buildUsageCard({ phase: 'loading' })).catch(
        () => false,
      );
      if (!okLoading) {
        const sent = await sendManagedCard(channel, evt.chatId, buildUsageCard({ phase: 'loading' })).catch(
          (e) => {
            log.fail('console', e, { phase: 'usage-loading' });
            return undefined;
          },
        );
        if (!sent) return;
        msgId = sent.messageId;
      }
      let state: UsageCardState;
      try {
        state = { phase: 'ready', data: await fetchUsageBundle(force) };
      } catch (err) {
        log.fail('console', err, { phase: 'usage' });
        state = {
          phase: 'error',
          kind: err instanceof UsageError ? err.kind : 'transient',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      const ok = await updateManagedCard(channel, msgId, buildUsageCard(state)).catch((e) => {
        log.fail('console', e, { phase: 'usage-render' });
        return false;
      });
      if (!ok) {
        // 结果卡必须落地：原地更新失败（极小概率 loading 后实体又失效）就发新卡兜底
        await sendManagedCard(channel, evt.chatId, buildUsageCard(state)).catch((e) =>
          log.fail('console', e, { phase: 'usage-fallback' }),
        );
      }
    })();
  };

  const updateCardBase = (): { source: string; installCommand: string } => ({
    source: updateSourceLabel(),
    installCommand: manualInstallCommand(),
  });

  const replaceConsoleCard = async (evt: CardActionEvent, card: object, phase: string): Promise<string | undefined> => {
    const ok = await updateManagedCard(channel, evt.messageId, card).catch((e) => {
      log.fail('console', e, { phase });
      return false;
    });
    if (ok) return evt.messageId;
    const sent = await sendManagedCard(channel, evt.chatId, card).catch((e) => {
      log.fail('console', e, { phase: `${phase}-fallback` });
      return undefined;
    });
    return sent?.messageId;
  };

  const renderConsoleCard = async (chatId: string, msgId: string, card: object, phase: string): Promise<void> => {
    const ok = await updateManagedCard(channel, msgId, card).catch((e) => {
      log.fail('console', e, { phase });
      return false;
    });
    if (!ok) {
      await sendManagedCard(channel, chatId, card).catch((e) => log.fail('console', e, { phase: `${phase}-fallback` }));
    }
  };

  const runUpdateCheck = (evt: CardActionEvent): void => {
    if (!dmAdmin(evt.operator?.openId)) return;
    void (async () => {
      await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
      const msgId = await replaceConsoleCard(evt, buildUpdateCard({ phase: 'checking', ...updateCardBase() }), 'update-checking');
      if (!msgId) return;
      try {
        const state = await checkUpdate();
        await renderConsoleCard(evt.chatId, msgId, buildUpdateCard({ phase: 'checked', ...state }), 'update-checked');
        log.info('console', 'update-check', { current: state.current, latest: state.latest, source: state.source, dev: state.dev });
      } catch (err) {
        log.fail('console', err, { phase: 'update-check' });
        await renderConsoleCard(
          evt.chatId,
          msgId,
          buildUpdateCard({
            phase: 'error',
            message: err instanceof Error ? err.message : String(err),
            ...updateCardBase(),
          }),
          'update-check-error',
        );
      }
    })();
  };

  const runUpdateInstall = (evt: CardActionEvent): void => {
    if (!dmAdmin(evt.operator?.openId)) return;
    void (async () => {
      await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
      const from = currentVersion();
      const base = updateCardBase();
      if (isDevSource()) {
        const msgId = await replaceConsoleCard(
          evt,
          buildUpdateCard({
            phase: 'error',
            message: '当前是源码开发模式。请在终端用 git pull --ff-only && npm i && npm run build && feishu-codex-bridge restart 更新。',
            ...base,
          }),
          'update-dev-blocked',
        );
        if (msgId) log.info('console', 'update-dev-blocked');
        return;
      }
      const msgId = await replaceConsoleCard(evt, buildUpdateCard({ phase: 'updating', from, ...base }), 'update-updating');
      if (!msgId) return;
      const res = await installLatest();
      if (!res.ok) {
        await renderConsoleCard(
          evt.chatId,
          msgId,
          buildUpdateCard({ phase: 'error', message: res.message, ...base }),
          'update-error',
        );
        log.fail('console', new Error(res.message), { phase: 'update-install' });
        return;
      }
      const to = currentVersion();
      const willRestart = daemonRunning();
      await renderConsoleCard(
        evt.chatId,
        msgId,
        buildUpdateCard({ phase: 'done', from, to, willRestart, ...base }),
        'update-done',
      );
      log.info('console', 'update-install', { from, to, willRestart });
      if (willRestart) {
        setTimeout(() => {
          void restartDaemon().catch((err) => log.fail('console', err, { phase: 'update-restart' }));
        }, 500);
      }
    })();
  };

  // Build the project list card with each project's topics (sessions) grouped
  // by chatId, most-recent first — shared by the list/cancel/delete handlers.
  const renderProjectList = async (): Promise<object> => {
    const [projects, sessions] = await Promise.all([listProjects(), listSessions()]);
    const byChat = new Map<string, SessionRecord[]>();
    for (const s of sessions) {
      const arr = byChat.get(s.chatId);
      if (arr) arr.push(s);
      else byChat.set(s.chatId, [s]);
    }
    return buildProjectListCard(projects, byChat);
  };

  type ProjectSettingsInput = Parameters<typeof buildProjectSettingsCard>[0];

  async function projectSettingsCard(project: ProjectSettingsInput): Promise<object> {
    return buildProjectSettingsCard(project);
  }

  dispatcher
    .on(DM.menu, ({ evt }) => {
      if (dmAdmin(evt.operator?.openId)) freshMenu(evt);
    })
    .on(DM.newProject, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      if (!cfg.preferences?.localWorkspaceRoot) {
        patch(evt, buildWorkspaceRootFormCard({ error: '请先设置本地工作根目录，再新建项目' }));
        return;
      }
      patch(evt, buildNewProjectFormCard());
    })
    .on(DM.newProjectSubmit, ({ evt, formValue, value }) => {
      const op = evt.operator?.openId;
      if (!dmAdmin(op)) return;
      const name = String((formValue?.name as string) ?? '').trim();
      const cwdIn = String((formValue?.cwd as string) ?? '').trim();
      const cloudDocFolderIn = String((formValue?.cloud_doc_folder as string) ?? '').trim();
      const kind: 'multi' | 'single' = value.kind === 'single' ? 'single' : 'multi';
      // A submitted form locks its card_id (its buttons — retry/返回 on an error
      // re-render — stop firing, and an in-place update no-ops). So the result
      // goes to a *fresh* card; the submitted form stays above as a 留痕. Detach
      // so the submit callback acks immediately (createProject is slow).
      void (async () => {
        let result;
        if (!name) result = buildNewProjectFormCard({ cwd: cwdIn, cloudDocFolder: cloudDocFolderIn, error: '项目名不能为空' });
        else if (!op) result = buildNewProjectFormCard({ name, cwd: cwdIn, cloudDocFolder: cloudDocFolderIn, error: '无法识别操作者身份' });
        else {
          try {
            const cloudDocFolder = parseCloudDocFolder(cloudDocFolderIn);
            const p = await createProject(channel, {
              name,
              ownerOpenId: op,
              existingPath: cwdIn || undefined,
              workspaceRoot: cfg.preferences?.localWorkspaceRoot,
              kind,
              cloudDocFolder,
              ...cloudDocAccess(op),
            });
            log.info('console', 'new-project', { name: p.name, blank: p.blank });
            result = buildNewProjectDoneCard(p);
          } catch (err) {
            result = buildNewProjectFormCard({ name, cwd: cwdIn, cloudDocFolder: cloudDocFolderIn, error: err instanceof Error ? err.message : String(err) });
          }
        }
        await sendManagedCard(channel, evt.chatId, result).catch((e) =>
          log.fail('console', e, { phase: 'new-project-result' }),
        );
      })();
    })
    .on(DM.joinGroupSubmit, ({ evt, formValue, value }) => {
      const op = evt.operator?.openId;
      if (!dmAdmin(op)) return;
      const name = String((formValue?.name as string) ?? '').trim();
      const cwdIn = String((formValue?.cwd as string) ?? '').trim();
      const cloudDocFolderIn = String((formValue?.cloud_doc_folder as string) ?? '').trim();
      const chatId = typeof value.chatId === 'string' ? value.chatId : '';
      const kind: 'multi' | 'single' = value.kind === 'single' ? 'single' : 'multi';
      // Same fresh-card pattern as DM.newProjectSubmit: a submitted form locks
      // its card_id, so the result goes to a new card while the form stays above
      // as a 留痕. Detached so the click acks immediately (join is slow).
      void (async () => {
        let result;
        if (!chatId)
          result = buildJoinGroupFormCard({ chatId: '', name, cwd: cwdIn, cloudDocFolder: cloudDocFolderIn, error: '缺少群标识，请重新从进群通知里打开绑定卡' });
        else if (!name) result = buildJoinGroupFormCard({ chatId, cwd: cwdIn, cloudDocFolder: cloudDocFolderIn, error: '项目名不能为空' });
        else if (!op) result = buildJoinGroupFormCard({ chatId, name, cwd: cwdIn, cloudDocFolder: cloudDocFolderIn, error: '无法识别操作者身份' });
        else {
          try {
            const cloudDocFolder = parseCloudDocFolder(cloudDocFolderIn);
            const p = await joinExistingGroup(channel, {
              name,
              chatId,
              addedBy: op,
              existingPath: cwdIn || undefined,
              workspaceRoot: cfg.preferences?.localWorkspaceRoot,
              kind,
              cloudDocFolder,
              ...cloudDocAccess(op),
            });
            log.info('console', 'join-group', { name: p.name, blank: p.blank });
            result = buildNewProjectDoneCard(p);
          } catch (err) {
            result = buildJoinGroupFormCard({ chatId, name, cwd: cwdIn, cloudDocFolder: cloudDocFolderIn, error: err instanceof Error ? err.message : String(err) });
          }
        }
        await sendManagedCard(channel, evt.chatId, result).catch((e) =>
          log.fail('console', e, { phase: 'join-group-result' }),
        );
      })();
    })
    .on(DM.projects, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      // Project lists are often opened from older console cards in a busy DM.
      // Posting a fresh card keeps the result visible at the bottom instead of
      // relying on the mobile client to repaint an older in-place card.
      void (async () => {
        try {
          const card = await renderProjectList();
          await sendManagedCard(channel, evt.chatId, card);
          log.info('console', 'projects-list-sent');
        } catch (e) {
          log.fail('console', e, { phase: 'projects-list' });
        }
      })();
    })
    .on(DM.settings, async ({ evt }) => {
      if (dmAdmin(evt.operator?.openId)) await patch(evt, buildSettingsCard(cfg));
    })
    .on(DM.workspaceRootForm, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, buildWorkspaceRootFormCard({ current: cfg.preferences?.localWorkspaceRoot }));
    })
    .on(DM.workspaceRootSubmit, ({ evt, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const raw = String(formValue?.local_workspace_root ?? '').trim();
      void (async () => {
        try {
          const root = await normalizeWorkspaceRoot(raw);
          cfg.preferences = { ...(cfg.preferences ?? {}), localWorkspaceRoot: root };
          await saveConfig(cfg);
          log.info('console', 'workspace-root-set', { root });
          await sendManagedCard(channel, evt.chatId, buildSettingsCard(cfg)).catch((e) =>
            log.fail('console', e, { phase: 'workspace-root-result' }),
          );
        } catch (err) {
          const next = buildWorkspaceRootFormCard({
            current: raw || cfg.preferences?.localWorkspaceRoot,
            error: err instanceof Error ? err.message : String(err),
          });
          await sendManagedCard(channel, evt.chatId, next).catch((e) =>
            log.fail('console', e, { phase: 'workspace-root-error' }),
          );
        }
      })();
    })
    .on(DM.workspaceRootClear, ({ evt }) => {
      applyPref(evt, (p) => {
        delete p.localWorkspaceRoot;
      });
      log.info('console', 'workspace-root-clear');
    })
    .on(DM.doctor, async ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const codexBin = resolveCodexBin();
      // 飞书权限自检：读 keystore 里的 App Secret → 换 tenant_access_token → 查已开通
      // scope（application/v6/scopes 的 grant_status，含 im:message.group_msg 等事件订阅
      // 类）。任一步失败时 missingScopes 留 undefined，卡片显示「无法自动检查」而非误报
      // 缺失。复用 onboarding 同一条校验路径，单一事实源。
      const app = cfg.accounts.app;
      const secret = await getSecret(secretKeyForApp(app.id)).catch(() => undefined);
      const scopeCheck = secret
        ? await validateAppCredentials(app.id, secret, app.tenant).catch(() => undefined)
        : undefined;
      const eventDiagnosis = secret
        ? await diagnoseEventSubscription(app.id, secret, app.tenant).catch(() => undefined)
        : undefined;
      const missingScopes = scopeCheck?.missingScopes;
      const missingJoinScopes = scopeCheck?.missingJoinScopes;
      const missingCloudDocFolderScopes = scopeCheck?.missingCloudDocFolderScopes;
      const info: DoctorInfo = {
        codexOk: await backend.isAvailable().catch(() => false),
        codexVer: codexBin ? codexVersion(codexBin) : null,
        conn: channel.getConnectionStatus?.()?.state ?? 'unknown',
        bridgeVer: bridgeVersion(),
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        logStdout: serviceStdoutPath(),
        logStderr: serviceStderrPath(),
        configFile: paths.configFile,
        missingScopes,
        // 缺失时预选缺失项（精准开通）；查不到/全开通时预选全部必需 scope 供核对。
        scopeGrantUrl: buildScopeGrantUrl(
          app.id,
          app.tenant,
          missingScopes && missingScopes.length ? missingScopes : undefined,
        ),
        missingJoinScopes,
        // 「加入存量群」按钮恒预选这两项 opt-in scope（它们不在必需清单里）。
        joinScopeGrantUrl: buildScopeGrantUrl(app.id, app.tenant, JOIN_GROUP_SCOPES),
        missingCloudDocFolderScopes,
        cloudDocFolderScopeGrantUrl: buildScopeGrantUrl(app.id, app.tenant, CLOUD_DOC_FOLDER_SCOPES),
        eventDiagnosis,
        eventConfigUrl: buildEventConfigUrl(app.id, app.tenant),
      };
      // A reply card (not a patch of the menu) so the diagnosis persists below
      // the console; re-open the menu by messaging the bot.
      await sendManagedCard(channel, evt.chatId, buildDoctorCard(info), evt.messageId).catch((err) =>
        log.fail('console', err, { cmd: 'doctor' }),
      );
    })
    .on(DM.reconnect, async ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const conn = channel.getConnectionStatus?.()?.state ?? 'unknown';
      await channel
        .send(evt.chatId, { markdown: `🔄 长连接状态：**${conn}**\nSDK 会自动重连；若长期断开，请在终端重跑 \`feishu-codex-bridge run\`（前台）或 \`feishu-codex-bridge restart\`（后台守护）。` }, { replyTo: evt.messageId })
        .catch(() => undefined);
    })
    .on(DM.update, ({ evt }) => {
      runUpdateCheck(evt);
    })
    .on(DM.updateDo, ({ evt }) => {
      runUpdateInstall(evt);
    })
    // 📊 Codex 用量：loading → 并行拉 wham/usage + wham/profiles/me → 原地更新结果卡。
    // 同 DM.update 的双阶段模式：handler 立即返回让 SDK ack，慢活全在 settle 之后。
    .on(DM.usage, ({ evt }) => runUsage(evt, false))
    .on(DM.usageRefresh, ({ evt }) => runUsage(evt, true))
    // 分享：先弹「选择分享内容」表单卡（多选区块，不选=全部），提交后按所选区块
    // 动态拼装一张**新的**纯展示卡（不动控制台卡）——它零按钮、不再更新，数据定格
    // 在生成时刻，用户长按/右键即可原生转发（流式卡/带回调的卡转发会出问题）。
    .on(DM.usageShare, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, buildShareConfigCard());
    })
    .on(DM.usageShareDo, ({ evt, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const sections = parseShareSections(formValue?.secs);
      void (async () => {
        await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
        try {
          const data = await fetchUsageBundle();
          await sendManagedCard(channel, evt.chatId, buildUsageShareCard(data, { sections }), evt.messageId);
          log.info('console', 'usage-share', { sections: [...sections].join(',') });
          // 配置卡原地换成「已生成」态（带新表单，可换组合再来一张）
          await updateManagedCard(channel, evt.messageId, buildShareConfigCard(true)).catch(() => undefined);
        } catch (err) {
          log.fail('console', err, { phase: 'usage-share' });
          const reason = err instanceof UsageError ? err.message : '拉取用量数据失败';
          await channel
            .send(evt.chatId, { markdown: `⚠️ 生成分享卡失败：${reason}` }, { replyTo: evt.messageId })
            .catch(() => undefined);
        }
      })();
    })
    .on(DM.rmConfirm, async ({ evt, value }) => {
      const name = typeof value.n === 'string' ? value.n : undefined;
      if (!dmAdmin(evt.operator?.openId) || !name) return;
      const proj = (await listProjects()).find((p) => p.name === name);
      await patch(evt, buildRmConfirmCard(name, proj?.origin));
    })
    .on(DM.rmCancel, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, renderProjectList);
    })
    .on(DM.rmDo, ({ evt, value }) => {
      const name = typeof value.n === 'string' ? value.n : undefined;
      const op = evt.operator?.openId;
      if (!dmAdmin(op) || !name) return;
      // all the slow work (remove + owner transfer/leave + reply) runs in the
      // settle builder so the click acks immediately. The announcement vanishes
      // with the group once the owner dissolves it, so nothing to clean up here.
      patch(evt, async () => {
        const removed = await removeProject(name);
        let tail: string;
        if (removed && (removed.origin ?? 'created') === 'joined') {
          // joined group: the bot is a plain member, not the owner — it just
          // leaves (never disbands; the group is the user's). Best-effort.
          const left = removed.chatId
            ? await leaveChat(channel, removed.chatId)
                .then(() => true)
                .catch((err) => {
                  log.fail('console', err, { phase: 'leave-chat' });
                  return false;
                })
            : false;
          log.info('console', 'rm', { name, origin: 'joined', left });
          tail = left
            ? '我已退出该群（群是你们的，不会解散）。'
            : '⚠️ 我退群失败（可能权限不足），可在群里手动把我移除。';
        } else {
          let transferred = false;
          if (removed?.chatId && op) {
            transferred = await transferOwnership(channel, removed.chatId, op)
              .then(() => true)
              .catch((err) => {
                log.fail('console', err, { phase: 'owner-transfer' });
                return false;
              });
          }
          log.info('console', 'rm', { name, origin: 'created', transferred });
          tail = transferred
            ? '群主已转给你 → 请在飞书里**自行解散该群**（机器人不主动解散）。'
            : '⚠️ 群主转让失败（可能 bot 非群主），请用「🚪 群管理」手动转让后解散。';
        }
        await channel
          .send(evt.chatId, { markdown: `✅ 已删除项目「${name}」（解绑，未删代码目录）。\n${tail}` }, { replyTo: evt.messageId })
          .catch(() => undefined);
        return renderProjectList();
      });
    })
    // Each setting is a row of option buttons; the click's `v` is the chosen value.
    .on(DM.setTools, ({ evt, value }) => {
      applyPref(evt, (p) => (p.showToolCalls = value.v === 'on'));
    })
    .on(DM.setWatchdog, ({ evt, value }) => {
      const n = Number(value.v);
      if (Number.isFinite(n)) applyPref(evt, (p) => (p.runIdleTimeoutSeconds = n));
    })
    .on(DM.setPending, ({ evt, value }) => {
      if (value.v === 'steer' || value.v === 'queue') applyPref(evt, (p) => (p.pendingPolicy = value.v as PendingPolicy));
    })
    .on(DM.setConcurrency, ({ evt, value }) => {
      const n = Number(value.v);
      if (Number.isFinite(n)) applyPref(evt, (p) => (p.maxConcurrentRuns = n));
    })
    // In-group settings: toggle 免@ for the project bound to evt.chatId. Admin-gated.
    .on(GS.setNoMention, ({ evt, value }) => {
      const operatorOpenId = evt.operator?.openId;
      const on = value.v === 'on';
      patch(evt, async () => {
        const project = await getProjectByChatId(evt.chatId);
        if (project) {
          if (!(await canManageProjectSettings(project, operatorOpenId))) return buildGroupSettingsCard(project);
          await updateProject(project.name, { noMention: on });
          log.info('console', 'group-nomention', { project: project.name, on });
          return buildGroupSettingsCard({ ...project, noMention: on });
        }
        if (!isAdmin(cfg, operatorOpenId ?? '')) return buildGroupSettingsCard({ name: '本群', kind: 'multi' });
        return buildGroupSettingsCard({ name: '本群', kind: 'multi', noMention: on });
      });
    })
    .on(GS.setAutoCompact, ({ evt, value }) => {
      const operatorOpenId = evt.operator?.openId;
      const on = value.v === 'on';
      patch(evt, async () => {
        const project = await getProjectByChatId(evt.chatId);
        if (project) {
          if (!(await canManageProjectSettings(project, operatorOpenId))) return buildGroupSettingsCard(project);
          await updateProject(project.name, { autoCompact: on });
          await evictLiveSessionsForChat(project.chatId);
          log.info('console', 'group-autocompact', { project: project.name, on });
          return buildGroupSettingsCard({ ...project, autoCompact: on });
        }
        if (!isAdmin(cfg, operatorOpenId ?? '')) return buildGroupSettingsCard({ name: '本群', kind: 'multi' });
        return buildGroupSettingsCard({ name: '本群', kind: 'multi', autoCompact: on });
      });
    })
    // ── 权限管理回调（admins 全局 / 项目响应白名单）。均 dmAdmin 门控（私聊管理台）。
    // 列表卡用 patch 原地重渲染（纯按钮不锁）；加人是 form 提交，结果发**新卡**（旧表单
    // 留痕），规避 select 锁卡。owner 恒在 admins 名单顶、不可删。
    .on(DM.admins, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, async () =>
        buildAdminsCard(cfg, await namesWithOperator(evt, [resolveOwner(cfg), ...(cfg.preferences?.access?.admins ?? [])])),
      );
    })
    .on(DM.addAdminForm, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, async () => {
        const all = await fetchAllProjectMembers(channel);
        const members = all.filter((m) => !isAdmin(cfg, m.openId)); // 排除已是 admin/owner 的
        return buildAddAdminCard(members);
      });
    })
    .on(DM.addAdminSubmit, ({ evt, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const manual = String(formValue?.open_id ?? '').trim();
      const id = manual.startsWith('ou_') ? manual : pickOpenId(formValue);
      log.info('console', 'admin-add', { picked: id?.slice(-6) ?? null });
      void (async () => {
        if (id) {
          const access: AppAccess = { ...(cfg.preferences?.access ?? {}) };
          access.ownerOpenId ??= resolveOwner(cfg);
          access.admins = Array.from(new Set([...(access.admins ?? []), id]));
          cfg.preferences = { ...(cfg.preferences ?? {}), access };
          await saveConfig(cfg).catch((e) => log.fail('console', e, { phase: 'save-config' }));
        }
        const ids = [resolveOwner(cfg), ...(cfg.preferences?.access?.admins ?? [])];
        const next = buildAdminsCard(cfg, await namesWithOperator(evt, ids));
        await sendManagedCard(channel, evt.chatId, next).catch((e) => log.fail('console', e, { phase: 'admin-add-result' }));
      })();
    })
    .on(DM.rmAdmin, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const id = typeof value.u === 'string' ? value.u : '';
      patch(evt, async () => {
        if (id && id !== resolveOwner(cfg)) {
          const access: AppAccess = { ...(cfg.preferences?.access ?? {}) };
          access.ownerOpenId ??= resolveOwner(cfg);
          access.admins = (access.admins ?? []).filter((x) => x !== id);
          cfg.preferences = { ...(cfg.preferences ?? {}), access };
          await saveConfig(cfg).catch((e) => log.fail('console', e, { phase: 'save-config' }));
        }
        const ids = [resolveOwner(cfg), ...(cfg.preferences?.access?.admins ?? [])];
        return buildAdminsCard(cfg, await namesWithOperator(evt, ids));
      });
    })
    .on(DM.allowlist, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        if (!p) return buildDmMenuCard();
        return buildAllowlistCard(p, await namesWithOperator(evt, p.allowedUsers ?? []));
      });
    })
    .on(DM.addAllowedForm, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      if (!name) return;
      patch(evt, async () => {
        const p = await getProjectByName(name);
        const members = p?.chatId ? await fetchChatMembers(channel, p.chatId) : [];
        return buildAddAllowedCard(name, members);
      });
    })
    .on(DM.addAllowedSubmit, ({ evt, value, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      const manual = String(formValue?.open_id ?? '').trim();
      const id = manual.startsWith('ou_') ? manual : pickOpenId(formValue);
      log.info('console', 'allow-add', { project: name, picked: id?.slice(-6) ?? null });
      void (async () => {
        // 函数式 updater：在 registry 临界区内基于最新盘值 append 去重，避免并发丢更新。
        if (id) await updateProject(name, (p) => ({ allowedUsers: Array.from(new Set([...(p.allowedUsers ?? []), id])) }));
        const fresh = await getProjectByName(name); // 写后回读，卡片显示与盘上一致
        if (!fresh) return;
        const card = buildAllowlistCard(fresh, await namesWithOperator(evt, fresh.allowedUsers ?? []));
        await sendManagedCard(channel, evt.chatId, card).catch((e) => log.fail('console', e, { phase: 'allow-add-result' }));
      })();
    })
    .on(DM.rmAllowed, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const id = typeof value.u === 'string' ? value.u : '';
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        await updateProject(name, (p) => ({ allowedUsers: (p.allowedUsers ?? []).filter((x) => x !== id) }));
        const fresh = await getProjectByName(name); // 写后回读，与盘上一致
        if (!fresh) return buildDmMenuCard();
        return buildAllowlistCard(fresh, await namesWithOperator(evt, fresh.allowedUsers ?? []));
      });
    })
    // 项目设置卡（可扩展容器）：打开 + DM 版免@开关（携带项目名 n，不能靠 evt.chatId）。
    .on(DM.projectSettings, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        return p ? projectSettingsCard(p) : buildDmMenuCard();
      });
    })
    .on(DM.cloudDocFolderForm, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        return p ? buildCloudDocFolderFormCard(p) : buildDmMenuCard();
      });
    })
    .on(DM.cloudDocFolderSubmit, ({ evt, value, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      const raw = String((formValue?.cloud_doc_folder as string) ?? '').trim();
      void (async () => {
        const p = await getProjectByName(name);
        if (!p) return;
        let result;
        try {
          const cloudDocFolder = parseCloudDocFolder(raw);
          if (cloudDocFolder) {
            const permission = await grantProjectCloudDocFolderAccess(channel, cloudDocFolder, {
              ...cloudDocAccess(evt.operator?.openId),
              chatId: p.chatId,
            });
            cloudDocFolder.permission = permissionRecord(permission);
          }
          await updateProject(name, { cloudDocFolder });
          const fresh = await getProjectByName(name);
          result = fresh ? await projectSettingsCard(fresh) : buildDmMenuCard();
        } catch (err) {
          result = buildCloudDocFolderFormCard(p, { value: raw, error: err instanceof Error ? err.message : String(err) });
        }
        await sendManagedCard(channel, evt.chatId, result).catch((e) =>
          log.fail('console', e, { phase: 'cloud-doc-folder-result' }),
        );
      })();
    })
    .on(DM.cloudDocFolderClear, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        await updateProject(name, { cloudDocFolder: undefined });
        const fresh = await getProjectByName(name);
        return fresh ? projectSettingsCard(fresh) : buildDmMenuCard();
      });
    })
    .on(DM.foodMcpSet, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        if (!p) return buildDmMenuCard();
        log.info('console', 'food-mcp-ignored', { project: name });
        return projectSettingsCard(p);
      });
    })
    .on(DM.setNoMentionDm, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      const on = value.v === 'on';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        if (!p) return buildDmMenuCard();
        await updateProject(name, { noMention: on });
        return projectSettingsCard({ ...p, noMention: on });
      });
    })
    .on(DM.setAutoCompactDm, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      const on = value.v === 'on';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        if (!p) return buildDmMenuCard();
        await updateProject(name, { autoCompact: on });
        await evictLiveSessionsForChat(p.chatId);
        log.info('console', 'project-autocompact', { project: name, on });
        return projectSettingsCard({ ...p, autoCompact: on });
      });
    })
    // 🔐 权限：打开下拉表单子卡（管理员档 + 普通用户档 + 联网，选完提交）。
    .on(DM.permission, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        return p ? buildPermissionCard(p) : buildDmMenuCard();
      });
    })
    // 提交权限表单：落盘 管理员档 mode / 普通用户档 guestMode / 联网，再驱逐本项目活跃会话
    // 让新档立即生效（沙箱在 thread/start 绑定后不可变）。表单卡 card_id 提交后会锁，故发
    // 一张全新的项目设置卡（旧表单卡留痕），不 patch 原卡。
    .on(DM.permissionSubmit, ({ evt, value, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      const mode = asTier(selectValue(formValue, 'mode'));
      const guestMode = asTier(selectValue(formValue, 'guestMode'));
      const network = selectValue(formValue, 'network') === 'on';
      void (async () => {
        const p = await getProjectByName(name);
        if (!p) return;
        await updateProject(name, { ...(mode ? { mode } : {}), ...(guestMode ? { guestMode } : {}), network });
        await evictLiveSessionsForChat(p.chatId);
        log.info('console', 'permission', { project: name, mode, guestMode, network });
        const fresh = await getProjectByName(name); // 写后回读，卡片与盘上一致
        if (!fresh) return;
        await sendManagedCard(channel, evt.chatId, await projectSettingsCard(fresh)).catch((e) =>
          log.fail('console', e, { phase: 'permission-result' }),
        );
      })();
    });

  /**
   * From a /resume card: read the past thread's transcript, post a collapsible
   * history card as reply_in_thread (which creates the topic) and bind the codex
   * thread to that topic. No filler turn — the session resumes lazily on the
   * topic's first message via {@link resolveThread}, so the user just continues.
   * Detached — never holds the card-action callback for the whole flow. On
   * failure the picker card flips to a (non-retryable) error and pending clears.
   */
  async function resumeFromCard(evt: CardActionEvent, state: ResumeCardState, codexThreadId: string): Promise<void> {
    try {
      const selectedCwd = state.threadCwds?.[codexThreadId] ?? state.cwd;
      // thread/read: fetch the transcript without starting a turn or holding the
      // session live (model/effort left to the thread's own remembered config).
      // Never throws — empty history just yields a minimal card.
      const history = await backend.readHistory(selectedCwd, codexThreadId);
      resumePending.delete(evt.messageId);

      let bound = false;
      await withTrace({ chatId: state.chatId, msgId: state.originalMsgId }, async () => {
        const cardState: HistoryCardState = { cwd: selectedCwd, projectName: state.projectName, history };
        const requesterName = (await resolveNames(channel, [state.requesterOpenId])).get(state.requesterOpenId);
        const topicTitle = history.name || history.preview || '(恢复会话)';
        // reply_in_thread on the /resume message turns it into the topic; the
        // history card is that topic's first message.
        const sent = await sendManagedCard(channel, state.chatId, buildHistoryCard(cardState), state.originalMsgId, true);
        // Binding the codex thread to the topic hinges entirely on resolving the
        // topic thread_id (no live thread to fall back on, unlike the run path) —
        // a miss would make the next message start a FRESH empty session. The
        // reply response omits thread_id and the raw lookup can lag right after
        // the reply, so retry a few times before giving up.
        let tid: string | undefined;
        for (let attempt = 0; attempt < 4 && !tid; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
          tid = await getThreadId(channel, sent.messageId);
        }
        if (tid) {
          const now = Date.now();
          await upsertSession({
            threadId: tid,
            chatId: state.chatId,
            cwd: selectedCwd,
            codexThreadId,
            summary: topicTitle,
            topicTitle: topicTitle,
            topicRequesterOpenId: state.requesterOpenId,
            topicRequesterName: requesterName,
            createdAt: now,
            updatedAt: now,
          });
          bound = true;
        } else {
          log.warn('card', 'resume-no-threadid', { messageId: sent.messageId });
        }
        log.info('card', 'resume-done', { codexThreadId, threadId: tid ?? null, bound, turns: history.totalTurns });
      });

      // Only promise continuity once the thread is actually bound — else the
      // next message silently starts a fresh session, so say so instead of
      // claiming success. settleUpdate keeps this ordered after the launching
      // card the RES.pick handler settle-pushed (normally the done push runs
      // last; a 200810 retry on the launching push could in theory reorder, but
      // the 500ms settle window avoids that in practice).
      settleUpdate(
        evt.messageId,
        bound
          ? buildResumeDoneCard(state)
          : buildResumeErrorCard(state, '已建话题但未能绑定会话，请重新 /resume'),
      );
    } catch (err) {
      state.launching = false;
      log.fail('card', err, { phase: 'resume-launch' });
      settleUpdate(evt.messageId, buildResumeErrorCard(state, err instanceof Error ? err.message : String(err)));
    }
  }

  // ── shared run loop ───────────────────────────────────────────────
  interface LaunchOpts {
    chatId: string;
    replyTo: string;
    /** true on first reply that creates the topic; subsequent replies use replyTo only */
    replyInThread?: boolean;
    thread: AgentThread;
    firstText: string;
    /** local image paths for the FIRST turn (codex reads them as localImage) */
    images?: string[];
    /** when the topic thread_id is already known (turn in an existing topic) */
    knownThreadId?: string;
    model?: string;
    effort?: ReasoningEffort;
    serviceTier?: ServiceTier;
    cwd?: string;
    projectName?: string;
    summary?: string;
    /** main-group @bot path: send this bot-owned root message before creating the topic. */
    topicTitle?: string;
    topicRequesterOpenId?: string;
    topicRequesterName?: string;
    cloudDocFolder?: CloudDocFolder;
    cloudDocFolderError?: string;
    /** who triggered this run (for ⏹/⚙️ ownership gating) */
    requesterOpenId?: string;
    /** Feishu message timestamp already fed to Codex on this turn. */
    lastSeenAt?: number;
    /** single-session group: reply by quoting (no reply_in_thread / topic). */
    flat?: boolean;
    /** when admin/guest tiers are split: 'admin'|'guest' to namespace the
     * resolved topic key so the two roles never share a thread (see turnSession). */
    roleSuffix?: 'admin' | 'guest';
  }

  async function launchRun(
    opts: LaunchOpts,
    reaction?: RunReaction,
    onTopicCreated?: () => void,
  ): Promise<void> {
    const release = await sema.acquire();
    reaction?.started(); // slot acquired → flip OneSecond → Typing
    let firstCardSent = false;
    let activeKey = opts.knownThreadId ?? `pending:${opts.replyTo}`;
    let topicThreadId = opts.knownThreadId;
    let topicTitleMessageId: string | undefined;
    // Reuse the reservation handleTurn made for this session (so messages
    // queued during startup aren't lost); fall back to a fresh state otherwise.
    const state: ActiveState = active.get(activeKey) ?? { queue: [], requesterOpenId: opts.requesterOpenId };
    state.thread = opts.thread;
    if (opts.requesterOpenId) state.requesterOpenId = opts.requesterOpenId;
    active.set(activeKey, state);
    if (opts.knownThreadId) sessions.set(opts.knownThreadId, opts.thread);

    const persist = async (threadId: string): Promise<void> => {
      await upsertSession({
        threadId,
        chatId: opts.chatId,
        cwd: opts.cwd ?? fallbackCwd,
        codexThreadId: opts.thread.codexThreadId,
        model: opts.model,
        effort: opts.effort,
        serviceTier: opts.serviceTier,
        summary: opts.summary ?? opts.firstText.slice(0, 80),
        topicTitle: opts.topicTitle,
        topicTitleMessageId,
        topicRequesterOpenId: opts.topicRequesterOpenId,
        topicRequesterName: opts.topicRequesterName,
        cloudDocFolder: opts.cloudDocFolder,
        cloudDocFolderError: opts.cloudDocFolderError,
        lastSeenAt: opts.lastSeenAt,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }).catch(() => undefined);
    };

    /** Demote the previous turn's card (drop its ⚙️) and promote this one. */
    const promoteCard = (cardMsgId: string, rc: RunCardState): void => {
      if (!topicThreadId) return;
      const prev = lastRunCard.get(topicThreadId);
      if (prev && prev !== cardMsgId) {
        const prevState = runCards.get(prev);
        const prevStream = runStreams.get(prev);
        if (prevState && prevStream) void prevStream.updateCard(channel, buildRunCardPlain(prevState));
        runCards.delete(prev);
        runStreams.delete(prev);
      }
      lastRunCard.set(topicThreadId, cardMsgId);
      runCards.set(cardMsgId, rc);
    };

    // tracks the latest run card key so the finally can clear runsByCard even
    // if the stream producer throws mid-turn (avoids leaking a stale stop target)
    let curCardKey: string | undefined;
    let currentRun: {
      ctx: RunRecordContext;
      run?: AgentRun;
      state?: RunState;
      events?: number;
      textChars?: number;
      finished: boolean;
    } | undefined;
    const writeRunRecord = async (record: RunRecord): Promise<void> => {
      await appendRunRecord(record).catch((err) => log.warn('run-store', 'write-failed', { err: String(err) }));
    };
    const finishCurrentRun = async (terminal: RunState['terminal'] | 'bridge_error', bridgeError?: unknown): Promise<void> => {
      if (!currentRun || currentRun.finished) return;
      currentRun.finished = true;
      await writeRunRecord(
        finishedRunRecord(
          {
            ...currentRun.ctx,
            feishuThreadId: feishuThreadIdFromSessionKey(topicThreadId) ?? currentRun.ctx.feishuThreadId,
            cardMessageId: curCardKey ?? currentRun.ctx.cardMessageId,
            codexTurnId: currentRun.run?.turnId() ?? currentRun.ctx.codexTurnId,
          },
          {
            terminal,
            endedAt: new Date().toISOString(),
            state: currentRun.state,
            bridgeError,
            events: currentRun.events,
            textChars: currentRun.textChars,
          },
        ),
      );
    };
    try {
      let turnInput: AgentInput = { text: opts.firstText, images: opts.images };
      let replyTo = opts.replyTo;
      let replyInThread = opts.flat ? false : (opts.replyInThread ?? Boolean(opts.knownThreadId));
      if (opts.topicTitle && !opts.knownThreadId && !opts.flat && replyInThread) {
        topicTitleMessageId = await sendTopicTitleMessage(opts.chatId, opts.topicTitle, {
          openId: opts.topicRequesterOpenId,
          name: opts.topicRequesterName,
        });
        if (topicTitleMessageId) {
          active.delete(activeKey);
          activeKey = `pending:${topicTitleMessageId}`;
          active.set(activeKey, state);
          replyTo = topicTitleMessageId;
          log.info('intake', 'topic-title-root', { title: opts.topicTitle });
        }
      }
      for (;;) {
        // per-turn model/effort/speed: prefer latest persisted (⚙️ may have changed it)
        const rec = topicThreadId ? await getSession(topicThreadId) : undefined;
        const turnModel = rec?.model ?? opts.model;
        const turnEffort = rec?.effort ?? opts.effort;
        const turnServiceTier = rec?.serviceTier ?? opts.serviceTier;
        const turnCwd = opts.cwd ?? rec?.cwd ?? fallbackCwd;
        const requesterOpenId = opts.requesterOpenId ?? opts.topicRequesterOpenId ?? rec?.topicRequesterOpenId;
        const requesterName = opts.topicRequesterName ?? rec?.topicRequesterName;
        currentRun = {
          ctx: {
            runId: newRunId(),
            chatId: opts.chatId,
            replyToMessageId: replyTo,
            feishuThreadId: feishuThreadIdFromSessionKey(topicThreadId),
            codexThreadId: opts.thread.codexThreadId,
            projectName: opts.projectName,
            cwd: turnCwd,
            topicTitle: opts.topicTitle ?? rec?.topicTitle,
            requesterOpenId,
            requesterName,
            promptPreview: turnInput.text,
            startedAt: new Date().toISOString(),
          },
          finished: false,
        };
        state.restartNotice = {
          appId: cfg.accounts.app.id,
          chatId: opts.chatId,
          replyToMessageId: replyTo,
          replyInThread,
          feishuThreadId: feishuThreadIdFromSessionKey(topicThreadId),
          requesterOpenId,
          requesterName,
          projectName: opts.projectName,
          topicTitle: opts.topicTitle ?? rec?.topicTitle,
          promptPreview: turnInput.text,
          startedAt: currentRun.ctx.startedAt,
        };
        await writeRunRecord(startedRunRecord(currentRun.ctx));
        const run = opts.thread.runStreamed(turnInput, { model: turnModel, effort: turnEffort, serviceTier: turnServiceTier });
        currentRun.run = run;
        state.run = run;
        const render = new RunRender();
        render.showTools = getShowToolCalls(cfg);
        let cardMsgId: string | undefined;
        const rc: RunCardState = {
          rs: render.snapshot(),
          requesterOpenId: opts.requesterOpenId,
          showTools: render.showTools,
        };

        const adoptThreadId = async (messageId: string): Promise<void> => {
          if (activeKey.startsWith('pending:')) {
            const tid = await getThreadId(channel, messageId);
            if (tid) {
              // Logical session key = real Feishu topic id + role suffix (when
              // admin/guest tiers are split), so the two roles keep separate
              // threads in the same topic. Feishu reply targeting uses messageId,
              // not this key, so the suffix is purely bridge-internal.
              const key = opts.roleSuffix ? `${tid}#${opts.roleSuffix}` : tid;
              active.delete(activeKey);
              active.set(key, state);
              sessions.set(key, opts.thread);
              activeKey = key;
              topicThreadId = key;
              rc.threadId = key;
              if (currentRun) currentRun.ctx.feishuThreadId = tid;
              if (state.restartNotice) state.restartNotice.feishuThreadId = tid;
              await persist(key);
            }
          } else {
            topicThreadId = activeKey;
            rc.threadId = activeKey;
            if (currentRun) currentRun.ctx.feishuThreadId = feishuThreadIdFromSessionKey(activeKey);
            if (state.restartNotice) state.restartNotice.feishuThreadId = feishuThreadIdFromSessionKey(activeKey);
          }
        };

        // CardKit streaming entity: body streams with the native typewriter,
        // ⏹/⚙️ ride whole-card updates — both on one card_id (see RunCardStream).
        const stream = new RunCardStream();
        cardMsgId = await stream.create(channel, opts.chatId, buildRunCard(rc), { replyTo, replyInThread });
        curCardKey = cardMsgId;
        if (currentRun) currentRun.ctx.cardMessageId = cardMsgId;
        if (state.restartNotice) state.restartNotice.cardMessageId = cardMsgId;
        rc.cardKey = cardMsgId;
        runsByCard.set(cardMsgId, state);
        runStreams.set(cardMsgId, stream);
        await adoptThreadId(cardMsgId);
        // first card is live = topic created. The 群@bot 建话题 path flips its
        // reaction to DONE here (creating the topic is the acked action), unlike
        // an in-topic turn which holds Typing until the reply itself ends.
        if (!firstCardSent) {
          firstCardSent = true;
          try {
            onTopicCreated?.();
          } catch {
            /* reaction is best-effort */
          }
        }

        // ⏹ 终止 / watchdog: end the consume loop locally. codex emits no
        // mappable terminal on turn/interrupt — the event stream just hangs (see
        // log 08:48: a stopped card never finalized) — so we must not wait on the
        // backend. `stopSignal` ends the loop instantly (card flips to 已中断);
        // the dead turn's process is then recycled below.
        let timedOut = false;
        let interrupted = false;
        let resolveStop!: () => void;
        const stopSignal = new Promise<void>((res) => {
          resolveStop = res;
        });
        state.interrupt = () => {
          if (interrupted) return;
          interrupted = true;
          resolveStop();
        };
        const guarded = withIdleTimeout(
          run.events,
          idleMs,
          () => {
            timedOut = true;
          },
          stopSignal,
        );
        // Per-turn stream-latency observability (file log `stream.timing`): locates
        // where a reply lags — first byte, backlog (lastEv vs done), push split, RTT.
        const tStart = Date.now();
        let firstEvAt = 0;
        let firstTextAt = 0;
        let lastEvAt = tStart;
        let evCount = 0;
        let textChars = 0;
        for await (const ev of guarded) {
          const tEv = Date.now();
          if (!firstEvAt) firstEvAt = tEv;
          const et = (ev as { type?: string }).type;
          if (et === 'text_delta') {
            if (!firstTextAt) firstTextAt = tEv;
            const d = (ev as { delta?: string }).delta;
            if (typeof d === 'string') textChars += d.length;
          }
          lastEvAt = tEv;
          evCount++;
          if (et === 'context_usage' && topicThreadId) {
            const cu = ev as { usedTokens: number; contextWindow: number | null };
            lastUsage.set(topicThreadId, { used: cu.usedTokens, window: cu.contextWindow });
          } else if (et === 'context_compacted' && cardMsgId) {
            void sendManagedCard(channel, opts.chatId, buildAutoCompactCard(), cardMsgId, !opts.flat).catch((err) =>
              log.fail('card', err, { phase: 'auto-compact-notice' }),
            );
          }
          render.apply(ev);
          rc.rs = render.snapshot();
          // Non-blocking: never stall event consumption on a round-trip. The pump
          // coalesces and routes the latest snapshot — answer text → element
          // typewriter (cardElement.content), structure → whole-card update.
          stream.streamCoalesced(channel, buildRunCard(rc), ANSWER_EID);
        }
        const doneAt = Date.now(); // codex stopped emitting / loop ended
        await stream.drain(); // flush the last coalesced frame before terminal
        const interruptReason = state.interruptReason ?? 'user';
        state.interrupt = undefined; // turn done; nothing left to interrupt
        state.interruptReason = undefined;
        const killed = interrupted || timedOut;
        if (timedOut) render.timeout(Math.max(1, Math.round(idleMs / 60_000)));
        else if (interrupted) render.interrupt(interruptReason);
        else render.finalize();
        rc.rs = render.snapshot();
        if (currentRun) currentRun.state = rc.rs;

        // A killed turn leaves codex mid-turn with a notification stream that
        // never terminates. Recycle the process: closing it ends the stream
        // cleanly (no orphaned reader stealing the next turn's events) and frees
        // the turn. The topic resumes from the persisted thread on its next
        // message (resolveThread), so the session survives the kill.
        if (killed) {
          void opts.thread.close().catch(() => undefined);
          if (topicThreadId) sessions.delete(topicThreadId);
        }

        const finalMsgId = cardMsgId;
        await adoptThreadId(finalMsgId);
        rc.cardKey = finalMsgId;

        // Outbound images + 卡片围栏 — only at terminal (uploads are slow; while
        // streaming, ![](path) refs and ```feishu-card fences show as text). Scan
        // the final answer once: upload every image ref (cached; covers both the
        // run-card's inline images and any clean-card images), then post each
        // ```feishu-card fence as a standalone clean card. Best-effort: a failed
        // upload leaves the original markdown in place, a failed card is logged.
        const answerText = finalMessageText(rc.rs);
        const { fences } = extractCardFences(answerText);
        const imgSources = imageSources(answerText);
        if (imgSources.length > 0) {
          rc.images = await uploadOutboundImages(channel, imgSources, turnCwd);
        }

        // terminal whole-card update: final render with streaming off (clears the
        // typewriter cursor) and no ⏹ button.
        await stream.updateCard(channel, buildRunCard(rc));
        // One-line per-turn timeline; all ms are relative to the turn's stream start.
        {
          const terminalAt = Date.now();
          const st = stream.stats();
          log.info('stream', 'timing', {
            firstEv: firstEvAt ? firstEvAt - tStart : -1,
            firstText: firstTextAt ? firstTextAt - tStart : -1,
            lastEv: lastEvAt - tStart,
            done: doneAt - tStart,
            terminal: terminalAt - tStart,
            doneToTerminal: terminalAt - doneAt,
            events: evCount,
            textChars,
            pushes: st.pushCount,
            cardPushes: st.cardPushes,
            elPushes: st.elPushes,
            rttAvg: st.pushCount ? Math.round(st.totalRttMs / st.pushCount) : 0,
            rttMax: st.maxRttMs,
          });
        }
        runsByCard.delete(cardMsgId);
        promoteCard(finalMsgId, rc);
        if (currentRun) {
          currentRun.state = rc.rs;
          currentRun.events = evCount;
          currentRun.textChars = textChars;
        }
        await finishCurrentRun(render.terminal());
        currentRun = undefined;
        state.restartNotice = undefined;

        for (const fence of fences) {
          try {
            await sendManagedCard(channel, opts.chatId, buildCleanCard(fence, rc.images), finalMsgId, !opts.flat);
          } catch (err) {
            log.fail('card', err, { phase: 'clean-card' });
          }
        }
        if (topicThreadId) await patchSession(topicThreadId, { updatedAt: Date.now() });
        replyTo = finalMsgId;
        replyInThread = !opts.flat; // stay in the topic for queued turns (single: stay flat)
        log.info('card', 'final', { terminal: render.terminal() });

        // A kill (⏹ / watchdog) stops the whole run — drop any queued follow-ups
        // (they'd run on the recycled, now-closed thread).
        if (killed) break;
        if (state.queue.length === 0) break;
        turnInput = state.queue.shift()!;
      }
    } catch (err) {
      await finishCurrentRun('bridge_error', err);
      log.fail('intake', err);
      await channel
        .send(opts.chatId, { markdown: `❌ ${err instanceof Error ? err.message : String(err)}` }, { replyTo: opts.replyTo, replyInThread: !opts.flat })
        .catch(() => undefined);
    } finally {
      active.delete(activeKey);
      if (curCardKey) runsByCard.delete(curCardKey);
      reaction?.done(); // run ended (complete / ⏹ / timeout / error) → ✅ DONE
      release();
    }
  }

  // ── cloud-doc comments ────────────────────────────────────────────
  /**
   * `comment` event: someone @-mentioned the bot in a Feishu doc comment
   * (drive.notice.comment_add_v1). There's no streaming card here — we mark the
   * triggering reply with a "Typing" reaction, run one codex turn, and post the
   * answer back into the same comment thread. One codex thread per document
   * (keyed `doc:<fileToken>`), so repeated @-mentions in a doc continue the same
   * conversation; it shares the session store + concurrency semaphore with the
   * group run loop. Comment runs aren't interruptible (no ⏹ card) — the idle
   * watchdog is the only kill switch.
   */
  const onComment = async (evt: CommentEvent): Promise<void> => {
    await withTrace({ chatId: 'comment' }, async () => {
      const dedupeKey = `comment:${evt.fileToken}:${evt.commentId}:${evt.replyId ?? ''}`;
      if (seenInbound.seen(dedupeKey)) {
        log.info('comment', 'dedupe', {
          doc: evt.fileToken,
          commentId: evt.commentId,
          replyId: evt.replyId ?? null,
        });
        return;
      }

      log.info('comment', 'enter', {
        doc: evt.fileToken,
        fileType: evt.fileType,
        commentId: evt.commentId,
        replyId: evt.replyId ?? null,
        mentionedBot: evt.mentionedBot,
        sender: evt.operator.openId,
      });
      if (!evt.mentionedBot) return log.info('comment', 'skip', { reason: 'not-mentioned' });
      if (!SUPPORTED_FILE_TYPES.has(evt.fileType))
        return log.info('comment', 'skip', { reason: 'unsupported-fileType', fileType: evt.fileType });
      // 响应白名单已下沉到项目级；云文档评论无项目维度，保持现状（所有人可 @bot 评论）。

      const resolved = await resolveComment(channel, evt);
      if (!resolved) return log.info('comment', 'skip', { reason: 'no-target-or-empty' });
      const { target, ctx } = resolved;
      log.info('comment', 'parsed', { isWhole: ctx.isWhole, hasQuote: Boolean(ctx.quote) });

      const prompt = buildCommentPrompt(target, ctx, cfg.accounts.app.tenant);
      const sessionKey = `doc:${evt.fileToken}`;

      // Best-effort "received" feedback up-front (comments have no streaming
      // UI). Added before the per-doc lock so a queued mention still acks
      // immediately; cleared in the finally regardless of how the run ends.
      const reacted = ctx.targetReplyId
        ? await addCommentReaction(channel, target, ctx.targetReplyId)
        : false;

      try {
        // Serialize per document: one codex thread can't run two turns at once
        // (they'd both consume the thread's single app-server notification
        // stream and steal each other's events), so concurrent @-mentions in
        // the SAME doc must queue. Different docs run in parallel (distinct
        // threads); the global cap is still `sema`, acquired inside the lock.
        await withDocLock(sessionKey, async () => {
          const release = await sema.acquire();
          try {
            const thread = await resolveDocThread(sessionKey, ctx.question);
            const rec = await getSession(sessionKey);
            const run = thread.runStreamed({ text: prompt }, { model: rec?.model, effort: rec?.effort, serviceTier: rec?.serviceTier });
            const runCtx: RunRecordContext = {
              runId: newRunId(),
              chatId: sessionKey,
              replyToMessageId: evt.replyId ?? evt.commentId,
              feishuThreadId: sessionKey,
              codexThreadId: thread.codexThreadId,
              projectName: '云文档评论',
              cwd: rec?.cwd ?? fallbackCwd,
              requesterOpenId: evt.operator.openId,
              promptPreview: ctx.question,
              startedAt: new Date().toISOString(),
            };
            let runRecordFinished = false;
            const finishCommentRun = async (
              terminal: RunState['terminal'] | 'bridge_error',
              state: RunState | undefined,
              bridgeError?: unknown,
              events?: number,
              textChars?: number,
            ): Promise<void> => {
              if (runRecordFinished) return;
              runRecordFinished = true;
              await appendRunRecord(
                finishedRunRecord(
                  { ...runCtx, codexTurnId: run.turnId() },
                  { terminal, endedAt: new Date().toISOString(), state, bridgeError, events, textChars },
                ),
              ).catch((err) => log.warn('run-store', 'write-failed', { err: String(err) }));
            };
            await appendRunRecord(startedRunRecord(runCtx)).catch((err) =>
              log.warn('run-store', 'write-failed', { err: String(err) }),
            );

            let state: RunState = initialState;
            let timedOut = false;
            let evCount = 0;
            let textChars = 0;
            const guarded = withIdleTimeout(run.events, idleMs, () => {
              timedOut = true;
            });
            try {
              for await (const ev of guarded) {
                evCount++;
                if (ev.type === 'text_delta') textChars += ev.delta.length;
                state = reduce(state, ev);
              }

              if (timedOut) {
                state = markIdleTimeout(state, Math.max(1, Math.round(idleMs / 60_000)));
                const tid = run.turnId();
                // Recycle the thread so the hung turn's never-terminating stream
                // doesn't poison the next comment; the doc resumes from the
                // persisted thread on its next @-mention. Fire-and-forget the
                // interrupt — turn/interrupt is an unbounded JSON-RPC round-trip,
                // and close() SIGKILLs the child anyway, so awaiting it here would
                // pin both the per-doc lock and a global semaphore slot if it
                // hangs. sessions.delete stays synchronous + before release() so
                // the next queued same-doc comment always starts fresh.
                if (tid) void thread.abort(tid).catch(() => undefined);
                void thread.close().catch(() => undefined);
                sessions.delete(sessionKey);
              } else {
                state = finalizeIfRunning(state);
                await patchSession(sessionKey, { updatedAt: Date.now() });
              }

              await finishCommentRun(state.terminal, state, undefined, evCount, textChars);

              let reply = stripMarkdown(finalMessageText(state)).trim();
              if (state.terminal === 'error' && state.errorMsg) reply = `⚠️ 出错了：${state.errorMsg}`;
              if (!reply) reply = timedOut ? '（处理超时，请重试或把问题问得更具体些）' : '（没有可回复的内容）';
              if (reply.length > REPLY_MAX_CHARS) reply = `${reply.slice(0, REPLY_MAX_CHARS - 1)}…`;

              await postCommentReply(channel, target, evt, reply).catch((err) =>
                log.fail('comment', err, { step: 'postCommentReply' }),
              );
              log.info('comment', 'done', { terminal: state.terminal, timedOut, len: reply.length });
            } catch (err) {
              await finishCommentRun('bridge_error', state, err, evCount, textChars);
              throw err;
            }
          } finally {
            release();
          }
        });
      } catch (err) {
        log.fail('comment', err, { step: 'run' });
      } finally {
        if (reacted && ctx.targetReplyId)
          await removeCommentReaction(channel, target, ctx.targetReplyId).catch(() => undefined);
      }
    }).catch((err) => log.fail('comment', err));
  };

  /**
   * Run `fn` serially per `key`: each call chains after the previous one for the
   * same key (so same-doc comment turns never overlap), while different keys run
   * concurrently. The map entry is dropped once its chain fully drains.
   */
  function withDocLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = docLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of the prior call's outcome
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    docLocks.set(key, tail);
    void tail.then(() => {
      if (docLocks.get(key) === tail) docLocks.delete(key);
    });
    return run;
  }

  /** Reuse the in-memory codex thread for a doc, else resume the persisted one,
   * else start a fresh thread bound to `doc:<fileToken>` (cwd = fallbackCwd —
   * doc replies rarely touch the filesystem, but we keep a sane default). */
  async function resolveDocThread(sessionKey: string, question: string): Promise<AgentThread> {
    const live = sessions.get(sessionKey);
    if (live) return live;
    const rec = await getSession(sessionKey);
    if (rec) {
      try {
        const resumed = await backend.resumeThread({
          cwd: rec.cwd,
          codexThreadId: rec.codexThreadId,
          model: rec.model,
          effort: rec.effort,
          serviceTier: rec.serviceTier,
        });
        sessions.set(sessionKey, resumed);
        return resumed;
      } catch (err) {
        log.fail('agent', err, { phase: 'comment-resume', sessionKey });
      }
    }
    const { model, effort, serviceTier } = pickDefault(await listModels());
    const fresh = await backend.startThread({ cwd: fallbackCwd, model, effort, serviceTier });
    sessions.set(sessionKey, fresh);
    await upsertSession({
      threadId: sessionKey,
      chatId: sessionKey,
      cwd: fallbackCwd,
      codexThreadId: fresh.codexThreadId,
      model,
      effort,
      serviceTier,
      summary: question.slice(0, 80),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return fresh;
  }

  /**
   * `botAdded` event: a human added the bot to a group. If the adder is an admin
   * (binding ties the group to a cwd on the operator's machine — privileged) and
   * the group isn't already bound, DM them a bind card with the project name
   * pre-filled from the group name. Groups the bridge created itself are already
   * registered (or added by the bot, not an admin), so they fall through.
   */
  async function onBotAddedToChat(evt: BotAddedEvent): Promise<void> {
    // The SDK fires botAdded fire-and-forget (no await around the handler), so a
    // rejection here would surface as an unhandled rejection — guard the whole
    // body (getProjectByChatId can throw on a corrupt/locked projects.json).
    await withTrace({ chatId: evt.chatId }, async () => {
      const op = evt.operator?.openId;
      if (await getProjectByChatId(evt.chatId)) {
        log.info('intake', 'bot-added-bound', { chatId: evt.chatId.slice(-6) });
        return;
      }
      if (!op || !isAdmin(cfg, op)) {
        log.info('intake', 'bot-added-nonadmin', { chatId: evt.chatId.slice(-6), op: op?.slice(-6) });
        return;
      }
      // Best-effort group name (needs im:chat:readonly); the bind card's name is
      // editable, so an empty/failed lookup just means the admin types one.
      const info = await channel.getChatInfo(evt.chatId).catch((err) => {
        log.fail('intake', err, { phase: 'bot-added-chatinfo' });
        return undefined;
      });
      const name = (info?.name ?? '').trim();
      await sendManagedCard(
        channel,
        op,
        buildJoinGroupFormCard({ chatId: evt.chatId, name }),
        undefined,
        false,
        'open_id',
      ).catch((err) => log.fail('intake', err, { phase: 'bot-added-bindcard' }));
      log.info('intake', 'bot-added', { chatId: evt.chatId.slice(-6), op: op.slice(-6), named: Boolean(name) });
    }).catch((err) => log.fail('intake', err, { phase: 'bot-added' }));
  }

  /**
   * Bot removed from a group (im.chat.member.bot.deleted_v1, tapped on the raw
   * dispatcher in bridge.ts — the SDK has no named event for it). Auto-unbind the
   * bound project: the bot is already out, so no me_leave. Notify the binder.
   */
  async function onBotRemovedFromChat(chatId: string): Promise<void> {
    const project = await getProjectByChatId(chatId);
    if (!project) return;
    // Remove first, then notify only if THIS call removed it — Feishu delivers
    // events at-least-once and this raw-tap path bypasses the SDK's dedup, so a
    // redelivery would otherwise double-notify the binder. removeProject returns
    // undefined when the entry is already gone.
    const removed = await removeProject(project.name);
    if (!removed) return;
    log.info('intake', 'bot-removed-unbind', { name: removed.name, chatId: chatId.slice(-6) });
    if (removed.addedBy) {
      await channel.rawClient.im.v1.message
        .create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: removed.addedBy,
            msg_type: 'text',
            content: JSON.stringify({ text: `ℹ️ 我已被移出群「${removed.name}」，对应项目已自动解绑。` }),
          },
        })
        .catch(() => undefined);
    }
  }

  async function shutdown(): Promise<void> {
    const activeStates = [...new Set([...active.values(), ...runsByCard.values()])];
    const interruptedRuns = activeStates.map((s) => s.restartNotice).filter((r): r is RestartInterruptedRun => Boolean(r));
    await recordRestartInterruptedRuns(cfg.accounts.app.id, interruptedRuns).catch((err) =>
      log.warn('bridge', 'restart-runs-record-failed', { err: String(err), runs: interruptedRuns.length }),
    );
    for (const st of activeStates) {
      st.interruptReason = 'shutdown';
      st.interrupt?.();
    }

    let drained = launchPromises.size === 0;
    if (!drained) {
      drained = await Promise.race([
        Promise.allSettled([...launchPromises]).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]);
    }

    const activeThreads = activeStates.map((s) => s.thread).filter((t): t is AgentThread => Boolean(t));
    const live = [...new Set([...sessions.values(), ...activeThreads])];
    sessions.clear();
    // close() SIGKILLs each app-server child; settle all so one hang/throw
    // doesn't block reaping the rest.
    await Promise.allSettled(live.map((t) => t.close()));
    log.info('bridge', 'shutdown', { closed: live.length, active: activeStates.length, drained, pendingLaunches: launchPromises.size });
  }

  return { onMessage, onComment, onBotAddedToChat, onBotRemovedFromChat, dispatcher, shutdown };
}

/** Resolve a message's thread_id via raw API (reply response omits it). */
async function getThreadId(channel: LarkChannel, messageId: string): Promise<string | undefined> {
  try {
    const res = await channel.rawClient.im.v1.message.get({ path: { message_id: messageId } });
    const items = (res.data as { items?: { thread_id?: string }[] } | undefined)?.items;
    const tid = items?.[0]?.thread_id;
    if (!tid) log.warn('intake', 'threadid-missing', { messageId });
    return tid;
  } catch (err) {
    log.warn('intake', 'threadid-lookup-failed', { messageId, err: String(err) });
    return undefined;
  }
}

async function findTopicTitleMessageId(channel: LarkChannel, threadId: string): Promise<string | undefined> {
  try {
    const res = await channel.rawClient.im.v1.message.list({
      params: {
        container_id_type: 'thread',
        container_id: threadId,
        sort_type: 'ByCreateTimeAsc',
        page_size: 10,
      },
    });
    const items = (res.data as { items?: FeishuMessageItem[] } | undefined)?.items ?? [];
    const title = items.find((item) => item.msg_type === 'text' && item.sender?.sender_type === 'app');
    return title?.message_id;
  } catch (err) {
    log.warn('intake', 'topic-title-lookup-failed', { threadId, err: String(err) });
    return undefined;
  }
}

interface FeishuMessageItem {
  message_id?: string;
  msg_type?: string;
  sender?: { sender_type?: string };
}
