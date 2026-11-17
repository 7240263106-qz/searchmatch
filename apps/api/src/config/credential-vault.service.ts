import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../platform/prisma.module';

interface VaultEntry {
  refId: string;
  purpose: string;
  iv: string;
  tag: string;
  ciphertext: string;
  maskedTail: string;
  createdAt: string;
  updatedAt: string;
}

interface VaultFile {
  version: 1;
  entries: Record<string, VaultEntry>;
}

export interface CredentialWriteResult {
  secretRefId: string;
  maskedTail: string;
  configured: true;
  lastUpdatedAt: string;
}

@Injectable()
export class CredentialVault {
  private readonly key: Buffer;
  private readonly filePath: string;
  private cache: VaultFile | null = null;

  constructor(private readonly prisma: PrismaService) {
    const baseDir = resolve(process.cwd(), '.credentials');
    this.filePath = resolve(baseDir, 'vault.enc.json');
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.key = this.loadKey(baseDir);
  }

  private loadKey(baseDir: string): Buffer {
    const configured = process.env.CREDENTIAL_VAULT_KEY;
    if (configured) {
      const decoded = Buffer.from(configured, 'base64');
      if (decoded.length === 32) return decoded;
      throw new Error('CREDENTIAL_VAULT_KEY 必须是 base64 编码的 32 字节密钥');
    }
    const keyPath = resolve(baseDir, 'vault.key');
    if (existsSync(keyPath)) {
      const stored = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64');
      if (stored.length !== 32) throw new Error('凭据密钥文件损坏');
      return stored;
    }
    const created = randomBytes(32);
    writeFileSync(keyPath, created.toString('base64'), { mode: 0o600 });
    return created;
  }

  private read(): VaultFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = { version: 1, entries: {} };
      return this.cache;
    }
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as VaultFile;
    if (!parsed || parsed.version !== 1 || typeof parsed.entries !== 'object') {
      throw new Error('凭据文件结构不合法');
    }
    this.cache = parsed;
    return parsed;
  }

  private persist(file: VaultFile): void {
    writeFileSync(this.filePath, JSON.stringify(file), { mode: 0o600 });
    this.cache = file;
  }

  private encrypt(plaintext: string): { iv: string; tag: string; ciphertext: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: encrypted.toString('base64'),
    };
  }

  private decrypt(entry: VaultEntry): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(entry.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  static maskedTailOf(plaintext: string): string {
    const compact = plaintext.trim();
    return compact.length <= 4 ? '****' : compact.slice(-4);
  }

  async write(input: {
    secretRefId?: string;
    purpose: string;
    plaintext: string;
  }): Promise<CredentialWriteResult> {
    const plaintext = input.plaintext.trim();
    if (!plaintext) throw new Error('凭据内容不能为空');
    const maskedTail = CredentialVault.maskedTailOf(plaintext);
    const encrypted = this.encrypt(plaintext);
    const now = new Date().toISOString();
    const file = this.read();
    const refId = input.secretRefId ?? `sec_${randomUUID()}`;
    const previous = file.entries[refId];
    const entry: VaultEntry = {
      refId,
      purpose: input.purpose,
      iv: encrypted.iv,
      tag: encrypted.tag,
      ciphertext: encrypted.ciphertext,
      maskedTail,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    file.entries[refId] = entry;
    this.persist(file);

    await this.prisma.credentialRef.upsert({
      where: { id: refId },
      create: {
        id: refId,
        purpose: input.purpose,
        maskedTail,
        status: 'active',
        lastUpdatedAt: new Date(now),
      },
      update: {
        maskedTail,
        status: 'active',
        lastUpdatedAt: new Date(now),
      },
    });

    return { secretRefId: refId, maskedTail, configured: true, lastUpdatedAt: now };
  }

  rotate(secretRefId: string, plaintext: string): Promise<CredentialWriteResult> {
    const existing = this.read().entries[secretRefId];
    if (!existing) throw new Error('凭据引用不存在');
    return this.write({ secretRefId, purpose: existing.purpose, plaintext });
  }

  resolve(secretRefId: string | null | undefined): string | null {
    if (!secretRefId) return null;
    const entry = this.read().entries[secretRefId];
    if (!entry) return null;
    try {
      return this.decrypt(entry);
    } catch {
      return null;
    }
  }

  tailOf(secretRefId: string | null | undefined): string | null {
    if (!secretRefId) return null;
    return this.read().entries[secretRefId]?.maskedTail ?? null;
  }

  async revoke(secretRefId: string): Promise<void> {
    const file = this.read();
    delete file.entries[secretRefId];
    this.persist(file);
    await this.prisma.credentialRef.update({
      where: { id: secretRefId },
      data: { status: 'revoked' },
    });
  }

  async exists(secretRefId: string | null | undefined): Promise<boolean> {
    if (!secretRefId) return false;
    if (!this.read().entries[secretRefId]) return false;
    const row = await this.prisma.credentialRef.findUnique({ where: { id: secretRefId } });
    return row?.status === 'active';
  }
}