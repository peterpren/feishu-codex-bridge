import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';
import type { CardObject } from './cards';
import { isCardIdNotReady } from './managed';

/**
 * Min gap between throttled whole-card stream updates. Finer = smoother chunked
 * growth (each push shows the full text so far). Feishu caps a single card at
 * ~10 ops/sec; 150ms ≈ 6.6/sec keeps headroom (streaming_mode's QPS exemption no
 * longer applies now that it's off — see {@link ../card/cards}).
 */
const STREAM_THROTTLE_MS = 150;

const CHAT_MIN_GAP_MS = 250;
const RATE_LIMIT_PENALTY_MS = 1_000;
const TERMINAL_RL_RETRIES = 3;
const RL_BACKOFF_BASE_MS = 1_000;

class ChatPacer {
  private nextAt = 0;

  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + CHAT_MIN_GAP_MS;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }

  penalize(): void {
    this.nextAt = Math.max(this.nextAt, Date.now() + RATE_LIMIT_PENALTY_MS);
  }

  idle(now: number): boolean {
    return this.nextAt < now - 60_000;
  }
}

const chatPacers = new Map<string, ChatPacer>();
function pacerFor(chatId: string): ChatPacer {
  let p = chatPacers.get(chatId);
  if (!p) {
    if (chatPacers.size >= 512) {
      const now = Date.now();
      for (const [k, v] of chatPacers) if (v.idle(now)) chatPacers.delete(k);
    }
    p = new ChatPacer();
    chatPacers.set(chatId, p);
  }
  return p;
}

function isRateLimited(err: unknown): boolean {
  const e = err as { code?: number; response?: { status?: number; data?: { code?: number } } };
  return e?.response?.status === 429 || e?.response?.data?.code === 99991400 || e?.code === 99991400;
}

/**
 * A run card backed by a single CardKit 2.0 entity. The whole card is
 * re-rendered from {@link RunState} each tick and pushed via
 * cardkit.v1.card.update; each push instantly renders the current full text
 * (streaming_mode is off — its client typewriter only applies to the
 * element-level content API, not whole-card updates, and ran far behind token
 * arrival). Throttled to STREAM_THROTTLE_MS so growth tracks the model in
 * chunks with zero trailing, and collapsible panels (reasoning / tools)
 * re-render cleanly. All updates share one strictly-increasing `seq` — Feishu
 * rejects out-of-order updates.
 *
 * Unlike im.v1.message.patch (unconditional, reverts a card touched during a
 * click's callback window), this is the correct surface for a card that both
 * streams and carries clickable controls (⏹).
 */
export class RunCardStream {
  private cardId = '';
  private _messageId = '';
  private seq = 0;
  private lastPush = 0;
  private lastContent = '';
  // Per-turn push counters — surfaced via stats() for the stream.timing log.
  private pushCount = 0;
  private cardPushes = 0; // whole-card card.update (structure)
  private elPushes = 0; // element cardElement.content (answer typewriter)
  private totalRttMs = 0;
  private maxRttMs = 0;
  // Coalesced streaming. The consume loop records the latest {card, answerEid} in
  // `pending`; a single pump() drains it — NON-BLOCKING, so consuming codex events
  // never stalls on a round-trip (awaiting each push serially drained the backlog
  // at one event per ~RTT → "已回完、飞书还在慢慢打字"). The pump pushes only the most
  // recent snapshot per round-trip: when only the answer text grew it streams that
  // via cardElement.content (typewriter), otherwise it whole-card updates.
  private pending: { card: CardObject; answerEid: string | null } | null = null;
  private pumpChannel: LarkChannel | null = null;
  private pumpPromise: Promise<void> | null = null;
  // Baselines for the pump's route decision (structure unchanged + answer grew?).
  private lastStructureSig = '';
  private lastAnswerText = '';
  private pacer: ChatPacer | null = null;

  get messageId(): string {
    return this._messageId;
  }

  /** Push counts (whole-card vs element) + round-trip stats for this card. */
  stats(): { pushCount: number; cardPushes: number; elPushes: number; totalRttMs: number; maxRttMs: number } {
    return {
      pushCount: this.pushCount,
      cardPushes: this.cardPushes,
      elPushes: this.elPushes,
      totalRttMs: this.totalRttMs,
      maxRttMs: this.maxRttMs,
    };
  }

  /**
   * Record the latest card and ensure the pump is running. Returns immediately;
   * calls that arrive while a push is in flight collapse into a single push of
   * the most recent card once that round-trip completes. Use this from the
   * event-consume loop instead of awaiting {@link streamCard} per event.
   */
  streamCoalesced(channel: LarkChannel, fullCard: CardObject, answerEid: string | null): void {
    this.pending = { card: fullCard, answerEid };
    this.pumpChannel = channel;
    if (!this.pumpPromise) this.pumpPromise = this.pump();
  }

  /** Await any in-flight coalesced push so the final streaming frame lands (and
   * `seq` stays ordered) before the terminal update. Call after the loop ends. */
  async drain(): Promise<void> {
    if (this.pumpPromise) await this.pumpPromise;
  }

  private async pump(): Promise<void> {
    try {
      while (this.pending && this.pumpChannel) {
        const { card, answerEid } = this.pending;
        this.pending = null;
        const t0 = Date.now();
        const answer = answerEid ? answerContent(card, answerEid) : null;
        const sig = structureSig(card, answerEid);
        if (
          answerEid &&
          answer !== null &&
          sig === this.lastStructureSig &&
          answer !== this.lastAnswerText &&
          answer.startsWith(this.lastAnswerText)
        ) {
          // Structure unchanged, answer grew by append → native typewriter.
          if (await this.streamElement(this.pumpChannel, answerEid, answer)) {
            this.lastAnswerText = answer;
          }
        } else {
          // First frame or structure changed → whole-card update re-establishes the
          // (answer-blanked) baseline; the answer element streams via
          // cardElement.content from here, carrying current text so nothing is lost.
          if (await this.streamCard(this.pumpChannel, card, true)) {
            this.lastStructureSig = sig;
            this.lastAnswerText = answer ?? '';
          }
        }
        // RTT (~hundreds of ms) usually spaces pushes on its own; this floor only
        // bites if a round-trip is unusually fast, keeping us under Feishu's
        // single-card ~10 ops/sec cap.
        const gap = STREAM_THROTTLE_MS - (Date.now() - t0);
        if (this.pending && gap > 0) await new Promise((r) => setTimeout(r, gap));
      }
    } finally {
      this.pumpPromise = null;
    }
  }

  /** Element-level streaming push (cardkit.v1.cardElement.content): the answer
   * element's accumulated full text. Feishu diffs the prefix and types the delta
   * per the card's streaming_config. Needs streaming_mode on the card. */
  private async streamElement(channel: LarkChannel, elementId: string, content: string): Promise<boolean> {
    if (!this.cardId) return false;
    await this.pacer?.wait();
    const t0 = Date.now();
    try {
      await channel.rawClient.cardkit.v1.cardElement.content({
        path: { card_id: this.cardId, element_id: elementId },
        data: { content, sequence: ++this.seq, uuid: `e_${this.cardId}_${this.seq}` },
      });
      const rtt = Date.now() - t0;
      this.pushCount++;
      this.elPushes++;
      this.totalRttMs += rtt;
      if (rtt > this.maxRttMs) this.maxRttMs = rtt;
      return true;
    } catch (err) {
      const rl = isRateLimited(err);
      if (rl) this.pacer?.penalize();
      log.fail('card', err, { phase: 'run-stream-el', cardId: this.cardId, seq: this.seq, rateLimited: rl });
      return false;
    }
  }

  /** Create the entity from the initial (running) card and send a message
   * referencing it by card_id. Returns the carrier message id. */
  async create(
    channel: LarkChannel,
    chatId: string,
    initialCard: CardObject,
    opts: { replyTo?: string; replyInThread?: boolean },
  ): Promise<string> {
    this.pacer = pacerFor(chatId);
    const data = JSON.stringify(initialCard);
    const attempt = async (): Promise<{ cardId: string; messageId: string }> => {
      const created = await channel.rawClient.cardkit.v1.card.create({
        data: { type: 'card_json', data },
      });
      const cardId = (created as { data?: { card_id?: string } }).data?.card_id;
      if (!cardId) {
        throw new Error(`cardkit.card.create returned no card_id: ${JSON.stringify(created).slice(0, 200)}`);
      }

      const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
      let messageId: string | undefined;
      if (opts.replyTo) {
        const r = await channel.rawClient.im.v1.message.reply({
          path: { message_id: opts.replyTo },
          data: { msg_type: 'interactive', content, reply_in_thread: opts.replyInThread ?? false },
        });
        messageId = (r as { data?: { message_id?: string } }).data?.message_id;
      } else {
        const r = await channel.rawClient.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content },
        });
        messageId = (r as { data?: { message_id?: string } }).data?.message_id;
      }
      if (!messageId) throw new Error('run card send returned no message_id');
      return { cardId, messageId };
    };

    for (let i = 0; ; i++) {
      try {
        const { cardId, messageId } = await attempt();
        this.cardId = cardId;
        this.lastContent = data;
        this._messageId = messageId;
        return messageId;
      } catch (err) {
        if (i >= 2 || !isCardIdNotReady(err)) throw err;
        log.fail('card', err, { phase: 'run-create', attempt: i, retry: true });
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
  }

  /** Throttled whole-card stream update. Skips identical/too-soon pushes;
   * `force` flushes regardless (still de-duped on content). Returns true when
   * the frame is already current or was delivered. */
  async streamCard(channel: LarkChannel, fullCard: CardObject, force = false): Promise<boolean> {
    if (!this.cardId) return false;
    const data = JSON.stringify(fullCard);
    if (data === this.lastContent) return true;
    const now = Date.now();
    if (!force && now - this.lastPush < STREAM_THROTTLE_MS) return false;
    this.lastPush = now;
    await this.pacer?.wait();
    const t0 = Date.now();
    try {
      await channel.rawClient.cardkit.v1.card.update({
        path: { card_id: this.cardId },
        data: { card: { type: 'card_json', data }, sequence: ++this.seq, uuid: `s_${this.cardId}_${this.seq}` },
      });
      this.lastContent = data;
      const rtt = Date.now() - t0;
      this.pushCount++;
      this.cardPushes++;
      this.totalRttMs += rtt;
      if (rtt > this.maxRttMs) this.maxRttMs = rtt;
      return true;
    } catch (err) {
      const rl = isRateLimited(err);
      if (rl) this.pacer?.penalize();
      log.fail('card', err, { phase: 'run-stream', cardId: this.cardId, seq: this.seq, rateLimited: rl });
      return false;
    }
  }

  /** Forced whole-card replace for structural/terminal updates. A terminal
   * card built with streaming off clears the typewriter cursor. */
  async updateCard(channel: LarkChannel, fullCard: CardObject): Promise<void> {
    if (!this.cardId) return;
    const data = JSON.stringify(fullCard);
    const push = async (): Promise<void> => {
      await channel.rawClient.cardkit.v1.card.update({
        path: { card_id: this.cardId },
        data: { card: { type: 'card_json', data }, sequence: ++this.seq, uuid: `u_${this.cardId}_${this.seq}` },
      });
      this.lastContent = data;
    };
    for (let i = 0; ; i++) {
      await this.pacer?.wait();
      try {
        await push();
        return;
      } catch (err) {
        const rl = isRateLimited(err);
        if (rl) this.pacer?.penalize();
        if (i >= (rl ? TERMINAL_RL_RETRIES : 1)) {
          log.fail('card', err, { phase: 'run-update-retry', cardId: this.cardId, seq: this.seq, rateLimited: rl });
          return;
        }
        log.fail('card', err, { phase: 'run-update', cardId: this.cardId, seq: this.seq, retry: true, rateLimited: rl });
        await new Promise((r) => setTimeout(r, rl ? RL_BACKOFF_BASE_MS * 2 ** i : 3200));
      }
    }
  }
}

type CardBody = { body?: { elements?: Array<Record<string, unknown>> } };

/** Content of the streamed answer element (element_id === eid), or null if the
 * card has no such element yet (top-level in body.elements). */
function answerContent(card: CardObject, eid: string): string | null {
  const els = (card as CardBody).body?.elements;
  if (!Array.isArray(els)) return null;
  for (const el of els) {
    if (el && el.element_id === eid) return typeof el.content === 'string' ? el.content : '';
  }
  return null;
}

/** Serialized card with the answer element's content blanked. A change here is a
 * structural change (reasoning / tools / footer) needing a whole-card update;
 * when it's unchanged and only the answer grew, the pump routes to the element
 * typewriter instead. */
function structureSig(card: CardObject, eid: string | null): string {
  const body = (card as CardBody).body;
  const els = body?.elements;
  if (!eid || !Array.isArray(els)) return JSON.stringify(card);
  const blanked = els.map((el) => (el && el.element_id === eid ? { ...el, content: '' } : el));
  return JSON.stringify({ ...(card as object), body: { ...body, elements: blanked } });
}
