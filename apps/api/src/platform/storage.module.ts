import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Global, Injectable, Module } from '@nestjs/common';
import { AppException } from './app-exception';
import { ConfigResolverService } from '../config/config-resolver.service';
import { CredentialVault } from '../config/credential-vault.service';
import {
  LocalBlobStore,
  createBlobStore,
  localRootOf,
  type BlobStorePort,
  type BlobStoreStatus,
} from './blob-store';

const DEV_SIGNING_SECRET = randomBytes(32).toString('base64url');

@Injectable()
export class StorageService {
  private readonly localRoot = localRootOf();
  private readonly fallback = new LocalBlobStore(this.localRoot);

  constructor(
    private readonly resolver: ConfigResolverService,
    private readonly vault: CredentialVault,
  ) {}

  private get signingSecret(): string {
    const ref = this.resolver.get<string | null>('storage.secretRef', null);
    return (ref ? this.vault.resolve(ref) : null) ?? DEV_SIGNING_SECRET;
  }

  private currentStore(): { store: BlobStorePort; status: BlobStoreStatus } {
    const type = this.resolver.getString('storage.type', 'local') as 'local' | 's3' | 'minio';
    const secretRef = this.resolver.get<string | null>('storage.secretRef', null);
    const secret = secretRef ? this.vault.resolve(secretRef) : null;
    return createBlobStore({
      type,
      endpoint: this.resolver.getString('storage.endpoint', ''),
      bucket: this.resolver.getString('storage.bucket', 'competition-artifacts'),
      region: this.resolver.getString('storage.region', 'local'),
      secret,
      localRoot: this.localRoot,
    });
  }

  private publish(status: BlobStoreStatus): void {
    globalThis.__COMPETITION_BLOB_STATE__ = status;
  }

  status(): BlobStoreStatus {
    const current = this.currentStore();
    const previous = globalThis.__COMPETITION_BLOB_STATE__;
    const merged: BlobStoreStatus = {
      ...current.status,
      state:
        previous && previous.target.maskedTarget === current.status.target.maskedTarget
          ? previous.state
          : current.status.state,
      lastFailure:
        previous && previous.target.maskedTarget === current.status.target.maskedTarget
          ? previous.lastFailure
          : current.status.lastFailure,
    };
    this.publish(merged);
    return merged;
  }

  ensureRoot(): void {
    if (!existsSync(this.localRoot)) {
      void mkdir(this.localRoot, { recursive: true });
    }
  }

  async save(buffer: Buffer, extension: string): Promise<string> {
    this.ensureRoot();
    const key = `${randomUUID()}${extension.startsWith('.') ? extension : `.${extension}`}`;
    const current = this.currentStore();
    try {
      await current.store.put(key, buffer);
      this.publish({ ...current.status, state: 'ready', lastFailure: null });
      return key;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'put_failed';
      if (current.store.target().type !== 'local') {
        await this.fallback.put(key, buffer);
        this.publish({
          ...current.status,
          state: 'degraded',
          detail: '远端对象存储写入失败，已回退本地存储',
          lastFailure: reason,
        });
        return key;
      }
      this.publish({ ...current.status, state: 'failed', lastFailure: reason });
      throw new AppException('INTERNAL_ERROR', { reason: 'storage_write_failed' });
    }
  }

  async read(storageKey: string): Promise<Buffer> {
    const safe = storageKey.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safe || safe !== storageKey) {
      throw new AppException('RESOURCE_NOT_FOUND');
    }
    const current = this.currentStore();
    try {
      const buffer = await current.store.get(safe);
      this.publish({ ...current.status, state: 'ready', lastFailure: null });
      return buffer;
    } catch (error) {
      if (current.store.target().type !== 'local') {
        try {
          const buffer = await this.fallback.get(safe);
          this.publish({
            ...current.status,
            state: 'degraded',
            detail: '远端对象读取失败，已从本地历史目标回退读取',
            lastFailure: error instanceof Error ? error.message : 'get_failed',
          });
          return buffer;
        } catch {
          this.publish({
            ...current.status,
            state: 'degraded',
            detail: '当前存储目标无此对象，历史目标亦不可读',
            lastFailure: 'artifact_inaccessible',
          });
        }
      }
      throw new AppException('RESOURCE_NOT_FOUND');
    }
  }

  async stat(storageKey: string): Promise<{ exists: boolean; size: number }> {
    const safe = storageKey.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safe || safe !== storageKey) return { exists: false, size: 0 };
    const current = this.currentStore();
    try {
      return await current.store.stat(safe);
    } catch {
      try {
        return await this.fallback.stat(safe);
      } catch {
        return { exists: false, size: 0 };
      }
    }
  }

  async delete(storageKey: string): Promise<void> {
    if (!/^[a-zA-Z0-9._-]+$/.test(storageKey) || storageKey === '.' || storageKey.includes('..')) {
      throw new AppException('RESOURCE_NOT_FOUND');
    }
    const { store } = this.currentStore();
    await store.delete(storageKey);
    if (store.target().type !== 'local') await this.fallback.delete(storageKey);
  }

  sign(documentId: string, userId: string, expiresAt: number): string {
    return createHmac('sha256', this.signingSecret)
      .update(`${documentId}:${userId}:${expiresAt}`)
      .digest('hex');
  }

  verify(documentId: string, userId: string, expiresAt: number, signature: string): boolean {
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
    const expected = this.sign(documentId, userId, expiresAt);
    return expected === signature;
  }

  signedUrl(documentId: string, userId: string): string {
    const expiresAt = Date.now() + 5 * 60 * 1000;
    const sig = this.sign(documentId, userId, expiresAt);
    return `/api/v1/documents/${documentId}/file?exp=${expiresAt}&sig=${sig}`;
  }
}

@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
