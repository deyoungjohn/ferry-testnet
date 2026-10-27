export interface RateLimiterOptions {
  windowMs: number;
  maxPerAddress: number;
  maxPerIp: number;
  maxEntries?: number; // default: 10_000
  pruneIntervalMs?: number; // default: 60_000 (0 to disable background timer)
}

export class UntrustedProxyHeaderError extends Error {
  readonly code = 'UNTRUSTED_PROXY_HEADER';

  constructor(
    message = 'Forwarding headers (X-Forwarded-For / X-Real-IP) are rejected on mainnet when TRUSTED_PROXY is disabled',
  ) {
    super(message);
    this.name = 'UntrustedProxyHeaderError';
  }
}

export class QuoteRateLimiter {
  private addressBuckets = new Map<string, number[]>();
  private ipBuckets = new Map<string, number[]>();
  private readonly maxEntries: number;
  private pruneTimer?: NodeJS.Timeout | undefined;

  constructor(private readonly options: RateLimiterOptions) {
    this.maxEntries = options.maxEntries ?? 10_000;
    const pruneInterval = options.pruneIntervalMs ?? 60_000;
    if (pruneInterval > 0) {
      this.pruneTimer = setInterval(() => {
        this.prune();
      }, pruneInterval);
      this.pruneTimer.unref?.();
    }
  }

  check(
    address: string,
    ip: string,
    now: number = Date.now(),
  ): { allowed: boolean; reason?: 'address' | 'ip' } {
    const normalizedAddr = address.toLowerCase();

    // Check address rate limit
    const addrTimestamps = (
      this.addressBuckets.get(normalizedAddr) || []
    ).filter((t) => now - t < this.options.windowMs);
    if (addrTimestamps.length >= this.options.maxPerAddress) {
      this.addressBuckets.set(normalizedAddr, addrTimestamps);
      return { allowed: false, reason: 'address' };
    }

    // Check IP rate limit
    const ipTimestamps = (this.ipBuckets.get(ip) || []).filter(
      (t) => now - t < this.options.windowMs,
    );
    if (ipTimestamps.length >= this.options.maxPerIp) {
      this.ipBuckets.set(ip, ipTimestamps);
      return { allowed: false, reason: 'ip' };
    }

    // Enforce map size limits before inserting new keys
    if (
      !this.addressBuckets.has(normalizedAddr) &&
      this.addressBuckets.size >= this.maxEntries
    ) {
      this.prune(now);
      if (this.addressBuckets.size >= this.maxEntries) {
        const oldestKey = this.addressBuckets.keys().next().value;
        if (oldestKey !== undefined) {
          this.addressBuckets.delete(oldestKey);
        }
      }
    }

    if (!this.ipBuckets.has(ip) && this.ipBuckets.size >= this.maxEntries) {
      this.prune(now);
      if (this.ipBuckets.size >= this.maxEntries) {
        const oldestKey = this.ipBuckets.keys().next().value;
        if (oldestKey !== undefined) {
          this.ipBuckets.delete(oldestKey);
        }
      }
    }

    // Record request timestamp
    addrTimestamps.push(now);
    this.addressBuckets.set(normalizedAddr, addrTimestamps);
    ipTimestamps.push(now);
    this.ipBuckets.set(ip, ipTimestamps);

    return { allowed: true };
  }

  prune(now: number = Date.now()): void {
    for (const [addr, timestamps] of this.addressBuckets.entries()) {
      const active = timestamps.filter((t) => now - t < this.options.windowMs);
      if (active.length === 0) {
        this.addressBuckets.delete(addr);
      } else {
        this.addressBuckets.set(addr, active);
      }
    }

    for (const [ip, timestamps] of this.ipBuckets.entries()) {
      const active = timestamps.filter((t) => now - t < this.options.windowMs);
      if (active.length === 0) {
        this.ipBuckets.delete(ip);
      } else {
        this.ipBuckets.set(ip, active);
      }
    }
  }

  getAddressBucketCount(): number {
    return this.addressBuckets.size;
  }

  getIpBucketCount(): number {
    return this.ipBuckets.size;
  }

  getMaxEntries(): number {
    return this.maxEntries;
  }

  reset(): void {
    this.addressBuckets.clear();
    this.ipBuckets.clear();
  }

  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }
}

export interface HttpRequestLike {
  headers: Record<string, string | string[] | undefined>;
  ip?: string | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
}

export function hasForwardingHeaders(req: HttpRequestLike): boolean {
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (typeof xForwardedFor === 'string' && xForwardedFor.trim().length > 0) {
    return true;
  }
  if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
    return true;
  }
  const xRealIp = req.headers['x-real-ip'];
  if (typeof xRealIp === 'string' && xRealIp.trim().length > 0) {
    return true;
  }
  if (Array.isArray(xRealIp) && xRealIp.length > 0) {
    return true;
  }
  return false;
}

export function extractClientIp(
  req: HttpRequestLike,
  trustedProxy: boolean,
  network: 'testnet' | 'mainnet' = 'testnet',
): string {
  if (network === 'mainnet' && !trustedProxy && hasForwardingHeaders(req)) {
    throw new UntrustedProxyHeaderError();
  }

  if (trustedProxy) {
    const xForwardedFor = req.headers['x-forwarded-for'];
    if (typeof xForwardedFor === 'string' && xForwardedFor.trim().length > 0) {
      const firstIp = xForwardedFor.split(',')[0]?.trim();
      if (firstIp) return firstIp;
    } else if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
      const firstIp = xForwardedFor[0]?.split(',')[0]?.trim();
      if (firstIp) return firstIp;
    }
    const xRealIp = req.headers['x-real-ip'];
    if (typeof xRealIp === 'string' && xRealIp.trim().length > 0) {
      return xRealIp.trim();
    } else if (Array.isArray(xRealIp) && xRealIp.length > 0) {
      const firstIp = xRealIp[0]?.trim();
      if (firstIp) return firstIp;
    }
  }
  return req.socket?.remoteAddress || req.ip || '127.0.0.1';
}
