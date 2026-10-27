import { describe, it, expect } from 'vitest';
import { QuoteRateLimiter, extractClientIp } from '../src/api/rate-limiter.js';

describe('QuoteRateLimiter & extractClientIp', () => {
  it('extractClientIp ignores X-Forwarded-For and X-Real-IP when trustedProxy is false', () => {
    const req = {
      headers: {
        'x-forwarded-for': '203.0.113.195, 70.41.3.18',
        'x-real-ip': '203.0.113.195',
      },
      socket: { remoteAddress: '127.0.0.1' },
      ip: '127.0.0.1',
    };

    expect(extractClientIp(req, false)).toBe('127.0.0.1');
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

  it('QuoteRateLimiter respects window expiration', () => {
    const limiter = new QuoteRateLimiter({
      windowMs: 1000,
      maxPerAddress: 2,
      maxPerIp: 5,
    });

    const now = 1_000_000;
    expect(limiter.check('0xaaa', '10.0.0.1', now).allowed).toBe(true);
    expect(limiter.check('0xaaa', '10.0.0.1', now + 100).allowed).toBe(true);
    expect(limiter.check('0xaaa', '10.0.0.1', now + 200).allowed).toBe(false);

    // After window expires (1001ms later)
    expect(limiter.check('0xaaa', '10.0.0.1', now + 1001).allowed).toBe(true);
  });

  it('QuoteRateLimiter checks IP limit independently of address limit', () => {
    const limiter = new QuoteRateLimiter({
      windowMs: 5000,
      maxPerAddress: 10,
      maxPerIp: 2,
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
  });
});
