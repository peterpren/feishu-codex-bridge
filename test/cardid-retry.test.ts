import { afterEach, describe, expect, it, vi } from 'vitest';
import { card, md } from '../src/card/cards';
import { isCardIdNotReady } from '../src/card/managed';
import { RunCardStream } from '../src/card/run-card-stream';

function cardIdNotReadyErr(): unknown {
  return {
    response: {
      data: {
        code: 230099,
        msg: 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: cardid is invalid;',
      },
    },
  };
}

function fakeChannel(failSends: number, sendErr: () => unknown) {
  let creates = 0;
  let sends = 0;
  const ok = { data: { message_id: 'om_ok' } };
  return {
    creates: () => creates,
    sends: () => sends,
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: async () => {
              creates++;
              return { data: { card_id: `cs_${creates}` } };
            },
          },
        },
      },
      im: {
        v1: {
          message: {
            reply: async () => {
              sends++;
              if (sends <= failSends) throw sendErr();
              return ok;
            },
            create: async () => {
              sends++;
              if (sends <= failSends) throw sendErr();
              return ok;
            },
          },
        },
      },
    },
  } as any;
}

function fakeStreamChannel(updateErrors: unknown[] = []) {
  let updates = 0;
  return {
    updates: () => updates,
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'cs_1' } }),
            update: async () => {
              updates++;
              const err = updateErrors.shift();
              if (err) throw err;
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        v1: {
          message: {
            create: async () => ({ data: { message_id: 'om_ok' } }),
            reply: async () => ({ data: { message_id: 'om_ok' } }),
          },
        },
      },
    },
  } as any;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('isCardIdNotReady', () => {
  it('matches only Feishu card id propagation lag', () => {
    expect(isCardIdNotReady(cardIdNotReadyErr())).toBe(true);
    expect(isCardIdNotReady({ response: { data: { code: 230099 } } })).toBe(true);
    expect(isCardIdNotReady({ response: { data: { msg: 'cardid is invalid' } } })).toBe(true);
    expect(isCardIdNotReady({ response: { data: { code: 99991663, msg: 'rate limited' } } })).toBe(false);
    expect(isCardIdNotReady(new Error('socket hang up'))).toBe(false);
  });
});

describe('RunCardStream.create retry', () => {
  it('retries create and send when Feishu reports card id not ready', async () => {
    const ch = fakeChannel(1, cardIdNotReadyErr);
    const stream = new RunCardStream();
    const messageId = await stream.create(ch, 'oc_1', card([md('hi')]), {});

    expect(messageId).toBe('om_ok');
    expect(ch.creates()).toBe(2);
    expect(ch.sends()).toBe(2);
  });

  it('does not retry unrelated errors', async () => {
    const ch = fakeChannel(1, () => ({ response: { data: { code: 99991663, msg: 'boom' } } }));
    const stream = new RunCardStream();

    await expect(stream.create(ch, 'oc_1', card([md('hi')]), {})).rejects.toBeTruthy();
    expect(ch.sends()).toBe(1);
  });
});

describe('RunCardStream update stability', () => {
  it('retries terminal card update after a Feishu rate limit', async () => {
    vi.useFakeTimers();
    const ch = fakeStreamChannel([{ response: { status: 429, data: { code: 99991400 } } }]);
    const stream = new RunCardStream();
    await stream.create(ch, 'oc_1', card([md('running')]), {});

    const p = stream.updateCard(ch, card([md('done')]));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(ch.updates()).toBe(2);
  });

  it('does not advance whole-card stream baselines when a frame fails', async () => {
    vi.useFakeTimers();
    const ch = fakeStreamChannel([{ response: { status: 429, data: { code: 99991400 } } }]);
    const stream = new RunCardStream();
    await stream.create(ch, 'oc_2', card([md('running')]), {});

    expect(await stream.streamCard(ch, card([md('frame')]), true)).toBe(false);
    const p = stream.streamCard(ch, card([md('frame')]), true);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe(true);

    expect(ch.updates()).toBe(2);
  });
});
