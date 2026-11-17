import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { isForbiddenAddress } from '../domain/normalize';
import { AppException } from './app-exception';

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  redirectChain: string[];
  bodyPreview: string;
  internalReason?: string;
  blocked?: boolean;
}

export interface RawFetchResult {
  ok: boolean;
  status: number;
  url: string;
  finalUrl: string;
  redirectChain: string[];
  buffer: Buffer;
  bytes: number;
  fingerprint: string;
  contentType: string | null;
  browserHeaders?: Record<string, string>;
  truncated: boolean;
  internalReason?: string;
}

export interface FetchOptions {
  maxBytes?: number;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  accept?: string;
  pinAddress?: boolean;
  includeBrowserHeaders?: boolean;
  authorizeUrl?: (url: string) => Promise<void>;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const dnsCache = new Map<string, { addresses: Array<{ address: string; family: number }>; expires: number }>();

async function assertPublicHost(url: URL, pinAddress: boolean): Promise<string | undefined> {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AppException('SECURITY_SSRF_BLOCKED', { reason: 'protocol' });
  }
  if (isForbiddenAddress(url.toString())) {
    throw new AppException('SECURITY_SSRF_BLOCKED', { reason: 'forbidden_address' });
  }
  if (pinAddress && (url.username || url.password
    || (url.port && !(url.protocol === 'http:' && url.port === '8080')))) {
    throw new AppException('SECURITY_SSRF_BLOCKED', { reason: 'invalid_authority' });
  }
  const cached = dnsCache.get(url.hostname);
  if (cached && cached.expires > Date.now()) {
    for (const item of cached.addresses) {
      const host = item.family === 6 ? `[${item.address}]` : item.address;
      if (isForbiddenAddress(`http://${host}`)) throw new AppException('SECURITY_SSRF_BLOCKED', { reason: 'private_dns', address: item.address });
    }
    return pinAddress ? cached.addresses[0]?.address : undefined;
  }
  try {
    let addresses: Array<{ address: string; family: number }> = [];
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        addresses = await lookup(url.hostname, { all: true, family: pinAddress ? 4 : 0 });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    if (lastError) throw lastError;
    for (const item of addresses) {
      const host = item.family === 6 ? `[${item.address}]` : item.address;
      if (isForbiddenAddress(`http://${host}`)) {
        throw new AppException('SECURITY_SSRF_BLOCKED', { reason: 'private_dns', address: item.address });
      }
    }
    dnsCache.set(url.hostname, { addresses, expires: Date.now() + 300_000 });
    return pinAddress ? addresses[0]?.address : undefined;
  } catch (error) {
    if (error instanceof AppException) throw error;
    throw new AppException('SOURCE_UNREACHABLE', { reason: 'dns_failed' });
  }
}

function fetchPinned(url: URL, address: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      headers: { ...headers, 'accept-encoding': 'identity' },
      signal,
      agent: false,
      family: 4,
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const status = incoming.statusCode ?? 500;
      const bodyless = [204, 205, 304].includes(status);
      if (bodyless) incoming.resume();
      resolve(new Response(bodyless ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
        status, headers: responseHeaders,
      }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

export async function fetchRaw(input: string, options: FetchOptions = {}): Promise<RawFetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const connectTimeout = options.connectTimeoutMs ?? 5000;
  const readTimeout = options.readTimeoutMs ?? 10000;
  const chain: string[] = [];
  let current: URL;

  try {
    current = new URL(input.trim());
  } catch {
    throw new AppException('SECURITY_SSRF_BLOCKED', { reason: 'invalid_url' });
  }

  for (let hop = 0; hop < 3; hop += 1) {
    const address = await assertPublicHost(current, options.pinAddress ?? false);
    if (options.pinAddress && !address) return failureResult(current.toString(), chain, 0, 'dns_failed');
    await options.authorizeUrl?.(current.toString());
    chain.push(current.toString());

    let response: Response;
    try {
      const headers = {
        'user-agent': 'competition-sj-bot/0.1 (+https://competition.local; metadata collector)',
        accept: options.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      };
      const signal = AbortSignal.timeout(connectTimeout + readTimeout);
      response = address ? await fetchPinned(current, address, headers, signal) :
        await fetch(current.toString(), { method: 'GET', redirect: 'manual', headers, signal });
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const cause = error instanceof Error && error.cause ? ` ${String(error.cause)}` : '';
      const reason = /timeout|aborted/i.test(message) ? 'timeout' : `network_error:${message}${cause}`.slice(0, 500);
      return {
        ok: false,
        status: 0,
        url: current.toString(),
        finalUrl: current.toString(),
        redirectChain: chain,
        buffer: Buffer.alloc(0),
        bytes: 0,
        fingerprint: '',
        contentType: null,
        truncated: false,
        internalReason: reason,
      };
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      if (!location) {
        return failureResult(current.toString(), chain, response.status, 'redirect_without_location');
      }
      try {
        const next = new URL(location, current);
        if (current.protocol === 'https:' && next.protocol === 'http:') {
          return failureResult(next.toString(), chain, response.status, 'https_downgrade');
        }
        current = next;
        continue;
      } catch {
        return failureResult(current.toString(), chain, response.status, 'invalid_redirect');
      }
    }

    const reader = response.body?.getReader();
    let received = 0;
    let truncated = false;
    const chunks: Uint8Array[] = [];
    if (reader) {
      while (received <= maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          if (received > maxBytes) {
            truncated = true;
            chunks.push(value.subarray(0, value.byteLength - (received - maxBytes)));
            received = maxBytes;
            break;
          }
          chunks.push(value);
        }
      }
      await reader.cancel().catch(() => undefined);
    }

    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const fingerprint = createHash('sha256').update(buffer).digest('hex');
    const statusOk = response.status >= 200 && response.status < 400;

    return {
      ok: statusOk && !truncated,
      status: response.status,
      url: input,
      finalUrl: current.toString(),
      redirectChain: chain,
      buffer,
      bytes: buffer.byteLength,
      fingerprint,
      contentType: response.headers.get('content-type'),
      browserHeaders: options.includeBrowserHeaders ? Object.fromEntries([
        'access-control-allow-origin', 'access-control-allow-credentials', 'cross-origin-resource-policy',
        'cross-origin-embedder-policy', 'content-security-policy', 'x-content-type-options', 'x-frame-options',
      ].flatMap(name => {
        const value = response.headers.get(name);
        return value === null ? [] : [[name, value]];
      })) : undefined,
      truncated,
      internalReason: truncated ? 'response_too_large' : undefined,
    };
  }

  return failureResult(current.toString(), chain, 0, 'too_many_redirects');
}

function failureResult(url: string, chain: string[], status: number, reason: string): RawFetchResult {
  return {
    ok: false,
    status,
    url,
    finalUrl: url,
    redirectChain: chain,
    buffer: Buffer.alloc(0),
    bytes: 0,
    fingerprint: '',
    contentType: null,
    truncated: false,
    internalReason: reason,
  };
}

export async function safeFetch(input: string, options?: { maxBytes?: number; timeoutMs?: number }): Promise<SafeFetchResult> {
  try {
    const result = await fetchRaw(input, {
      maxBytes: options?.maxBytes ?? DEFAULT_MAX_BYTES,
      readTimeoutMs: options?.timeoutMs ?? 10000,
    });
    return {
      ok: result.ok,
      status: result.status,
      finalUrl: result.finalUrl,
      redirectChain: result.redirectChain,
      bodyPreview: result.buffer.toString('utf8').slice(0, 2000),
      internalReason: result.internalReason,
    };
  } catch (error) {
    if (error instanceof AppException) throw error;
    throw error;
  }
}

@Injectable()
export class SafeEgressService {
  async fetch(url: string, options?: FetchOptions): Promise<RawFetchResult> {
    return fetchRaw(url, options);
  }
}
