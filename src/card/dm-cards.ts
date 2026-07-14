import {
  getMaxConcurrentRuns,
  getPendingPolicy,
  getShowToolCalls,
  resolveOwner,
  type AppConfig,
} from '../config/schema';
import {
  cloudDocFolderLabel,
  cloudDocFolderPermissionLabel,
  defaultNoMention,
  effectiveGuestMode,
  effectiveMode,
  effectiveNetwork,
  type Project,
} from '../project/registry';
import type { PermissionMode, ReasoningEffort, ServiceTier } from '../agent/types';
import type { SessionRecord } from '../bot/session-store';
import { labelScope } from '../config/scopes';
import { summarizeEventDiagnosis, type EventDiagnosis } from '../utils/event-diagnosis';
import { isIsolatedTopicWorkspace } from '../project/topic-workspace';
import { localWorkspaceRootLabel } from '../project/workspace-root';
import { PRODUCT_NAME, REPOSITORY_URL } from '../core/branding';
import { actions, button, card, form, hr, input, linkButton, md, note, selectMenu, submitButton, type CardElement, type CardObject, type SelectOption } from './cards';
import { relativeTime } from './command-cards';

/** applink to open a Feishu group chat by chat_id (oc_xxx). Feishu has no
 * deep link to a specific thread/topic, so this lands in the group and the
 * user scrolls to the topic themselves. */
function openChatUrl(chatId: string): string {
  return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}

/** Project home (matches package.json homepage/repository). */
const REPO = REPOSITORY_URL;

/** Action ids for the DM (private chat) management console. */
export const DM = {
  menu: 'dm.menu',
  newProject: 'dm.newProject',
  newProjectSubmit: 'dm.newProject.submit',
  joinGroupSubmit: 'dm.joinGroup.submit',
  projects: 'dm.projects',
  projectsPage: 'dm.projects.page',
  settings: 'dm.settings',
  doctor: 'dm.doctor',
  reconnect: 'dm.reconnect',
  update: 'dm.update',
  updateDo: 'dm.update.do',
  // 📊 Codex 用量（限额 + 个人资料统计 + 热力图）；share 打开内容选择卡，
  // shareDo 按所选区块生成可转发的分享卡
  usage: 'dm.usage',
  usageRefresh: 'dm.usage.refresh',
  usageShare: 'dm.usage.share',
  usageShareDo: 'dm.usage.share.do',
  rmConfirm: 'dm.rmConfirm',
  rmDo: 'dm.rmDo',
  rmCancel: 'dm.rmCancel',
  setTools: 'dm.set.tools',
  setWatchdog: 'dm.set.watchdog',
  setPending: 'dm.set.pending',
  setConcurrency: 'dm.set.concurrency',
  workspaceRootForm: 'dm.workspaceRoot.form',
  workspaceRootSubmit: 'dm.workspaceRoot.submit',
  workspaceRootClear: 'dm.workspaceRoot.clear',
  // 权限管理：全局 admins（settings 卡进入）+ 项目响应白名单（项目列表 / 建项目完成卡进入）
  admins: 'dm.admins',
  addAdminForm: 'dm.admin.addForm',
  addAdminSubmit: 'dm.admin.addSubmit',
  rmAdmin: 'dm.admin.rm',
  allowlist: 'dm.allowlist',
  addAllowedForm: 'dm.allow.addForm',
  addAllowedSubmit: 'dm.allow.addSubmit',
  rmAllowed: 'dm.allow.rm',
  // 项目设置容器（项目列表 / 建项目完成卡 进入），以后的项目级设置项往这里加
  projectSettings: 'dm.projectSettings',
  setNoMentionDm: 'dm.proj.noMention',
  setAutoCompactDm: 'dm.proj.autoCompact',
  // 🔐 权限：codex 沙箱档位（管理员档 + 普通用户档）+ 联网，做成下拉表单（选+提交）
  permission: 'dm.proj.perm',
  permissionSubmit: 'dm.proj.perm.submit',
  cloudDocFolderForm: 'dm.proj.cloudDoc.form',
  cloudDocFolderSubmit: 'dm.proj.cloudDoc.submit',
  cloudDocFolderClear: 'dm.proj.cloudDoc.clear',
  foodMcpSet: 'dm.proj.foodMcp',
} as const;

/** Action ids for the in-group settings card (@bot /settings). */
export const GS = {
  setNoMention: 'gs.noMention',
  setAutoCompact: 'gs.autoCompact',
} as const;

/** Human label for a project's session-model kind. */
export function kindLabel(kind?: 'multi' | 'single'): string {
  return kind === 'single' ? '💬 单会话群' : '👥 多话题群';
}

function escapeMd(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}

/** The top-level management menu. */
export function buildDmMenuCard(): CardObject {
  return card(
    [
      md('私聊用于**建项目和管理**；具体任务请到项目群里 @我。'),
      hr(),
      actions([
        button('➕ 新建项目', { a: DM.newProject }, 'primary'),
        button('📁 项目列表', { a: DM.projects }),
        button('⚙️ 设置', { a: DM.settings }),
      ]),
      actions([
        button('📊 用量', { a: DM.usage }),
        button('🩺 诊断', { a: DM.doctor }),
        button('🔄 重连', { a: DM.reconnect }),
        button('⬆️ 版本更新', { a: DM.update }),
      ]),
    ],
    { header: { title: `🤖 ${PRODUCT_NAME} 管理台`, template: 'blue' } },
  );
}

/** State for the version-update card across its phases (check → install → done). */
export interface UpdateCardState {
  phase: 'checking' | 'checked' | 'updating' | 'done' | 'error';
  current?: string;
  latest?: string | null;
  /** checked phase: handler-computed `isNewer(latest, current)` */
  hasUpdate?: boolean;
  /** checked phase: running from a git checkout — steer to git pull, not npm */
  dev?: boolean;
  /** done/updating/error phase: version we updated from */
  from?: string;
  /** done phase: version we updated to */
  to?: string;
  /** done phase: whether the background daemon will be restarted now */
  willRestart?: boolean;
  /** error phase: tail of npm output */
  message?: string;
  /** human-readable update source, e.g. npm peterpren-feishu-codex-bridge */
  source?: string;
  /** manual fallback command shown in cards */
  installCommand?: string;
}

const backToMenu = () => actions([button('⬅️ 菜单', { a: DM.menu })]);
const PROJECT_LIST_PAGE_SIZE = 8;
const DEFAULT_PROJECT_MODEL = 'gpt-5.5';
const DEFAULT_PROJECT_EFFORT: ReasoningEffort = 'medium';
const DEFAULT_PROJECT_SERVICE_TIER: ServiceTier = 'standard';
const FALLBACK_MODEL_OPTIONS: SelectOption[] = [
  { label: 'GPT-5.6-Sol', value: 'gpt-5.6-sol' },
  { label: 'GPT-5.6-Terra', value: 'gpt-5.6-terra' },
  { label: 'GPT-5.6-Luna', value: 'gpt-5.6-luna' },
  { label: 'GPT-5.5', value: DEFAULT_PROJECT_MODEL },
];
const PROJECT_EFFORT_OPTIONS: SelectOption[] = [
  { label: '推理：低', value: 'low' },
  { label: '推理：中', value: 'medium' },
  { label: '推理：高', value: 'high' },
  { label: '推理：超高', value: 'xhigh' },
  { label: '推理：最高', value: 'max' },
  { label: '推理：极高', value: 'ultra' },
];
const PROJECT_SERVICE_TIER_OPTIONS: SelectOption[] = [
  { label: '速度：标准', value: 'standard' },
  { label: '速度：快速', value: 'fast' },
];

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  none: '无',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
  ultra: '极高',
};

function serviceTierLabel(tier: ServiceTier | undefined): string {
  if (tier === 'fast' || tier === 'priority') return '快速';
  return '标准';
}

function modelLabel(model: string | undefined): string {
  return model?.trim() || DEFAULT_PROJECT_MODEL;
}

function effortLabel(effort: ReasoningEffort | undefined): string {
  return EFFORT_LABEL[effort ?? DEFAULT_PROJECT_EFFORT];
}

function modelConfigLabel(project: Pick<Project, 'defaultModel' | 'defaultEffort' | 'defaultServiceTier'>): string {
  return `${modelLabel(project.defaultModel)} / 推理：${effortLabel(project.defaultEffort)} / 速度：${serviceTierLabel(project.defaultServiceTier)}`;
}

function initialProjectModel(options: SelectOption[], selected: string | undefined): string | undefined {
  if (selected && options.some((o) => o.value === selected)) return selected;
  return options.find((o) => o.value === DEFAULT_PROJECT_MODEL)?.value ?? options[0]?.value;
}

function initialProjectEffort(selected: ReasoningEffort | string | undefined): ReasoningEffort {
  return PROJECT_EFFORT_OPTIONS.some((o) => o.value === selected) ? (selected as ReasoningEffort) : DEFAULT_PROJECT_EFFORT;
}

function initialProjectServiceTier(selected: ServiceTier | undefined): ServiceTier {
  // The project form intentionally keeps one human-facing “快速” option; the
  // backend maps old `fast` projects to a model's `priority` service tier.
  return selected === 'fast' || selected === 'priority' ? 'fast' : DEFAULT_PROJECT_SERVICE_TIER;
}

function withFallbackModelOptions(options: SelectOption[] | undefined): SelectOption[] {
  const merged = new Map<string, SelectOption>();
  for (const option of [...(options ?? []), ...FALLBACK_MODEL_OPTIONS]) {
    if (!merged.has(option.value)) merged.set(option.value, option);
  }
  return [...merged.values()];
}

/**
 * Version-update console card. A single builder renders every phase so the same
 * card updates in place: 查询中 → 查询结果(有/无更新/源码态) → 更新中 → 完成/失败.
 * The 「立即更新」button (checked + hasUpdate) carries DM.updateDo.
 */
export function buildUpdateCard(state: UpdateCardState): CardObject {
  switch (state.phase) {
    case 'checking':
      return card([md('⏳ 正在查询最新版本…'), note(`从 ${state.source ?? 'npm'} 拉取版本信息，请稍候。`)], {
        header: { title: '⬆️ 版本更新', template: 'turquoise' },
      });

    case 'checked': {
      const cur = state.current ?? '?';
      if (!state.latest) {
        return card(
          [
            md(`当前版本：**v${cur}**`),
            md(`⚠️ 查不到最新版本（网络或 ${state.source ?? 'npm'} 访问问题）。`),
            actions([button('🔄 重试', { a: DM.update }), button('⬅️ 菜单', { a: DM.menu })]),
          ],
          { header: { title: '⬆️ 版本更新', template: 'red' } },
        );
      }
      const head = [
        state.hasUpdate ? md(`发现新版本 🎉`) : md(`✅ 当前 package 版本已是最新：**v${cur}**`),
        note(`更新源：${state.source ?? 'npm'}`),
        note(`当前 v${cur}  →  最新 v${state.latest}`),
      ];
      if (state.dev) {
        return card(
          [
            ...head,
            md('检测到**源码开发模式**（仓库内有 .git）。请在终端用 `git pull --ff-only && npm i && npm run build && feishu-codex-bridge restart` 更新，避免覆盖本地未提交代码。'),
            backToMenu(),
          ],
          { header: { title: '⬆️ 版本更新', template: 'orange' } },
        );
      }
      if (!state.hasUpdate) {
        return card(
          [
            ...head,
            note('如果刚发布了新包但本地缓存还没刷新，也可以重新安装 npm 最新包。'),
            note(`将执行：${state.installCommand ?? 'npm i -g peterpren-feishu-codex-bridge'}`),
            actions([
              button('⬆️ 重新安装最新代码', { a: DM.updateDo }, 'primary'),
              button('⬅️ 菜单', { a: DM.menu }),
            ]),
          ],
          { header: { title: '⬆️ 版本更新', template: 'green' } },
        );
      }
      return card(
        [
          ...head,
          note(`点「立即更新」会执行 \`${state.installCommand ?? 'npm i -g peterpren-feishu-codex-bridge'}\` 并自动重启后台服务（约数十秒）。`),
          actions([
            button('⬆️ 立即更新', { a: DM.updateDo }, 'primary'),
            button('⬅️ 菜单', { a: DM.menu }),
          ]),
        ],
        { header: { title: '⬆️ 版本更新', template: 'blue' } },
      );
    }

    case 'updating':
      return card(
        [
          md(`⏳ 正在更新到最新版…`),
          note(`从 v${state.from ?? '?'} 升级中，下载安装约数十秒，请勿重复点击。`),
        ],
        { header: { title: '⬆️ 版本更新', template: 'turquoise' } },
      );

    case 'done': {
      const tail = state.willRestart
        ? note('正在重启后台服务以生效 —— 重启期间本卡片停止更新；恢复后会私聊管理员通知。')
        : note('前台模式：请在终端手动重启 `run` 进程使新版本生效。');
      return card(
        [md(`✅ 已更新 **v${state.from ?? '?'} → v${state.to ?? '?'}**`), tail],
        { header: { title: '⬆️ 版本更新', template: 'green' } },
      );
    }

    case 'error':
      return card(
        [
          md('❌ **更新失败**'),
          state.message ? note(state.message) : note('npm 安装未成功。'),
          md(`可在终端手动执行：\`${state.installCommand ?? 'npm i -g peterpren-feishu-codex-bridge'}\`（必要时加 sudo）。`),
          actions([button('🔄 重试', { a: DM.update }), button('⬅️ 菜单', { a: DM.menu })]),
        ],
        { header: { title: '⬆️ 版本更新', template: 'red' } },
      );
  }
}

/** Snapshot the doctor card renders + folds into a copy-paste prompt for codex.
 * Gathered by the handler (file checks, versions, live connection state) so the
 * builder stays pure and testable. */
export interface DoctorInfo {
  /** codex CLI resolvable and runnable (backend.isAvailable) */
  codexOk: boolean;
  /** codex --version string, or null if unresolved */
  codexVer: string | null;
  /** Feishu long-connection state (channel.getConnectionStatus().state) */
  conn: string;
  /** the bridge's own version */
  bridgeVer: string;
  /** process.version */
  node: string;
  /** `${platform}-${arch}` */
  platform: string;
  /** background daemon stdout log path (launchd) */
  logStdout: string;
  /** background daemon stderr log path (launchd) */
  logStderr: string;
  /** current bot's config.json path */
  configFile: string;
  /**
   * 飞书权限自检：尚未开通的必需 scope（来自 application/v6/scopes 的 grant_status，
   * 含 im:message.group_msg 等事件订阅类）。`undefined` = 没查成（凭证失效 / 网络
   * 不通 / 接口不可用），与 `[]`（全部已开通）严格区分，卡片据此分三态渲染——
   * 绝不把"查不到"误报成"缺失"。
   */
  missingScopes?: string[];
  /**
   * 开放平台「权限管理」一键开通页：缺失时预选缺失项、否则预选全部必需 scope。
   * 用户点开即已勾好待申请权限，保存即生效（自建应用无需审核）。
   */
  scopeGrantUrl: string;
  /**
   * 「加入存量群」可选 scope（{@link JOIN_GROUP_SCOPES}）尚未开通的项，三态同
   * {@link missingScopes}（undefined = 查不到）。不属必需，仅在诊断卡里提示，
   * 让存量用户能发现并开通。
   */
  missingJoinScopes?: string[];
  /** 一键开通页，预选「加入存量群」那两项 scope。 */
  joinScopeGrantUrl: string;
  /**
   * 「飞书云文档目录隔离」可选 scope 尚未开通的项，三态同 missingScopes。
   */
  missingCloudDocFolderScopes?: string[];
  /** 一键开通页，预选云文档目录隔离需要的 scope。 */
  cloudDocFolderScopeGrantUrl: string;
  /** 事件订阅自动诊断结果；undefined = 本次未检查成。 */
  eventDiagnosis?: EventDiagnosis;
  /** 开放平台「事件与回调」配置页。 */
  eventConfigUrl?: string;
}

/** Friendly label for a long-connection state; unknown states show raw. */
function connLabel(state: string): string {
  switch (state) {
    case 'connected':
      return '✅ 已连接';
    case 'connecting':
      return '⏳ 连接中';
    case 'reconnecting':
      return '↻ 重连中';
    case 'disconnected':
      return '❌ 已断开';
    default:
      return state;
  }
}

/** One-line 飞书权限 status for the copy-paste codex prompt (plain text). */
function scopeStatusText(i: DoctorInfo): string {
  if (i.missingScopes === undefined) return '未能自动检查（凭证失效或网络问题）';
  if (i.missingScopes.length === 0) return '必需权限齐全';
  return `缺失 ${i.missingScopes.length} 项：${i.missingScopes.join(' ')}`;
}

/**
 * 「飞书权限」诊断块：把 {@link DoctorInfo.missingScopes} 的三态渲染成一行状态，
 * 缺失或查不到时再附一个直达开放平台、已预选待开通 scope 的「去开通」按钮——
 * 用户点开即勾好、保存即生效，无需自己对照清单。
 */
function scopeDiagnosis(i: DoctorInfo): CardElement[] {
  if (i.missingScopes === undefined) {
    return [
      md('- 飞书权限：⚠️ 无法自动检查（凭证失效或网络不通）'),
      actions([linkButton('🔑 去权限页核对', i.scopeGrantUrl)]),
    ];
  }
  if (i.missingScopes.length === 0) {
    return [md('- 飞书权限：✅ 必需权限已全部开通')];
  }
  return [
    md(`- 飞书权限：❌ 缺 ${i.missingScopes.length} 项 —— 开通前相关功能（收发消息 / 卡片 / 图片 / 建群等）不可用`),
    note(`待开通：\n${i.missingScopes.map((s) => `· ${labelScope(s)}`).join('\n')}`),
    actions([linkButton('🔑 一键去开通这些权限', i.scopeGrantUrl)]),
  ];
}

function eventSubscriptionDiagnosis(i: DoctorInfo): CardElement[] {
  const out: CardElement[] = [md('**事件订阅**')];
  if (!i.eventDiagnosis) {
    out.push(
      md('- 状态：⚠️ 未检查'),
      note('需要在开放平台「事件配置」订阅 `im.message.receive_v1` 并发布版本；卡片回传仍需在「回调配置」勾选 `card.action.trigger`。'),
    );
    if (i.eventConfigUrl) out.push(actions([linkButton('⚙️ 去事件与回调', i.eventConfigUrl)]));
    return out;
  }

  out.push(md(`- 状态：${summarizeEventDiagnosis(i.eventDiagnosis)}`));
  if (i.eventDiagnosis.missingOptional?.length) {
    out.push(note(`可选事件未订阅：\n${i.eventDiagnosis.missingOptional.map((e) => `· ${e}`).join('\n')}`));
  }
  out.push(note('卡片按钮回传 `card.action.trigger` 属于「回调配置」，不在版本 API 的 events 列表里，仍需人工核对。'));
  if (i.eventDiagnosis.state !== 'ok' && i.eventConfigUrl) out.push(actions([linkButton('⚙️ 去事件与回调', i.eventConfigUrl)]));
  return out;
}

/**
 * 「加入存量群」诊断块：这俩 scope 是 opt-in（不在 REQUIRED_SCOPES 里，所以
 * 启动/凭据校验都不会提示）。这里把 scope 状态显式渲染出来、缺失时给「去开通」
 * 按钮；事件订阅状态则复用版本 API 的诊断结果。
 */
function joinFeatureDiagnosis(i: DoctorInfo): CardElement[] {
  const out: CardElement[] = [md('**加入存量群（可选）**')];
  if (i.missingJoinScopes === undefined) {
    out.push(md('- 权限：⚠️ 未能自动检查（凭据失效或网络不通）'), actions([linkButton('🔑 去开通', i.joinScopeGrantUrl)]));
  } else if (i.missingJoinScopes.length === 0) {
    out.push(md('- 权限：✅ 已开通（`im:chat:readonly` / `im:chat.members:write_only`）'));
  } else {
    out.push(
      md(`- 权限：❌ 缺 ${i.missingJoinScopes.length} 项 —— 开通后才能把我加进已有群（绑定 / 退群）`),
      note(`待开通：\n${i.missingJoinScopes.map((s) => `· ${labelScope(s)}`).join('\n')}`),
      actions([linkButton('🔑 一键开通这两项权限', i.joinScopeGrantUrl)]),
    );
  }
  const events = new Set(i.eventDiagnosis?.events ?? []);
  if (i.eventDiagnosis?.events) {
    const added = events.has('im.chat.member.bot.added_v1');
    const deleted = events.has('im.chat.member.bot.deleted_v1');
    out.push(md(`- 事件：${added && deleted ? '✅ 已订阅' : '⚠️ 未完整订阅'}（added: ${added ? '已订阅' : '缺失'} / deleted: ${deleted ? '已订阅' : '缺失'}）`));
  } else {
    out.push(note('⚠️ 还需在后台「事件与回调」订阅 `im.chat.member.bot.added_v1` 和 `im.chat.member.bot.deleted_v1`。'));
  }
  return out;
}

function cloudDocFolderDiagnosis(i: DoctorInfo): CardElement[] {
  const out: CardElement[] = [md('**飞书云文档目录（可选）**')];
  if (i.missingCloudDocFolderScopes === undefined) {
    out.push(md('- 权限：⚠️ 未能自动检查（凭据失效或网络不通）'), actions([linkButton('🔑 去开通', i.cloudDocFolderScopeGrantUrl)]));
  } else if (i.missingCloudDocFolderScopes.length === 0) {
    out.push(md('- 权限：✅ 已开通（可创建话题子文件夹并管理协作者）'));
  } else {
    out.push(
      md(`- 权限：❌ 缺 ${i.missingCloudDocFolderScopes.length} 项 —— 开通后才能自动创建话题云文档子文件夹并做权限隔离`),
      note(`待开通：\n${i.missingCloudDocFolderScopes.map((s) => `· ${labelScope(s)}`).join('\n')}`),
      actions([linkButton('🔑 一键开通这些权限', i.cloudDocFolderScopeGrantUrl)]),
    );
  }
  out.push(note('父文件夹只配置管理员/机器人权限；多话题群会为每个话题创建子文件夹，只授权话题发起人和管理员。'));
  return out;
}

/**
 * The self-contained prompt the user copies into a project group and @s the bot
 * with. Since codex runs locally on the same machine, handing it the absolute
 * log paths lets it actually read the logs and diagnose. Keep this plain text
 * (no markdown / backticks) — it's pasted verbatim as a chat message.
 */
function codexDiagnosePrompt(i: DoctorInfo): string {
  return [
    `我在用 ${PRODUCT_NAME}（飞书 ↔ 本地 Codex 桥接）遇到问题，请帮我定位原因并给出修复步骤。`,
    '',
    '【环境】',
    `- ${PRODUCT_NAME} 版本：v${i.bridgeVer}`,
    `- codex 版本：${i.codexVer ?? '未找到（PATH / CODEX_BIN 里都没有 codex）'}`,
    `- Node：${i.node}`,
    `- 平台：${i.platform}`,
    `- 项目仓库：${REPO}`,
    '',
    '【运行快照】',
    `- codex 可用：${i.codexOk ? '是' : '否'}`,
    `- 飞书长连接：${i.conn}`,
    `- 飞书权限：${scopeStatusText(i)}`,
    `- 事件订阅：${i.eventDiagnosis ? summarizeEventDiagnosis(i.eventDiagnosis) : '未检查'}`,
    '',
    '【请你做的事】',
    '1. 读取并分析日志，找出最近的报错或异常堆栈：',
    `   - 后台守护输出日志：${i.logStdout}`,
    `   - 后台守护错误日志：${i.logStderr}`,
    '   （若是前台 feishu-codex-bridge run 模式，日志在启动它的终端窗口，请把终端里的报错一起发我）',
    `2. 判断问题属于哪类：codex 启动 / 登录、飞书鉴权或权限不足、长连接断开、还是配置缺失（配置文件：${i.configFile}）。`,
    `3. 必要时对照仓库 README 与 issues 给方案：${REPO}/issues`,
    '4. 给出可直接执行的修复步骤。',
    '',
    '【我遇到的现象】',
    '（在这里补充：比如 @机器人不回复 / 卡片按钮点了没反应 / 启动就报错……）',
  ].join('\n');
}

/**
 * Diagnostics card for the DM console (🩺 诊断). Top half is a quick local
 * self-check (codex + long connection + version/platform); bottom half is a
 * copy-paste code block the user hands to codex for a deep, log-backed
 * diagnosis, plus repo / issue links. Sent as a reply (terminal card) — re-open
 * the console by messaging the bot.
 */
export function buildDoctorCard(i: DoctorInfo): CardObject {
  const prompt = codexDiagnosePrompt(i);
  // codex 不可用、或明确查到缺权限 → 橙色警示；"没查成"(undefined) 不算硬故障，保持蓝。
  const hasProblem = !i.codexOk || (i.missingScopes !== undefined && i.missingScopes.length > 0);
  return card(
    [
      md('**初步诊断**'),
      md(
        `- Codex：${i.codexOk ? `✅ 可用${i.codexVer ? `（${i.codexVer}）` : ''}` : '❌ 不可用（检查 CODEX_BIN / PATH）'}`,
      ),
      md(`- 飞书长连接：${connLabel(i.conn)}`),
      ...scopeDiagnosis(i),
      note(`${PRODUCT_NAME} v${i.bridgeVer}　·　Node ${i.node}　·　${i.platform}`),
      hr(),
      ...eventSubscriptionDiagnosis(i),
      hr(),
      ...joinFeatureDiagnosis(i),
      hr(),
      ...cloudDocFolderDiagnosis(i),
      hr(),
      md('**日志路径**'),
      note(`后台守护输出：\`${i.logStdout}\``),
      note(`后台守护错误：\`${i.logStderr}\``),
      note('前台 `run` 模式：日志在启动它的终端窗口里'),
      hr(),
      md('**让 Codex 帮你深度诊断** — 复制下面整段，到任意项目群里 **@我** 粘贴发送：'),
      md('```\n' + prompt + '\n```'),
      actions([
        linkButton('📦 项目仓库', REPO),
        linkButton('🐞 提 Issue', `${REPO}/issues`),
      ]),
    ],
    { header: { title: '🩺 诊断', template: hasProblem ? 'orange' : 'blue' } },
  );
}

/** Interactive new-project form: project name + optional CWD/cloud-doc folder, submit/cancel. */
export function buildNewProjectFormCard(
  opts: {
    name?: string;
    cwd?: string;
    cloudDocFolder?: string;
    defaultModel?: string;
    defaultEffort?: ReasoningEffort | string;
    defaultServiceTier?: ServiceTier;
    modelOptions?: SelectOption[];
    error?: string;
  } = {},
): CardObject {
  const elements = [];
  const modelOptions = withFallbackModelOptions(opts.modelOptions);
  const defaultModel = initialProjectModel(modelOptions, opts.defaultModel);
  const defaultEffort = initialProjectEffort(opts.defaultEffort);
  const defaultServiceTier = initialProjectServiceTier(opts.defaultServiceTier);
  if (opts.error) elements.push(md(`❌ **创建失败**：${opts.error}`));
  elements.push(
    md('填项目名（必填）。**本地文件夹路径留空** = 在本 Bot 的工作根目录下自动新建空白项目；**填绝对路径** = 绑定根目录内已有文件夹。'),
    form('new_project', [
      input({ name: 'name', label: '项目名', placeholder: 'my-app', value: opts.name, required: true }),
      input({ name: 'cwd', label: '本地文件夹路径（选填，必须在 Bot 工作根目录内）', placeholder: '/Users/you/code/my-app', value: opts.cwd }),
      input({
        name: 'cloud_doc_folder',
        label: '飞书云文档保存文件夹（选填）',
        placeholder: 'https://xxx.feishu.cn/drive/folder/fldcnxxxx 或 fldcnxxxx',
        value: opts.cloudDocFolder,
      }),
      note('该父文件夹只会配置管理员/机器人权限；多话题群会为每个话题自动创建子文件夹，并只授权话题发起人和管理员。'),
      md('**默认模型选择**'),
      selectMenu({
        name: 'default_model',
        placeholder: '默认模型',
        options: modelOptions,
        initial: defaultModel,
      }),
      selectMenu({
        name: 'default_effort',
        placeholder: '默认推理',
        options: PROJECT_EFFORT_OPTIONS,
        initial: defaultEffort,
      }),
      selectMenu({
        name: 'default_service_tier',
        placeholder: '默认速度',
        options: PROJECT_SERVICE_TIER_OPTIONS,
        initial: defaultServiceTier,
      }),
      note('选群类型(直接点对应按钮创建)：👥 多话题群 = @我开话题、每话题独立会话和工作区（发起人/管理员可驱动）；💬 单会话群 = 整群一个会话、连续上下文。'),
      actions([
        submitButton('👥 创建·多话题群', { a: DM.newProjectSubmit, kind: 'multi' }, 'primary', 'submit_multi'),
        submitButton('💬 创建·单会话群', { a: DM.newProjectSubmit, kind: 'single' }, 'primary', 'submit_single'),
      ]),
      actions([button('⬅️ 菜单', { a: DM.menu })]),
    ]),
  );
  return card(elements, { header: { title: '➕ 新建项目', template: 'turquoise' } });
}

/**
 * Bind-an-existing-group form. Reached when a human adds the bot to a group and
 * the bot DMs the adder. Mirrors {@link buildNewProjectFormCard} but the name
 * input is pre-filled with the group's name (still editable — lets the user
 * dodge a name clash), and the submit buttons carry the group's `chatId` so the
 * handler binds *this* group instead of creating a new one.
 */
export function buildJoinGroupFormCard(
  opts: {
    chatId: string;
    name?: string;
    cwd?: string;
    cloudDocFolder?: string;
    defaultModel?: string;
    defaultEffort?: ReasoningEffort | string;
    defaultServiceTier?: ServiceTier;
    modelOptions?: SelectOption[];
    error?: string;
  },
): CardObject {
  const elements: CardElement[] = [];
  const modelOptions = withFallbackModelOptions(opts.modelOptions);
  const defaultModel = initialProjectModel(modelOptions, opts.defaultModel);
  const defaultEffort = initialProjectEffort(opts.defaultEffort);
  const defaultServiceTier = initialProjectServiceTier(opts.defaultServiceTier);
  if (opts.error) elements.push(md(`❌ **绑定失败**：${opts.error}`));
  elements.push(
    md('我已被加入这个群。填一下要绑定的项目信息即可开始用。'),
    md('项目名默认用群名，可改。**本地文件夹路径留空** = 在本 Bot 的工作根目录下自动新建空白项目；**填绝对路径** = 绑定根目录内已有文件夹。'),
    form('join_group', [
      input({ name: 'name', label: '项目名', placeholder: 'my-app', value: opts.name, required: true }),
      input({ name: 'cwd', label: '本地文件夹路径（选填，必须在 Bot 工作根目录内）', placeholder: '/Users/you/code/my-app', value: opts.cwd }),
      input({
        name: 'cloud_doc_folder',
        label: '飞书云文档保存文件夹（选填）',
        placeholder: 'https://xxx.feishu.cn/drive/folder/fldcnxxxx 或 fldcnxxxx',
        value: opts.cloudDocFolder,
      }),
      note('该父文件夹只会配置管理员/机器人权限；多话题群会为每个话题自动创建子文件夹，并只授权话题发起人和管理员。'),
      md('**默认模型选择**'),
      selectMenu({
        name: 'default_model',
        placeholder: '默认模型',
        options: modelOptions,
        initial: defaultModel,
      }),
      selectMenu({
        name: 'default_effort',
        placeholder: '默认推理',
        options: PROJECT_EFFORT_OPTIONS,
        initial: defaultEffort,
      }),
      selectMenu({
        name: 'default_service_tier',
        placeholder: '默认速度',
        options: PROJECT_SERVICE_TIER_OPTIONS,
        initial: defaultServiceTier,
      }),
      note('选群类型(直接点对应按钮创建)：👥 多话题群 = @我开话题、每话题独立会话和工作区（发起人/管理员可驱动）；💬 单会话群 = 整群一个会话、连续上下文（默认不免@）。'),
      actions([
        submitButton('👥 绑定·多话题群', { a: DM.joinGroupSubmit, kind: 'multi', chatId: opts.chatId }, 'primary', 'submit_multi'),
        submitButton('💬 绑定·单会话群', { a: DM.joinGroupSubmit, kind: 'single', chatId: opts.chatId }, 'primary', 'submit_single'),
      ]),
    ]),
  );
  return card(elements, { header: { title: '🔗 绑定已有群', template: 'turquoise' } });
}

/** Shown after a project is created/bound — a terminal "留痕" record with a
 * jump-to-group button so the admin can hop straight into the group and start
 * working. (Re-open the console any time by messaging the bot.) */
export function buildNewProjectDoneCard(p: Project): CardObject {
  const joined = (p.origin ?? 'created') === 'joined';
  const verb = joined ? '已绑定群' : '已创建项目';
  const title = joined ? '🔗 绑定已有群' : '➕ 新建项目';
  const elements: CardElement[] = [
    md(`✅ ${verb} **${p.name}**${p.blank ? ' _(空白项目)_' : ''}`),
    note(`📂 \`${p.cwd}\`   ·   ${kindLabel(p.kind)}`),
    note(`🧠 默认配置：${modelConfigLabel(p)}`),
    ...(isIsolatedTopicWorkspace(p) ? [note('🧵 多话题：每个话题有独立本地工作区，只有发起人/管理员可驱动')] : []),
    note(`☁️ 云文档目录：${cloudDocFolderLabel(p.cloudDocFolder)}`),
    ...(p.cloudDocFolder?.token ? [note(`🔐 权限隔离：${cloudDocFolderPermissionLabel(p.cloudDocFolder)}`)] : []),
    md(p.chatId ? '👉 去群里 **@我** 干活。' : '发我任意消息可再次打开管理台。'),
  ];
  if (p.chatId)
    elements.push(
      actions([
        linkButton('💬 打开群聊', openChatUrl(p.chatId), 'primary'),
        button('⚙️ 项目设置', { a: DM.projectSettings, n: p.name }),
      ]),
    );
  return card(elements, { header: { title, template: 'green' } });
}

/** Project list: each project shows its bound group + a jump-to-group link,
 * and lists that group's topics (sessions, most-recent first). Feishu applink
 * can only target the group, not a thread — so the link lands in the group. */
export function buildProjectListCard(
  projects: Project[],
  sessionsByChat: Map<string, SessionRecord[]> = new Map(),
  page = 0,
): CardObject {
  if (projects.length === 0) {
    return card(
      [md('还没有项目。点 **➕ 新建项目** 或直接发我一个项目名。'), actions([button('⬅️ 菜单', { a: DM.menu })])],
      { header: { title: '📁 项目列表', template: 'wathet' } },
    );
  }
  const elements: CardObject[] = [];
  const pageCount = Math.max(1, Math.ceil(projects.length / PROJECT_LIST_PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const visibleProjects = projects.slice(currentPage * PROJECT_LIST_PAGE_SIZE, (currentPage + 1) * PROJECT_LIST_PAGE_SIZE);
  for (const p of visibleProjects) {
    const sessions = (p.chatId ? sessionsByChat.get(p.chatId) : undefined) ?? [];
    const latest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const meta = [
      p.chatId ? kindLabel(p.kind) : '⚠️ 未绑定群',
      (p.origin ?? 'created') === 'joined' ? '已加入' : undefined,
      `默认配置：${modelConfigLabel(p)}`,
      `免@：${(p.noMention ?? defaultNoMention(p)) ? '开' : '关'}`,
      isIsolatedTopicWorkspace(p) ? '话题工作区：独立' : undefined,
      sessions.length ? `话题 ${sessions.length}` : '暂无话题',
    ].filter(Boolean);
    elements.push(
      md(
        [
          `**${p.name}**${p.blank ? ' _(空白)_' : ''}`,
          `📂 \`${p.cwd}\`${p.branch && p.branch !== '—' ? `   🌿 ${p.branch}` : ''}`,
          `💬 ${meta.join(' · ')}`,
          latest ? `最近：${escapeMd((latest.summary || '(空)').replace(/\s+/g, ' ').slice(0, 40))} · ${relativeTime(latest.updatedAt)}` : undefined,
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    );
    const row: CardObject[] = [];
    if (p.chatId) row.push(linkButton('💬 打开群聊', openChatUrl(p.chatId)));
    row.push(button('⚙️ 设置', { a: DM.projectSettings, n: p.name }));
    row.push(button('🗑 删除', { a: DM.rmConfirm, n: p.name }, 'danger'));
    elements.push(actions(row));
  }
  elements.push(hr());
  elements.push(note(`共 ${projects.length} 个项目 · 第 ${currentPage + 1}/${pageCount} 页`));
  if (pageCount > 1) {
    const pager: CardObject[] = [];
    if (currentPage > 0) pager.push(button('⬅️ 上一页', { a: DM.projectsPage, p: currentPage - 1 }));
    if (currentPage < pageCount - 1) pager.push(button('下一页 ➡️', { a: DM.projectsPage, p: currentPage + 1 }));
    elements.push(actions(pager));
  }
  elements.push(actions([button('⬅️ 菜单', { a: DM.menu })]));
  return card(elements, { header: { title: '📁 项目列表', template: 'wathet' } });
}

export function buildRmConfirmCard(name: string, origin?: 'created' | 'joined'): CardObject {
  const note_ =
    (origin ?? 'created') === 'joined'
      ? '仅解绑（移除注册），**不删代码目录**。确认后**我会退出该群**（群是你们的，不会解散）。'
      : '仅解绑（移除注册 + 撤销置顶横幅），**不删代码目录**。群主会转给你，再由你自行在飞书解散群。';
  return card(
    [
      md(`确定删除项目 **${name}**？`),
      note(note_),
      actions([
        button('✅ 确认删除', { a: DM.rmDo, n: name }, 'danger'),
        button('取消', { a: DM.rmCancel }),
      ]),
    ],
    { header: { title: '🗑 删除项目', template: 'red' } },
  );
}

/** A label line + a row of option buttons; the currently-selected option is
 * highlighted (primary). Each button carries `{ a: actionId, v: <value> }`, so
 * tapping any option sets that value directly (no cycling). Distinct values keep
 * each option's callback unique; managed.ts's per-render token lets a value you
 * already picked once be picked again. */
function optionRow(
  label: string,
  actionId: string,
  current: string,
  opts: { label: string; value: string }[],
): CardElement[] {
  return [
    md(label),
    actions(opts.map((o) => button(o.label, { a: actionId, v: o.value }, o.value === current ? 'primary' : 'default'))),
  ];
}

/**
 * Global preferences card. Each setting is a row of option buttons — tap the
 * value you want (current one is highlighted). We use buttons, not select_static,
 * on purpose: Feishu locks a card_id once a select has been interacted with,
 * after which *every* button on it (including ⬅️ 菜单) stops firing. Buttons
 * never lock, so this card stays fully interactive and updates in place.
 */
export function buildSettingsCard(cfg: AppConfig): CardObject {
  const watchdogSec = cfg.preferences?.runIdleTimeoutSeconds ?? 120;
  const localRoot = cfg.preferences?.localWorkspaceRoot;
  return card(
    [
      md('**全局设置**（管理员）'),
      md('**本地工作根目录**'),
      note(`当前：${localWorkspaceRootLabel(localRoot)}`),
      note('新建/绑定项目时，本地目录必须在这个根目录内；留空创建项目也会自动落在这里。'),
      actions([
        button(localRoot ? '修改根目录' : '设置根目录', { a: DM.workspaceRootForm }, 'primary'),
        ...(localRoot ? [button('清空', { a: DM.workspaceRootClear }, 'danger')] : []),
      ]),
      hr(),
      ...optionRow('🔧 工具调用', DM.setTools, getShowToolCalls(cfg) ? 'on' : 'off', [
        { label: '显示', value: 'on' },
        { label: '隐藏', value: 'off' },
      ]),
      ...optionRow('⏱ 假死超时', DM.setWatchdog, String(watchdogSec), [
        { label: '关闭', value: '0' },
        { label: '60秒', value: '60' },
        { label: '120秒', value: '120' },
        { label: '300秒', value: '300' },
      ]),
      ...optionRow('📥 运行中新消息', DM.setPending, getPendingPolicy(cfg), [
        { label: '引导', value: 'steer' },
        { label: '排队', value: 'queue' },
      ]),
      ...optionRow('⚡ 并发上限', DM.setConcurrency, String(getMaxConcurrentRuns(cfg)), [
        { label: '1', value: '1' },
        { label: '5', value: '5' },
        { label: '10', value: '10' },
        { label: '20', value: '20' },
      ]),
      note('⚠️ 假死超时 / 并发上限 改后需**重启**生效；工具显示 / 运行中新消息 即时生效。'),
      hr(),
      actions([button('👮 管理员', { a: DM.admins }), button('⬅️ 菜单', { a: DM.menu })]),
    ],
    { header: { title: '⚙️ 设置', template: 'blue' } },
  );
}

export function buildWorkspaceRootFormCard(opts: { current?: string; error?: string } = {}): CardObject {
  const elements: CardElement[] = [];
  if (opts.error) elements.push(md(`❌ **保存失败**：${opts.error}`));
  elements.push(
    md('设置这个 Bot 可以使用的本地工作根目录。保存后，新建/绑定项目只能落在这个目录里面。'),
    form('workspace_root', [
      input({
        name: 'local_workspace_root',
        label: '本地工作根目录',
        placeholder: '/Users/you/Documents/Codex/财务团队',
        value: opts.current,
        required: true,
      }),
      note('如果目录不存在，保存时会自动创建；最终保存为真实路径，用来拦截软链接跳出目录。'),
      actions([submitButton('✅ 保存', { a: DM.workspaceRootSubmit }, 'primary', 'submit_workspace_root')]),
      actions([button('⬅️ 设置', { a: DM.settings })]),
    ]),
  );
  return card(elements, { header: { title: '📂 本地工作根目录', template: 'turquoise' } });
}

/**
 * In-group settings card (@bot /settings). The group type is fixed at creation
 * (read-only label); 免@ is a live toggle. Uses option buttons (never lock) like
 * {@link buildSettingsCard}. Admin-gated by the handler.
 */
export function buildGroupSettingsCard(project: Pick<Project, 'name' | 'kind' | 'noMention' | 'origin' | 'autoCompact'>): CardObject {
  const kind = project.kind ?? 'multi';
  const noMention = project.noMention ?? defaultNoMention(project);
  const autoCompact = project.autoCompact !== false;
  const scopeNote =
    kind === 'single'
      ? '开启后：本群所有消息(不用 @)都交给我处理。'
      : '开启后：话题内的消息(不用 @)都交给我处理；**开新话题仍需 @我**。';
  return card(
    [
      md(`**群设置** · ${project.name}`),
      note(`群类型(建群时定，不可改)：${kindLabel(kind)}`),
      ...optionRow('✋ 免@（不用 @ 也回复）', GS.setNoMention, noMention ? 'on' : 'off', [
        { label: '开', value: 'on' },
        { label: '关', value: 'off' },
      ]),
      note(scopeNote),
      note('⚠️ 免@ 需应用已开通「接收群内所有消息」(im:message.group_msg)权限，否则收不到非 @ 消息。'),
      hr(),
      ...optionRow('🗜️ 自动压缩上下文', GS.setAutoCompact, autoCompact ? 'on' : 'off', [
        { label: '开', value: 'on' },
        { label: '关', value: 'off' },
      ]),
      note('开启后：上下文接近上限时 Codex 自动总结早前对话、释放空间（默认开）。改动下一轮生效。'),
    ],
    { header: { title: '⚙️ 群设置', template: 'blue' } },
  );
}

// ── 权限管理卡（admins / 项目响应白名单）──────────────────────────────────────

/** 行内显示一个成员：姓名优先，拿不到名（无 contact scope / 查询失败）则显示 open_id 尾段。 */
function memberName(names: Map<string, string>, id: string): string {
  return names.get(id) ?? `…${id.slice(-6)}`;
}

/**
 * 全局管理员名单卡（DM「⚙️ 设置 → 👮 管理员」）。**纯按钮卡**——绝不放 select：select
 * 一旦交互会锁 card_id（见 {@link buildSettingsCard} 注释）。加人走独立的表单卡
 * {@link buildAddAdminCard}。owner 行无移除按钮（owner 恒为 admin、不可删）。
 * `names` 由调用方用 contact.batch 预解析 open_id→姓名。
 */
export function buildAdminsCard(cfg: AppConfig, names: Map<string, string>): CardObject {
  const owner = resolveOwner(cfg);
  const admins = cfg.preferences?.access?.admins ?? [];
  const elements: CardElement[] = [md('**管理员名单** · 本 bot 全局（可私聊管理 / 建项目 / 销毁操作）'), hr()];
  const seen = new Set<string>();
  if (owner) {
    seen.add(owner);
    elements.push(actions([md(`👑 **${memberName(names, owner)}** · Bot 拥有者（注册者）`)]));
  }
  let extra = 0;
  for (const id of admins) {
    if (seen.has(id)) continue;
    seen.add(id);
    extra++;
    elements.push(actions([md(memberName(names, id)), button('🗑 移除', { a: DM.rmAdmin, u: id }, 'danger')]));
  }
  if (extra === 0) elements.push(note('暂无额外管理员。'));
  elements.push(
    hr(),
    actions([button('➕ 添加管理员', { a: DM.addAdminForm }, 'primary'), button('⬅️ 设置', { a: DM.settings })]),
    note('👑 Bot 拥有者（注册此 bot 的人）恒为管理员，不可移除；名单为空时仅拥有者可管理。'),
  );
  return card(elements, { header: { title: '👮 管理员', template: 'blue' } });
}

/** 添加管理员的表单卡：select_person 选人 + 提交。提交后旧卡留痕、结果发新名单卡
 * （form+submit 模式规避 select 锁卡，仿 {@link buildNewProjectFormCard}）。 */
/**
 * 添加管理员的表单卡。候选 = **所有项目群成员的并集**（真人，去重、不含 bot/应用，
 * 调用方已排除现有 admin）；大群/多群只列前 N，其余走 open_id 手填兜底。 */
export function buildAddAdminCard(members: { openId: string; name: string }[]): CardObject {
  const MAX = 50;
  const shown = members.slice(0, MAX);
  const formEls: CardElement[] = [];
  if (shown.length > 0) {
    formEls.push(
      selectMenu({
        name: 'pick',
        placeholder: '从项目群成员选择',
        options: shown.map((m) => ({ label: m.name, value: m.openId })),
      }),
    );
  }
  formEls.push(
    input({
      name: 'open_id',
      label: shown.length ? '或直接输入 open_id' : '输入 open_id（未读取到项目群成员）',
      placeholder: 'ou_xxx',
    }),
    actions([submitButton('✅ 确认添加', { a: DM.addAdminSubmit }, 'primary', 'submit_admin')]),
  );
  const tail: CardElement[] = [];
  if (members.length > MAX) tail.push(note(`候选较多，仅列前 ${MAX} 个；其余请直接输入 open_id。`));
  return card(
    [
      md('**添加管理员** · 从项目群成员选，或输入 open_id'),
      form('add_admin', formEls),
      ...tail,
      actions([button('⬅️ 取消', { a: DM.admins })]),
    ],
    { header: { title: '➕ 添加管理员', template: 'blue' } },
  );
}

/** Permission tiers, escalating, each with a one-line plain-language description
 * (no "cwd" jargon — "项目文件夹"). */
const MODE_OPTS: { value: PermissionMode; label: string; desc: string }[] = [
  { value: 'qa', label: '🔒 项目内只读', desc: '只能查看项目文件夹里的内容，不会改任何文件' },
  { value: 'write', label: '✏️ 项目内读写', desc: '能查看并修改项目文件夹里的文件，但碰不到文件夹外' },
  { value: 'full', label: '⚠️ 完全访问', desc: '能读写整台电脑上的任何文件' },
];

/** Short label for a tier (falls back to the raw value). */
function tierLabel(m: PermissionMode): string {
  return MODE_OPTS.find((o) => o.value === m)?.label ?? m;
}

/** Tier dropdown options: "label — desc" so the meaning shows in the menu. */
const TIER_SELECT_OPTS: SelectOption[] = MODE_OPTS.map((o) => ({ label: `${o.label} — ${o.desc}`, value: o.value }));

/** One-line summary of a project's tiers, for the 项目设置 card. */
export function permissionSummary(p: Pick<Project, 'mode' | 'guestMode'>): string {
  const admin = effectiveMode(p);
  const guest = effectiveGuestMode(p);
  return admin === guest
    ? `所有人：${tierLabel(admin)}`
    : `管理员：${tierLabel(admin)}　·　其他人：${tierLabel(guest)}`;
}

/**
 * 🔐 权限表单卡（DM「项目设置 → 🔐 权限」）。两个下拉:「管理员档」给 owner/管理员、
 * 「普通用户档」给群里其他人——两档**不同**即按档位拆线程(各自独立沙箱+对话历史)、**相同**
 * 则所有人一致。外加联网开关。用 selectMenu(表单收值、提交时才读、不锁卡)而非即时按钮——
 * 选完点提交；提交 handler 落盘 + 驱逐活跃会话让新档立刻生效。
 */
export function buildPermissionCard(p: Pick<Project, 'name' | 'mode' | 'guestMode' | 'network'>): CardObject {
  const network = effectiveNetwork(p);
  return card(
    [
      md(`**🔐 权限** · ${p.name}`),
      note(
        'codex 沙箱的访问范围。「管理员档」给 owner / 管理员，「普通用户档」给群里其他人。' +
          '两档**不同**时，两类人各用独立线程（互不串沙箱与对话历史）；**相同**则所有人一致。',
      ),
      form('perm', [
        md('👑 **管理员档**'),
        selectMenu({ name: 'mode', placeholder: '选择管理员权限档', options: TIER_SELECT_OPTS, initial: effectiveMode(p) }),
        md('👥 **普通用户档**'),
        selectMenu({
          name: 'guestMode',
          placeholder: '选择普通用户权限档',
          options: TIER_SELECT_OPTS,
          initial: effectiveGuestMode(p),
        }),
        md('🌐 **联网**（只对只读 / 读写档有意义；完全访问恒联网）'),
        selectMenu({
          name: 'network',
          placeholder: '联网开关',
          options: [
            { label: '开（默认）', value: 'on' },
            { label: '关', value: 'off' },
          ],
          initial: network ? 'on' : 'off',
        }),
        actions([submitButton('✅ 保存权限', { a: DM.permissionSubmit, n: p.name }, 'primary', 'submit_perm')]),
      ]),
      note('保存会断开本项目正在进行的会话，让新档位立即生效。'),
      actions([button('⬅️ 返回设置', { a: DM.projectSettings, n: p.name })]),
    ],
    { header: { title: '🔐 权限', template: 'blue' } },
  );
}

/**
 * 项目设置卡（DM「📁 项目列表 / 建项目完成卡 → ⚙️ 设置」）。可扩展容器：当前放
 * 🔐 权限 + 免@ 开关 + 响应白名单入口，以后的项目级设置项往这里加。纯按钮（不锁卡）。
 * 各按钮携带项目名 n（DM 里点，不能靠 evt.chatId 取项目）。
 */
export function buildProjectSettingsCard(
  project: Pick<
    Project,
    | 'name'
    | 'kind'
    | 'noMention'
    | 'origin'
    | 'cwd'
    | 'mode'
    | 'guestMode'
    | 'network'
    | 'autoCompact'
    | 'defaultModel'
    | 'defaultEffort'
    | 'defaultServiceTier'
    | 'cloudDocFolder'
    | 'topicWorkspace'
  >,
): CardObject {
  const kind = project.kind ?? 'multi';
  const noMention = project.noMention ?? defaultNoMention(project);
  const autoCompact = project.autoCompact !== false;
  const hasCloudDocFolder = Boolean(project.cloudDocFolder?.token);
  return card(
    [
      md(`**项目设置** · ${project.name}`),
      note(`${kindLabel(kind)}${project.cwd ? `   ·   📂 \`${project.cwd}\`` : ''}`),
      note(`🧠 默认配置：${modelConfigLabel(project)}`),
      ...(isIsolatedTopicWorkspace(project) ? [note('🧵 多话题工作区：独立（发起人/管理员可驱动）')] : []),
      note(`☁️ 云文档目录：${cloudDocFolderLabel(project.cloudDocFolder)}`),
      ...(hasCloudDocFolder ? [note(`🔐 权限隔离：${cloudDocFolderPermissionLabel(project.cloudDocFolder)}`)] : []),
      hr(),
      md('☁️ 飞书云文档保存目录'),
      actions([
        button(hasCloudDocFolder ? '修改目录' : '设置目录', { a: DM.cloudDocFolderForm, n: project.name }, 'primary'),
        ...(hasCloudDocFolder ? [button('清空目录', { a: DM.cloudDocFolderClear, n: project.name }, 'danger')] : []),
      ]),
      note('多话题群会在该父文件夹下为每个话题创建子文件夹；父文件夹不再授予整个群编辑权限。'),
      hr(),
      actions([button('🔐 权限', { a: DM.permission, n: project.name }, 'primary')]),
      note(`当前 ${permissionSummary(project)}　·　codex 沙箱可访问的范围（管理员 / 普通用户可分设）。`),
      hr(),
      md('✋ 免@（不用 @ 也回复）'),
      actions([
        button('开', { a: DM.setNoMentionDm, v: 'on', n: project.name }, noMention ? 'primary' : 'default'),
        button('关', { a: DM.setNoMentionDm, v: 'off', n: project.name }, noMention ? 'default' : 'primary'),
      ]),
      note(
        kind === 'single'
          ? '开启后：本群所有消息(不用 @)都交给我处理。'
          : '开启后：话题内消息(不用 @)都处理；**开新话题仍需 @我**。',
      ),
      hr(),
      md('🗜️ 自动压缩上下文'),
      actions([
        button('开', { a: DM.setAutoCompactDm, v: 'on', n: project.name }, autoCompact ? 'primary' : 'default'),
        button('关', { a: DM.setAutoCompactDm, v: 'off', n: project.name }, autoCompact ? 'default' : 'primary'),
      ]),
      note('开启后：上下文接近上限时 Codex 自动总结早前对话、释放空间（默认开）。保存后下一轮生效。'),
      hr(),
      actions([button('🛡 响应白名单', { a: DM.allowlist, n: project.name }, 'primary')]),
      note('设置谁能让我在本群响应 / 跑 codex（空 = 所有人）。'),
      hr(),
      actions([button('⬅️ 项目列表', { a: DM.projects })]),
    ],
    { header: { title: '⚙️ 项目设置', template: 'blue' } },
  );
}

export function buildCloudDocFolderFormCard(
  project: Pick<Project, 'name' | 'cloudDocFolder'>,
  opts: { value?: string; error?: string } = {},
): CardObject {
  const current = opts.value ?? project.cloudDocFolder?.url ?? project.cloudDocFolder?.token ?? '';
  const elements: CardElement[] = [];
  if (opts.error) elements.push(md(`❌ **保存失败**：${opts.error}`));
  elements.push(
    md(`**飞书云文档保存目录** · ${project.name}`),
    note('填飞书云空间父文件夹 URL 或 fld... token。留空提交 = 清空项目默认目录。父文件夹只配管理员/机器人权限，多话题按话题创建子文件夹。'),
    form('cloud_doc_folder', [
      input({
        name: 'cloud_doc_folder',
        label: '文件夹 URL / Token',
        placeholder: 'https://xxx.feishu.cn/drive/folder/fldcnxxxx 或 fldcnxxxx',
        value: current,
      }),
      actions([
        submitButton('✅ 保存', { a: DM.cloudDocFolderSubmit, n: project.name }, 'primary', 'submit_cloud_doc_folder'),
        button('⬅️ 项目设置', { a: DM.projectSettings, n: project.name }),
      ]),
    ]),
  );
  return card(elements, { header: { title: '☁️ 云文档目录', template: 'blue' } });
}

/**
 * 项目响应白名单卡（DM「⚙️ 项目设置 → 🛡 响应白名单」）。结构同 {@link buildAdminsCard}：
 * 纯按钮 + 加人走表单卡 {@link buildAddAllowedCard}。空名单 = 所有人可用；admin/owner
 * 恒豁免，不受此名单限制。
 */
export function buildAllowlistCard(
  project: Pick<Project, 'name' | 'allowedUsers'>,
  names: Map<string, string>,
): CardObject {
  const list = project.allowedUsers ?? [];
  const elements: CardElement[] = [md(`**响应白名单** · ${project.name}`), note('谁能让我在本群响应 / 跑 codex'), hr()];
  if (list.length === 0) {
    elements.push(note('当前**所有人**可用（管理员始终可用）。'));
  } else {
    for (const id of list) {
      elements.push(
        actions([md(memberName(names, id)), button('🗑 移除', { a: DM.rmAllowed, u: id, n: project.name }, 'danger')]),
      );
    }
  }
  elements.push(
    hr(),
    actions([
      button('➕ 添加', { a: DM.addAllowedForm, n: project.name }, 'primary'),
      button('⬅️ 设置', { a: DM.projectSettings, n: project.name }),
    ]),
    note('管理员始终可用，不受此名单限制；名单为空 = 所有人可用。'),
  );
  return card(elements, { header: { title: '🛡 响应白名单', template: 'blue' } });
}

/**
 * 添加白名单成员的表单卡。候选来自**群成员接口**（含外部租户成员，且 API 本身不返回
 * 机器人）；大群只列前 N，其余走 open_id 手动输入兜底。提交按钮携带项目名（n）。
 */
export function buildAddAllowedCard(
  projectName: string,
  members: { openId: string; name: string }[],
): CardObject {
  const MAX = 50;
  const shown = members.slice(0, MAX);
  const formEls: CardElement[] = [];
  if (shown.length > 0) {
    formEls.push(
      selectMenu({
        name: 'pick',
        placeholder: '从群成员选择',
        options: shown.map((m) => ({ label: m.name, value: m.openId })),
      }),
    );
  }
  formEls.push(
    input({
      name: 'open_id',
      label: shown.length ? '或直接输入 open_id' : '输入 open_id（未读取到群成员）',
      placeholder: 'ou_xxx',
    }),
    actions([submitButton('✅ 确认添加', { a: DM.addAllowedSubmit, n: projectName }, 'primary', 'submit_allowed')]),
  );
  const tail: CardElement[] = [];
  if (members.length > MAX) tail.push(note(`群成员较多，仅列前 ${MAX} 个；其余请直接输入 open_id。`));
  return card(
    [
      md(`**添加可使用「${projectName}」的人**`),
      form('add_allowed', formEls),
      ...tail,
      actions([button('⬅️ 取消', { a: DM.allowlist, n: projectName })]),
    ],
    { header: { title: '➕ 添加白名单成员', template: 'blue' } },
  );
}
