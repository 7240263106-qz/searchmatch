import { Injectable, Logger } from '@nestjs/common';
import { fetchRaw } from './safe-fetch';

interface RobotsRule {
  disallow: string[];
  allow: string[];
}

interface RobotsCacheEntry {
  rules: RobotsRule;
  fetchedAt: number;
  status: 'ok' | 'not_found' | 'denied' | 'unknown';
  httpStatus?: number;
}

interface RobotsDecision {
  allowed: boolean;
  reason: string;
  robotsUrl?: string;
  httpStatus?: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class RobotsService {
  private readonly logger = new Logger(RobotsService.name);
  private readonly cache = new Map<string, RobotsCacheEntry>();

  async isAllowed(targetUrl: string): Promise<RobotsDecision> {
    let url: URL;
    try {
      url = new URL(targetUrl);
    } catch {
      return { allowed: false, reason: 'invalid_url' };
    }

    const origin = url.origin;
    const robotsUrl = `${origin}/robots.txt`;
    const cached = this.cache.get(origin);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      if (cached.status === 'denied') return { allowed: false, reason: 'robots_denied', robotsUrl, httpStatus: cached.httpStatus };
      if (cached.status === 'unknown') return { allowed: false, reason: 'robots_unknown', robotsUrl, httpStatus: cached.httpStatus };
      return { allowed: this.matches(url.pathname, cached.rules), reason: cached.status, robotsUrl };
    }

    try {
      const result = await fetchRaw(robotsUrl, { maxBytes: 512 * 1024, readTimeoutMs: 6000, pinAddress: true });
      if (result.status === 404) {
        this.cache.set(origin, { rules: { disallow: [], allow: [] }, fetchedAt: Date.now(), status: 'not_found' });
        return { allowed: true, reason: 'not_found', robotsUrl };
      }
      if (result.status === 401 || result.status === 403) {
        this.cache.set(origin, { rules: { disallow: ['/'], allow: [] }, fetchedAt: Date.now(), status: 'denied', httpStatus: result.status });
        return { allowed: false, reason: 'robots_denied', robotsUrl, httpStatus: result.status };
      }
      if (!result.ok) {
        const httpStatus = result.status || undefined;
        this.cache.set(origin, { rules: { disallow: [], allow: [] }, fetchedAt: Date.now(), status: 'unknown', httpStatus });
        return { allowed: false, reason: result.internalReason ?? 'robots_unknown', robotsUrl, httpStatus };
      }

      const rules = this.parse(result.buffer.toString('utf8'));
      this.cache.set(origin, { rules, fetchedAt: Date.now(), status: 'ok' });
      return { allowed: this.matches(url.pathname, rules), reason: 'ok', robotsUrl };
    } catch (error) {
      this.logger.warn(`robots fetch failed: ${(error as Error).message}`);
      this.cache.set(origin, { rules: { disallow: [], allow: [] }, fetchedAt: Date.now(), status: 'unknown' });
      return { allowed: false, reason: 'robots_unknown', robotsUrl };
    }
  }

  private parse(content: string): RobotsRule {
    const disallow: string[] = [];
    const allow: string[] = [];
    let appliesToAll = false;
    let seenAnyAgent = false;

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (!line) continue;
      const separator = line.indexOf(':');
      if (separator < 0) continue;
      const field = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();

      if (field === 'user-agent') {
        appliesToAll = value === '*';
        if (appliesToAll) seenAnyAgent = true;
        continue;
      }
      if (!appliesToAll && seenAnyAgent) continue;
      if (!appliesToAll) continue;

      if (field === 'disallow' && value) disallow.push(value);
      if (field === 'allow' && value) allow.push(value);
    }

    return { disallow, allow };
  }

  private matches(pathname: string, rules: RobotsRule): boolean {
    const normalized = pathname || '/';
    const allowedByRule = rules.allow.some((rule) => normalized.startsWith(rule));
    if (allowedByRule) return true;
    const disallowed = rules.disallow.some((rule) => rule !== '' && normalized.startsWith(rule));
    return !disallowed;
  }
}
