import { isIP } from 'node:net';

const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'spm', 'from', 'share_token'];

export function normalizeName(value: string): string {
  return value
    .replace(/[\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[（）]/g, (match) => (match === '（' ? '(' : ')'))
    .trim()
    .toLowerCase();
}

export function normalizeCompetitionName(value: string): string {
  return normalizeName(value)
    .replace(/[“”"'’‘]/g, '')
    .replace(/\s*[-—–]\s*/g, ' ')
    .trim();
}

export function normalizeAddress(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('INVALID_URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('INVALID_PROTOCOL');
  }
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.includes(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  return `${url.protocol}//${url.host}${pathname}${url.search}`;
}

export function isHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isForbiddenAddress(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return true;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '169.254.169.254') return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [, a, b] = ipv4;
    const first = Number(a);
    const second = Number(b);
    if (first === 127 || first === 10 || first === 0) return true;
    if (first === 192 && second === 168) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 169 && second === 254) return true;
    if (first === 100 && second >= 64 && second <= 127) return true;
    if (first >= 224) return true;
  }
  if (isIP(host) === 6) return !/^[23][0-9a-f]{3}:/.test(host);
  return false;
}

export function safeSlug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
