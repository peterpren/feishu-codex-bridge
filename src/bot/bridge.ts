import { createLarkChannel, Domain, type LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../config/schema';
import { log } from '../core/logger';
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

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await orchestrator.shutdown();
    await channel.disconnect().catch((err) => log.fail('ws', err, { phase: 'disconnect' }));
  };
  return { channel, shutdown };
}
