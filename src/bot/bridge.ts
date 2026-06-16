import { createLarkChannel, Domain, type LarkChannel } from '@larksuiteoapi/node-sdk';
import { resolveOwner, type AppConfig } from '../config/schema';
import { log } from '../core/logger';
import {
  markRestartNoticeSent,
  restartNoticeForApp,
  type RestartInterruptedRun,
  type RestartNotice,
} from '../service/restart-notice';
import { createOrchestrator } from './handle-message';

export interface BridgeOptions {
  cfg: AppConfig;
  appSecret: string;
  /** fallback cwd for groups that aren't registered projects. */
  fallbackCwd: string;
}

export interface BridgeHandle {
  channel: LarkChannel;
  /** Graceful teardown: close every codex session (no orphan app-servers) then
   *  drop the long connection. Idempotent enough for a signal handler. */
  shutdown: () => Promise<void>;
}

/**
 * Bring up the long-connection bot. Wires the `message` handler (group @bot →
 * 会话配置卡 → reply_in_thread topic → codex → streaming card) and the
 * `cardAction` dispatcher (config card model/effort/创建/恢复 buttons), which
 * share run state via the orchestrator. Long-connection is required for
 * `card.action.trigger` (lark-cli doesn't deliver it).
 */
export async function startBridge(opts: BridgeOptions): Promise<BridgeHandle> {
  const app = opts.cfg.accounts.app;
  const channel = createLarkChannel({
    appId: app.id,
    appSecret: opts.appSecret,
    domain: app.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'feishu-codex-bridge',
    // surface raw events so card-action handlers can read form submissions
    // (action.form_value) — used by the new-project form.
    includeRawEvent: true,
    // Deliver ALL group messages (not just @bot) to `onMessage`. The SDK's
    // PolicyGate otherwise drops non-@ group messages with reason 'no_mention'
    // before they reach us, which would make 免@ impossible. We turn the SDK
    // filter off and let our per-project gate (shouldRespondWithoutMention in
    // handle-message) be the single source of truth for 免@. Non-@ delivery
    // still requires the im:message.group_msg scope (Feishu-side push).
    policy: { requireMention: false },
  });

  const orchestrator = createOrchestrator(channel, opts.cfg, opts.fallbackCwd);
  channel.on('message', orchestrator.onMessage);
  channel.on('cardAction', orchestrator.dispatcher.handle);
  // Cloud-doc comments: @bot in a doc comment (drive.notice.comment_add_v1) →
  // reply in the same comment thread.
  channel.on('comment', orchestrator.onComment);
  // A human added the bot to a group → DM the (admin) adder a bind card to
  // register it as a `joined` project.
  channel.on('botAdded', orchestrator.onBotAddedToChat);
  // The SDK exposes no named event for bot-*removed* (im.chat.member.bot.deleted_v1),
  // so tap its private raw EventDispatcher: register() merges by event key, so
  // this adds our handler without clobbering the SDK's built-ins. Guarded +
  // best-effort — if the SDK's internals change on a bump we log and degrade to
  // manual unbind (the console's 删除项目 still works).
  try {
    const tap = (
      channel as unknown as {
        dispatcher?: { register?: (h: Record<string, (raw: unknown) => void>) => unknown };
      }
    ).dispatcher;
    if (tap?.register) {
      tap.register({
        'im.chat.member.bot.deleted_v1': (raw: unknown) => {
          const ev = raw as { chat_id?: string; event?: { chat_id?: string } };
          const chatId = ev?.chat_id ?? ev?.event?.chat_id;
          if (chatId) void orchestrator.onBotRemovedFromChat(chatId);
        },
      });
      log.info('ws', 'bot-removed-tap');
    } else {
      log.info('ws', 'bot-removed-tap-unavailable');
    }
  } catch (err) {
    log.fail('ws', err, { phase: 'bot-removed-tap' });
  }
  channel.on('reject', (evt) => log.info('intake', 'reject', { reason: evt.reason, msgId: evt.messageId }));
  channel.on('error', (err) => log.fail('ws', err));
  channel.on('reconnecting', () => log.info('ws', 'reconnecting'));
  channel.on('reconnected', () => log.info('ws', 'reconnected'));

  await channel.connect();
  log.info('ws', 'connected', { appId: app.id, fallbackCwd: opts.fallbackCwd });
  void notifyRestartComplete(channel, opts.cfg).catch((err) => log.fail('ws', err, { phase: 'restart-notice' }));

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await orchestrator.shutdown();
    await channel.disconnect().catch((err) => log.fail('ws', err, { phase: 'disconnect' }));
  };
  return { channel, shutdown };
}

async function notifyRestartComplete(channel: LarkChannel, cfg: AppConfig): Promise<void> {
  const appId = cfg.accounts.app.id;
  const notice = await restartNoticeForApp(appId);
  if (!notice) return;

  const targets = [...new Set([resolveOwner(cfg), ...(cfg.preferences?.access?.admins ?? [])].filter((x): x is string => Boolean(x)))];
  const runTargets = (notice.runs ?? []).filter((run) => run.appId === appId);
  const sendGenericNotice = shouldSendGenericRestartNotice(notice);
  let sent = 0;
  let runSent = 0;
  for (const run of runTargets) {
    const ok = await sendRestartRunNotice(channel, notice, run);
    if (ok) {
      sent++;
      runSent++;
    }
  }

  if (sendGenericNotice) {
    for (const openId of targets) {
      try {
        await channel.rawClient.im.v1.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: openId,
            msg_type: 'text',
            content: JSON.stringify({ text: restartNoticeText(appId, notice) }),
          },
        });
        sent++;
      } catch (err) {
        log.fail('ws', err, { phase: 'restart-notice-send', appId, openId: openId.slice(-6) });
      }
    }
  }

  if (sent > 0 || (sendGenericNotice && targets.length === 0 && runTargets.length === 0)) {
    await markRestartNoticeSent(appId, notice.id);
    log.info('ws', 'restart-notice-sent', { appId, reason: notice.reason, sent, runSent, generic: sendGenericNotice });
    return;
  }

  if (!sendGenericNotice && runTargets.length === 0) {
    await markRestartNoticeSent(appId, notice.id);
    log.info('ws', 'restart-notice-skipped', { appId, reason: notice.reason });
  }
}

export function shouldSendGenericRestartNotice(notice: Pick<RestartNotice, 'reason'>): boolean {
  return notice.reason === 'version_update';
}

async function sendRestartRunNotice(channel: LarkChannel, notice: RestartNotice, run: RestartInterruptedRun): Promise<boolean> {
  const text = restartRunNoticeText(notice, run);
  const anchor = run.cardMessageId || run.replyToMessageId;
  try {
    await channel.rawClient.im.v1.message.reply({
      path: { message_id: anchor },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
        reply_in_thread: run.replyInThread ?? Boolean(run.feishuThreadId),
      },
    });
    return true;
  } catch (err) {
    log.fail('ws', err, { phase: 'restart-run-notice-reply', appId: run.appId, anchor: anchor.slice(-6) });
  }

  if (!run.requesterOpenId) return false;
  try {
    await channel.rawClient.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: run.requesterOpenId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    return true;
  } catch (err) {
    log.fail('ws', err, { phase: 'restart-run-notice-dm', appId: run.appId, openId: run.requesterOpenId.slice(-6) });
    return false;
  }
}

function restartNoticeText(appId: string, notice: RestartNotice): string {
  const when = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const label = notice.reason === 'version_update' ? '版本更新重启' : '后台重启';
  return [
    `✅ Feishu-Codex Bridge 已恢复运行`,
    ``,
    `机器人：${appId}`,
    `原因：${label}`,
    `时间：${when}（北京时间）`,
    ``,
    `如果重启前有正在执行的任务，那一轮不会自动继续。请回到原话题重新发送指令。`,
  ].join('\n');
}

function restartRunNoticeText(notice: RestartNotice, run: RestartInterruptedRun): string {
  const label = notice.reason === 'version_update' ? '版本更新重启' : '后台重启';
  const who = mentionUser(run.requesterOpenId, run.requesterName);
  const topic = run.topicTitle ? `\n话题：${sanitizeText(run.topicTitle)}` : '';
  return [
    `${who} Bridge 已恢复运行。`,
    ``,
    `刚才这轮任务因${label}中断，无法自动继续。`,
    `请在本话题重新发送指令，我会继续使用这个会话上下文处理。${topic}`,
  ].join('\n');
}

function mentionUser(openId: string | undefined, name: string | undefined): string {
  const safeName = sanitizeText(name || '发起人');
  const id = (openId ?? '').trim();
  if (!/^ou_[a-zA-Z0-9_-]+$/.test(id)) return safeName;
  return `<at user_id="${id}">${safeName}</at>`;
}

function sanitizeText(input: string): string {
  return input.replace(/[<>]/g, (ch) => (ch === '<' ? '＜' : '＞'));
}
