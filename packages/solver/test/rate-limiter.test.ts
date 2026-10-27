import { describe, it, expect, vi } from 'vitest';
import {
  QuoteRateLimiter,
  extractClientIp,
  UntrustedProxyHeaderError,
} from '../src/api/rate-limiter.js';

describe('QuoteRateLimiter & extractClientIp', () => {
  it('extractClientIp ignores X-Forwarded-For and X-Real-IP when trustedProxy is false on testnet', () => {
    const req = {
      headers: {
        'x-forwarded-for': '203.0.113.195, 70.41.3.18',
        'x-real-ip': '203.0.113.195',
      },
      socket: { remoteAddress: '127.0.0.1' },
      ip: '127.0.0.1',
    };

    expect(extractClientIp(req, false, 'testnet')).toBe('127.0.0.1');
  });

  it('extractClientIp extracts first client IP when trustedProxy is true', () => {
    const req1 = {
      headers: {
        'x-forwarded-for': '203.0.113.195, 70.41.3.18',
      },
      socket: { remoteAddress: '10.0.0.1' },
    };
    expect(extractClientIp(req1, true)).toBe('203.0.113.195');

    const req2 = {
      headers: {
        'x-real-ip': '198.51.100.42',
      },
      socket: { remoteAddress: '10.0.0.1' },
    };
    expect(extractClientIp(req2, true)).toBe('198.51.100.42');
  });

  it('fails closed on mainnet if trustedProxy is unset while forwarding header is present', () => {
    const reqWithXff = {
      headers: {
        'x-forwarded-for': '198.51.100.1',
      },
      socket: { remoteAddress: '10.0.0.1' },
    };

    expect(() => extractClientIp(reqWithXff, false, 'mainnet')).toThrowError(
      UntrustedProxyHeaderError,
    );

    const reqWithXRealIp = {
      headers: {
        'x-real-ip': '198.51.100.2',
      },
      socket: { remoteAddress: '10.0.0.1' },
    };

    expect(() =>
      extractClientIp(reqWithXRealIp, false, 'mainnet'),
    ).toThrowError(UntrustedProxyHeaderError);

    // When trustedProxy is true on mainnet, it extracts IP without throwing
    expect(extractClientIp(reqWithXff, true, 'mainnet')).toBe('198.51.100.1');

    // On mainnet without forwarding headers, succeeds even if trustedProxy is false
    const directReq = {
      headers: {},
      socket: { remoteAddress: '198.51.100.99' },
    };
    expect(extractClientIp(directReq, false, 'mainnet')).toBe('198.51.100.99');
  });

  it('QuoteRateLimiter respects window expiration', () => {
    const limiter = new QuoteRateLimiter({
      windowMs: 1000,
      maxPerAddress: 2,
      maxPerIp: 5,
      pruneIntervalMs: 0,
    });

    const now = 1_000_000;
    expect(limiter.check('0xaaa', '10.0.0.1', now).allowed).toBe(true);
    expect(limiter.check('0xaaa', '10.0.0.1', now + 100).allowed).toBe(true);
    expect(limiter.check('0xaaa', '10.0.0.1', now + 200).allowed).toBe(false);

    // After window expires (1001ms later)
    expect(limiter.check('0xaaa', '10.0.0.1', now + 1001).allowed).toBe(true);
    limiter.stop();
  });

  it('QuoteRateLimiter checks IP limit independently of address limit', () => {
    const limiter = new QuoteRateLimiter({
      windowMs: 5000,
      maxPerAddress: 10,
      maxPerIp: 2,
      pruneIntervalMs: 0,
    });

    const now = 1_000_000;
    expect(limiter.check('0xaddr1', '1.1.1.1', now).allowed).toBe(true);
    expect(limiter.check('0xaddr2', '1.1.1.1', now).allowed).toBe(true);

    // 3rd request from same IP with different address is blocked by IP limit
    const res = limiter.check('0xaddr3', '1.1.1.1', now);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('ip');

    // Different IP with unused address succeeds
    expect(limiter.check('0xaddr3', '2.2.2.2', now).allowed).toBe(true);
    limiter.stop();
  });

  it('QuoteRateLimiter prunes idle/expired keys to prevent unbounded memory growth', () => {
    const limiter = new QuoteRateLimiter({
      windowMs: 1000,
      maxPerAddress: 5,
      maxPerIp: 5,
      pruneIntervalMs: 0, // manual prune for deterministic test
    });

    const t0 = 1_000_000;

    // Simulate rotating through 100 addresses across 20 IPs
    for (let i = 0; i < 100; i++) {
      const addr = `0xaddr_${i}`;
      const ip = `10.0.0.${i % 20}`;
      limiter.check(addr, ip, t0);
    }

    expect(limiter.getAddressBucketCount()).toBe(100);
    expect(limiter.getIpBucketCount()).toBe(20);

    // Before window expiration: prune does not delete active buckets
    limiter.prune(t0 + 500);
    expect(limiter.getAddressBucketCount()).toBe(100);
    expect(limiter.getIpBucketCount()).toBe(20);

    // After window expiration: prune drops all expired idle keys
    limiter.prune(t0 + 1001);
    expect(limiter.getAddressBucketCount()).toBe(0);
    expect(limiter.getIpBucketCount()).toBe(0);

    limiter.stop();
  });

  it('QuoteRateLimiter enforces maxEntries map size cap', () => {
    const limiter = new QuoteRateLimiter({
      windowMs: 60_000,
      maxPerAddress: 5,
      maxPerIp: 5,
      maxEntries: 10, // low cap to test eviction
      pruneIntervalMs: 0,
    });

    const t0 = 1_000_000;

    // Insert 25 unique addresses
    for (let i = 0; i < 25; i++) {
      limiter.check(`0xaddr_${i}`, `10.0.0.${i}`, t0 + i);
    }

    // Size must never exceed maxEntries (10)
    expect(limiter.getAddressBucketCount()).toBeLessThanOrEqual(10);
    expect(limiter.getIpBucketCount()).toBeLessThanOrEqual(10);

    limiter.stop();
  });

  it('QuoteRateLimiter timer periodically triggers pruning', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new QuoteRateLimiter({
        windowMs: 1000,
        maxPerAddress: 5,
        maxPerIp: 5,
        pruneIntervalMs: 2000, // timer fires every 2s
      });

      const t0 = Date.now();
      limiter.check('0xaddr1', '1.2.3.4', t0);
      expect(limiter.getAddressBucketCount()).toBe(1);

      // Advance time beyond window + timer interval
      vi.advanceTimersByTime(2500);

      expect(limiter.getAddressBucketCount()).toBe(0);
      expect(limiter.getIpBucketCount()).toBe(0);

      limiter.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
