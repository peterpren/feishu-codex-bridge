import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecentIdCache } from '../src/bot/handle-message';

describe('RecentIdCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flags a re-delivered id as duplicate within the TTL', () => {
    const cache = new RecentIdCache();
    expect(cache.seen('om_1')).toBe(false);
    expect(cache.seen('om_1')).toBe(true);
    expect(cache.seen('om_2')).toBe(false);
  });

  it('lets the same id through again after the TTL expires', () => {
    vi.useFakeTimers();
    const cache = new RecentIdCache(2048, 10 * 60_000);
    expect(cache.seen('om_1')).toBe(false);
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(cache.seen('om_1')).toBe(true);
    vi.advanceTimersByTime(10 * 60_000);
    expect(cache.seen('om_1')).toBe(false);
  });

  it('evicts the oldest entry beyond maxEntries', () => {
    const cache = new RecentIdCache(2, 10 * 60_000);
    expect(cache.seen('a')).toBe(false);
    expect(cache.seen('b')).toBe(false);
    expect(cache.seen('c')).toBe(false);
    expect(cache.seen('a')).toBe(false);
    expect(cache.seen('c')).toBe(true);
  });
});
