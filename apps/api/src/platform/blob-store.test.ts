import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalBlobStore,
  S3CompatibleBlobStore,
  createBlobStore,
  signAwsV4,
} from './blob-store';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('LocalBlobStore', () => {
  it('写入、读取与状态查询使用稳定对象键', async () => {
    const root = mkdtempSync(join(tmpdir(), 'blob-local-'));
    tempDirs.push(root);
    const store = new LocalBlobStore(root);
    const key = 'snapshots/abc-1.html';
    const buffer = Buffer.from('<html>snapshot</html>');

    await store.put(key, buffer);
    const read = await store.get(key);
    const stat = await store.stat(key);

    expect(read.equals(buffer)).toBe(true);
    expect(stat.exists).toBe(true);
    expect(stat.size).toBe(buffer.byteLength);
    expect(store.target().type).toBe('local');
  });

  it('拒绝路径穿越键', async () => {
    const root = mkdtempSync(join(tmpdir(), 'blob-local-'));
    tempDirs.push(root);
    const store = new LocalBlobStore(root);
    await expect(store.put('../escape.txt', Buffer.from('x'))).rejects.toThrow('invalid_storage_key');
  });

  it('删除原件后可重复清理，且不会允许删除根目录外的文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'blob-delete-'));
    tempDirs.push(root);
    const store = new LocalBlobStore(root);
    await store.put('original.txt', Buffer.from('original'));
    await store.delete('original.txt');
    expect((await store.stat('original.txt')).exists).toBe(false);
    await expect(store.delete('original.txt')).resolves.toBeUndefined();
    await expect(store.delete('../escape.txt')).rejects.toThrow('invalid_storage_key');
  });
});

describe('S3CompatibleBlobStore', () => {
  it('发送签名 DELETE 请求，只有服务端确认成功才完成删除', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', request);
    const store = new S3CompatibleBlobStore({ endpoint: 'https://s3.example.com', bucket: 'test',
      region: 'us-east-1', accessKey: 'access', secretKey: 'secret', type: 's3' });
    await expect(store.delete('original.txt')).resolves.toBeUndefined();
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'DELETE',
      headers: { Authorization: expect.stringContaining('AWS4-HMAC-SHA256') } });
    await expect(store.delete('original.txt')).rejects.toThrow('s3_delete_http_503');
  });

  it('目标脱敏不暴露完整主机与桶', () => {
    const store = new S3CompatibleBlobStore({
      endpoint: 'https://internal-minio.example.com:9000',
      bucket: 'competition-artifacts',
      region: 'us-east-1',
      accessKey: 'ak',
      secretKey: 'sk',
      type: 'minio',
    });
    const target = store.target();
    expect(target.maskedTarget).not.toContain('internal-minio.example.com');
    expect(target.tlsEnabled).toBe(true);
    expect(target.type).toBe('minio');
  });

  it('SigV4 签名对固定输入可复现且不含密钥', () => {
    const headers = signAwsV4({
      method: 'PUT',
      url: 'https://s3.example.com/bucket/object.bin',
      region: 'us-east-1',
      accessKey: 'AKIDEXAMPLE',
      secretKey: 'SECRETEXAMPLE',
      body: Buffer.from('payload'),
      now: new Date('2026-11-08T00:00:00Z'),
    });
    expect(headers.Authorization).toContain('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261108/us-east-1/s3/aws4_request');
    expect(headers.Authorization).not.toContain('SECRETEXAMPLE');
    expect(headers['x-amz-content-sha256']).toHaveLength(64);
  });
});

describe('createBlobStore 选择与降级', () => {
  const root = join(tmpdir(), 'blob-factory');

  it('local 类型直接可用', () => {
    const result = createBlobStore({ type: 'local', endpoint: '', bucket: '', region: '', secret: null, localRoot: root });
    expect(result.status.state).toBe('ready');
    expect(result.store.target().type).toBe('local');
  });

  it('远端凭据缺失时不建连接并回退本地', () => {
    const result = createBlobStore({
      type: 's3',
      endpoint: 'https://s3.example.com',
      bucket: 'bucket',
      region: 'us-east-1',
      secret: null,
      localRoot: root,
    });
    expect(result.status.state).toBe('not_enabled');
    expect(result.status.lastFailure).toBe('credential_missing');
    expect(result.store.target().type).toBe('local');
  });

  it('远端凭据格式错误时不冒充已切换', () => {
    const result = createBlobStore({
      type: 's3',
      endpoint: 'https://s3.example.com',
      bucket: 'bucket',
      region: 'us-east-1',
      secret: 'no-separator',
      localRoot: root,
    });
    expect(result.status.state).toBe('not_enabled');
    expect(result.status.lastFailure).toBe('credential_format_invalid');
  });

  it('远端凭据齐全时状态为降级待真实桶校验', () => {
    const result = createBlobStore({
      type: 's3',
      endpoint: 'https://s3.example.com',
      bucket: 'bucket',
      region: 'us-east-1',
      secret: 'ak:sk',
      localRoot: root,
    });
    expect(result.status.state).toBe('degraded');
    expect(result.store.target().type).toBe('s3');
  });
});
