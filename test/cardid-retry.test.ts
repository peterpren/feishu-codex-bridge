import { describe, expect, it } from 'vitest';
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
