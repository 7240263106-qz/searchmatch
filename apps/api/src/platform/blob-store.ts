import { createHash, createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';

export interface BlobTarget {
  type: 'local' | 's3' | 'minio';
  maskedTarget: string;
  tlsEnabled: boolean | null;
}

export interface BlobStoreStatus {
  target: BlobTarget;
  state: 'ready' | 'degraded' | 'not_enabled' | 'failed';
  detail: string;
  lastFailure: string | null;
  updatedAt: string;
}

export interface BlobStorePort {
  target(): BlobTarget;
  put(key: string, buffer: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<{ exists: boolean; size: number }>;
}

declare global {
  // eslint-disable-next-line no-var
  var __COMPETITION_BLOB_STATE__: BlobStoreStatus | undefined;
}

export class LocalBlobStore implements BlobStorePort {
  constructor(private readonly root: string) {}

  target(): BlobTarget {
    return { type: 'local', maskedTarget: '本地文件存储', tlsEnabled: null };
  }

  async put(key: string, buffer: Buffer): Promise<void> {
    const path = this.safePath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buffer);
  }

  async get(key: string): Promise<Buffer> {
    const path = this.safePath(key);
    if (!existsSync(path)) throw new Error('blob_not_found');
    return readFile(path);
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.safePath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async stat(key: string): Promise<{ exists: boolean; size: number }> {
    const path = this.safePath(key);
    if (!existsSync(path)) return { exists: false, size: 0 };
    const info = await stat(path);
    return { exists: true, size: info.size };
  }

  private safePath(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9._/-]/g, '');
    if (!safe || safe.includes('..') || safe !== key) throw new Error('invalid_storage_key');
    return join(this.root, safe);
  }
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function signAwsV4(input: {
  method: string;
  url: string;
  region: string;
  accessKey: string;
  secretKey: string;
  body?: Buffer;
  now?: Date;
}): Record<string, string> {
  const url = new URL(input.url);
  const now = input.now ?? new Date();
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15)}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body ?? Buffer.alloc(0));
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    input.method.toUpperCase(),
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const kDate = hmac(`AWS4${input.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export class S3CompatibleBlobStore implements BlobStorePort {
  constructor(
    private readonly config: {
      endpoint: string;
      bucket: string;
      region: string;
      accessKey: string;
      secretKey: string;
      type: 's3' | 'minio';
    },
  ) {}

  target(): BlobTarget {
    const parsed = new URL(this.config.endpoint);
    const host = parsed.hostname;
    const maskedHost =
      host.length <= 3 ? '***' : `${host.slice(0, 3)}${'*'.repeat(Math.min(host.length - 3, 10))}`;
    return {
      type: this.config.type,
      maskedTarget: `${parsed.protocol}//${maskedHost}${parsed.port ? `:${parsed.port}` : ''}/${this.config.bucket}`,
      tlsEnabled: parsed.protocol === 'https:',
    };
  }

  private urlOf(key: string): string {
    return `${this.config.endpoint.replace(/\/$/, '')}/${this.config.bucket}/${key}`;
  }

  private headers(method: string, url: string, body?: Buffer): Record<string, string> {
    return signAwsV4({
      method,
      url,
      region: this.config.region,
      accessKey: this.config.accessKey,
      secretKey: this.config.secretKey,
      body,
    });
  }

  async put(key: string, buffer: Buffer): Promise<void> {
    const url = this.urlOf(key);
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        ...this.headers('PUT', url, buffer),
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array(buffer),
    });
    if (!response.ok) throw new Error(`s3_put_http_${response.status}`);
  }

  async get(key: string): Promise<Buffer> {
    const url = this.urlOf(key);
    const response = await fetch(url, { method: 'GET', headers: this.headers('GET', url) });
    if (!response.ok) throw new Error(`s3_get_http_${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const url = this.urlOf(key);
    const response = await fetch(url, {
      method: 'DELETE',
      headers: this.headers('DELETE', url),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`s3_delete_http_${response.status}`);
  }

  async stat(key: string): Promise<{ exists: boolean; size: number }> {
    const url = this.urlOf(key);
    const response = await fetch(url, { method: 'HEAD', headers: this.headers('HEAD', url) });
    if (response.status === 404) return { exists: false, size: 0 };
    if (!response.ok) throw new Error(`s3_head_http_${response.status}`);
    return { exists: true, size: Number(response.headers.get('content-length') ?? 0) };
  }
}

export function createBlobStore(input: {
  type: 'local' | 's3' | 'minio';
  endpoint: string;
  bucket: string;
  region: string;
  secret: string | null;
  localRoot: string;
}): { store: BlobStorePort; status: BlobStoreStatus } {
  const updatedAt = new Date().toISOString();
  if (input.type === 'local' || !input.endpoint) {
    const store = new LocalBlobStore(input.localRoot);
    return {
      store,
      status: {
        target: store.target(),
        state: 'ready',
        detail: '当前运行使用本地文件存储',
        lastFailure: null,
        updatedAt,
      },
    };
  }
  if (!input.secret) {
    const store = new LocalBlobStore(input.localRoot);
    return {
      store,
      status: {
        target: store.target(),
        state: 'not_enabled',
        detail: '远端对象存储凭据缺失，保持本地存储；配置未用于运行',
        lastFailure: 'credential_missing',
        updatedAt,
      },
    };
  }
  const separator = input.secret.indexOf(':');
  if (separator <= 0) {
    const store = new LocalBlobStore(input.localRoot);
    return {
      store,
      status: {
        target: store.target(),
        state: 'not_enabled',
        detail: '远端对象存储凭据格式应为 accessKey:secretKey，保持本地存储',
        lastFailure: 'credential_format_invalid',
        updatedAt,
      },
    };
  }
  const store = new S3CompatibleBlobStore({
    endpoint: input.endpoint,
    bucket: input.bucket,
    region: input.region,
    accessKey: input.secret.slice(0, separator),
    secretKey: input.secret.slice(separator + 1),
    type: input.type,
  });
  return {
    store,
    status: {
      target: store.target(),
      state: 'degraded',
      detail: '远端对象存储已配置，尚未完成真实桶写入校验',
      lastFailure: null,
      updatedAt,
    },
  };
}

export function localRootOf(): string {
  return resolve(process.cwd(), 'uploads');
}
