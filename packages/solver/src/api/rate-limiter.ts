export interface RateLimiterOptions {
  windowMs: number;
  maxPerAddress: number;
  maxPerIp: number;
}

export class QuoteRateLimiter {
  private addressBuckets = new Map<string, number[]>();
  private ipBuckets = new Map<string, number[]>();

  constructor(private readonly options: RateLimiterOptions) {}

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

    // Record request timestamp
    addrTimestamps.push(now);
    this.addressBuckets.set(normalizedAddr, addrTimestamps);
    ipTimestamps.push(now);
    this.ipBuckets.set(ip, ipTimestamps);

    return { allowed: true };
  }

  reset(): void {
    this.addressBuckets.clear();
    this.ipBuckets.clear();
  }
}

export interface HttpRequestLike {
  headers: Record<string, string | string[] | undefined>;
  ip?: string | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
}

export function extractClientIp(
  req: HttpRequestLike,
  trustedProxy: boolean,
): string {
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
    }
  }
  return req.socket?.remoteAddress || req.ip || '127.0.0.1';
}
