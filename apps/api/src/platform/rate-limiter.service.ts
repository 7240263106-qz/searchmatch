import { Injectable } from '@nestjs/common';
import { ConfigResolverService } from '../config/config-resolver.service';

const DEFAULT_URL_INTERVAL_MS = 60_000;
const DEFAULT_DOMAIN_INTERVAL_MS = 2_000;

@Injectable()
export class RateLimiterService {
  private readonly lastRequestAt = new Map<string, number>();

  constructor(private readonly resolver: ConfigResolverService) {}

  private get urlIntervalMs(): number {
    return this.resolver.getNumber('crawl.minUrlIntervalMs', DEFAULT_URL_INTERVAL_MS);
  }

  private get domainIntervalMs(): number {
    const configured = Math.floor(this.urlIntervalMs / 30);
    return Math.max(500, configured || DEFAULT_DOMAIN_INTERVAL_MS);
  }

  async waitForUrl(url: string, minIntervalMs?: number): Promise<void> {
    const interval = minIntervalMs ?? this.urlIntervalMs;
    const key = this.normalize(url);
    const now = Date.now();
    const last = this.lastRequestAt.get(key) ?? 0;
    const waitMs = Math.max(0, last + interval - now);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, interval)));
    }
    this.lastRequestAt.set(key, Date.now());
  }

  async waitForDomain(url: string, minIntervalMs?: number): Promise<void> {
    const interval = minIntervalMs ?? this.domainIntervalMs;
    let hostname = 'unknown';
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = 'unknown';
    }
    const now = Date.now();
    const last = this.lastRequestAt.get(`domain:${hostname}`) ?? 0;
    const waitMs = Math.max(0, last + interval - now);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, interval)));
    }
    this.lastRequestAt.set(`domain:${hostname}`, Date.now());
  }

  noteRateLimited(url: string): void {
    try {
      const hostname = new URL(url).hostname;
      this.lastRequestAt.set(`domain:${hostname}`, Date.now() + Math.min(30_000, this.domainIntervalMs));
    } catch {
      // ignore
    }
  }

  private normalize(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return url;
    }
  }
}