import {
  getMaxConcurrentRuns,
  getPendingPolicy,
  getShowToolCalls,
  type AppConfig,
} from '../config/schema';
import type { Project } from '../project/registry';
import type { SessionRecord } from '../bot/session-store';
import { actions, button, card, form, hr, input, linkButton, md, note, submitButton, type CardElement, type CardObject } from './cards';
import { relativeTime } from './command-cards';

/** applink to open a Feishu group chat by chat_id (oc_xxx). Feishu has no
 * deep link to a specific thread/topic, so this lands in the group and the
 * user scrolls to the topic themselves. */
function openChatUrl(chatId: string): string {
  return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}

/** Action ids for the DM (private chat) management console. */
export const DM = {
  menu: 'dm.menu',
  newProject: 'dm.newProject',
  newProjectSubmit: 'dm.newProject.submit',
  projects: 'dm.projects',
  settings: 'dm.settings',
  doctor: 'dm.doctor',
  reconnect: 'dm.reconnect',
  update: 'dm.update',
  updateDo: 'dm.update.do',
  rmConfirm: 'dm.rmConfirm',
  rmDo: 'dm.rmDo',
  rmCancel: 'dm.rmCancel',
  setTools: 'dm.set.tools',
  setWatchdog: 'dm.set.watchdog',
  setPending: 'dm.set.pending',
  setConcurrency: 'dm.set.concurrency',
} as const;

/** Action ids for the in-group settings card (@bot /settings). */
export const GS = {
  setNoMention: 'gs.noMention',
} as const;

/** Human label for a project's session-model kind. */
export function kindLabel(kind?: 'multi' | 'single'): string {
  return kind === 'single' ? '💬 单会话群' : '👥 多话题群';
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
        button('🩺 诊断', { a: DM.doctor }),
        button('🔄 重连', { a: DM.reconnect }),
        button('⬆️ 版本更新', { a: DM.update }),
      ]),
    ],
    { header: { title: '🤖 Codex Bridge 管理台', template: 'blue' } },
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
}

const backToMenu = () => actions([button('⬅️ 菜单', { a: DM.menu })]);

/**
 * Version-update console card. A single builder renders every phase so the same
 * card updates in place: 查询中 → 查询结果(有/无更新/源码态) → 更新中 → 完成/失败.
 * The 「立即更新」button (checked + hasUpdate) carries DM.updateDo.
 */
export function buildUpdateCard(state: UpdateCardState): CardObject {
  switch (state.phase) {
    case 'checking':
      return card([md('⏳ 正在查询最新版本…'), note('从 npm registry 拉取版本信息，请稍候。')], {
        header: { title: '⬆️ 版本更新', template: 'turquoise' },
      });

    case 'checked': {
      const cur = state.current ?? '?';
      if (!state.latest) {
        return card(
          [
            md(`当前版本：**v${cur}**`),
            md('⚠️ 查不到最新版本（网络或 npm registry 问题）。'),
            actions([button('🔄 重试', { a: DM.update }), button('⬅️ 菜单', { a: DM.menu })]),
          ],
          { header: { title: '⬆️ 版本更新', template: 'red' } },
        );
      }
      if (!state.hasUpdate) {
        return card(
          [md(`✅ 已是最新版本：**v${cur}**`), backToMenu()],
          { header: { title: '⬆️ 版本更新', template: 'green' } },
        );
      }
      const head = [
        md(`发现新版本 🎉`),
        note(`当前 v${cur}  →  最新 v${state.latest}`),
      ];
      if (state.dev) {
        return card(
          [
            ...head,
            md('检测到**源码开发模式**（仓库内有 .git）。请在终端用 `git pull && npm i` 更新，而不是全局安装。'),
            backToMenu(),
          ],
          { header: { title: '⬆️ 版本更新', template: 'orange' } },
        );
      }
      return card(
        [
          ...head,
          note('点「立即更新」会执行 `npm i -g` 并自动重启后台服务（约数十秒）。'),
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
        ? note('正在重启后台服务以生效 —— 重启期间本卡片停止更新；稍后发我任意消息可重开管理台。')
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
          md('可在终端手动执行：`npm i -g ' + '@modelzen/feishu-codex-bridge@latest`（必要时加 sudo）。'),
          actions([button('🔄 重试', { a: DM.update }), button('⬅️ 菜单', { a: DM.menu })]),
        ],
        { header: { title: '⬆️ 版本更新', template: 'red' } },
      );
  }
}

/** Interactive new-project form: project name + optional CWD, submit/cancel. */
export function buildNewProjectFormCard(opts: { name?: string; cwd?: string; error?: string } = {}): CardObject {
  const elements = [];
  if (opts.error) elements.push(md(`❌ **创建失败**：${opts.error}`));
  elements.push(
    md('填项目名（必填）。**文件夹路径留空** = 自动在默认位置新建一个空白项目；**填绝对路径** = 用电脑上已有的文件夹。'),
    form('new_project', [
      input({ name: 'name', label: '项目名', placeholder: 'my-app', value: opts.name, required: true }),
      input({ name: 'cwd', label: '文件夹路径（选填，留空自动新建）', placeholder: '/Users/you/code/my-app', value: opts.cwd }),
      note('选群类型(直接点对应按钮创建)：👥 多话题群 = @我开话题、每话题独立会话；💬 单会话群 = 整群一个会话、连续上下文。'),
      actions([
        submitButton('👥 创建·多话题群', { a: DM.newProjectSubmit, kind: 'multi' }, 'primary', 'submit_multi'),
        submitButton('💬 创建·单会话群', { a: DM.newProjectSubmit, kind: 'single' }, 'primary', 'submit_single'),
      ]),
      actions([button('⬅️ 菜单', { a: DM.menu })]),
    ]),
  );
  return card(elements, { header: { title: '➕ 新建项目', template: 'turquoise' } });
}

/** Shown after a project is created — a terminal "留痕" record with a
 * jump-to-group button so the admin can hop straight into the new group and
 * start working. (Re-open the console any time by messaging the bot.) */
export function buildNewProjectDoneCard(p: Project): CardObject {
  const elements: CardElement[] = [
    md(`✅ 已创建项目 **${p.name}**${p.blank ? ' _(空白项目)_' : ''}`),
    note(`📂 \`${p.cwd}\`   ·   ${kindLabel(p.kind)}`),
    md(p.chatId ? '群已建好 👉 去项目群里 **@我** 干活。' : '发我任意消息可再次打开管理台。'),
  ];
  if (p.chatId) elements.push(actions([linkButton('💬 打开群聊', openChatUrl(p.chatId), 'primary')]));
  return card(elements, { header: { title: '➕ 新建项目', template: 'green' } });
}

/** Project list: each project shows its bound group + a jump-to-group link,
 * and lists that group's topics (sessions, most-recent first). Feishu applink
 * can only target the group, not a thread — so the link lands in the group. */
export function buildProjectListCard(
  projects: Project[],
  sessionsByChat: Map<string, SessionRecord[]> = new Map(),
): CardObject {
  if (projects.length === 0) {
    return card(
      [md('还没有项目。点 **➕ 新建项目** 或直接发我一个项目名。'), actions([button('⬅️ 菜单', { a: DM.menu })])],
      { header: { title: '📁 项目列表', template: 'wathet' } },
    );
  }
  const elements: CardObject[] = [];
  for (const p of projects) {
    elements.push(md(`**${p.name}**${p.blank ? ' _(空白)_' : ''}`));
    elements.push(note(`📂 \`${p.cwd}\`${p.branch && p.branch !== '—' ? `   🌿 ${p.branch}` : ''}`));
    elements.push(
      note(
        p.chatId
          ? `💬 群：**${p.name}**   ·   ${kindLabel(p.kind)}   ·   免@：${(p.noMention ?? true) ? '开' : '关'}`
          : '⚠️ 未绑定群',
      ),
    );
    const sessions = (p.chatId ? sessionsByChat.get(p.chatId) : undefined) ?? [];
    if (sessions.length === 0) {
      elements.push(note('（暂无话题）'));
    } else {
      const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
      for (const s of sorted) {
        const title = (s.summary || '(空)').replace(/\s+/g, ' ').slice(0, 40);
        elements.push(note(`· ${title} · ${relativeTime(s.updatedAt)}`));
      }
    }
    const row: CardObject[] = [];
    if (p.chatId) row.push(linkButton('💬 打开群聊', openChatUrl(p.chatId)));
    row.push(button('🗑 删除', { a: DM.rmConfirm, n: p.name }, 'danger'));
    elements.push(actions(row));
    elements.push(hr());
  }
  elements.push(note(`共 ${projects.length} 个项目`));
  elements.push(actions([button('⬅️ 菜单', { a: DM.menu })]));
  return card(elements, { header: { title: '📁 项目列表', template: 'wathet' } });
}

export function buildRmConfirmCard(name: string): CardObject {
  return card(
    [
      md(`确定删除项目 **${name}**？`),
      note('仅解绑（移除注册 + 撤销置顶横幅），**不删代码目录**。群主会转给你，再由你自行在飞书解散群。'),
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
  return card(
    [
      md('**全局设置**（管理员）'),
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
      actions([button('⬅️ 菜单', { a: DM.menu })]),
    ],
    { header: { title: '⚙️ 设置', template: 'blue' } },
  );
}

/**
 * In-group settings card (@bot /settings). The group type is fixed at creation
 * (read-only label); 免@ is a live toggle. Uses option buttons (never lock) like
 * {@link buildSettingsCard}. Admin-gated by the handler.
 */
export function buildGroupSettingsCard(project: Pick<Project, 'name' | 'kind' | 'noMention'>): CardObject {
  const kind = project.kind ?? 'multi';
  const noMention = project.noMention ?? true;
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
    ],
    { header: { title: '⚙️ 群设置', template: 'blue' } },
  );
}
