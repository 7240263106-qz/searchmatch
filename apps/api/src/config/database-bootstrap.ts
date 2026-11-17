import { PrismaClient } from '@prisma/client';
import { CredentialVault } from './credential-vault.service';
import type { PrismaService } from '../platform/prisma.module';

export interface DatabaseConfigSnapshot {
  host: string;
  port: number;
  name: string;
  user: string;
  secretRef: string | null;
  tlsRequired: boolean;
  poolMax: number;
}

export interface DatabaseBootstrapResult {
  applied: boolean;
  source: 'config' | 'env_bootstrap' | 'sqlite';
  configVersion: number;
  targetMasked: string;
  tlsEnabled: boolean;
  reason?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __COMPETITION_DB_BOOTSTRAP__: DatabaseBootstrapResult | undefined;
}

export function assembleDatabaseUrl(
  snapshot: DatabaseConfigSnapshot,
  secret: string | null,
): string | null {
  if (!snapshot.host || !snapshot.name || !snapshot.user) return null;
  if (!secret) return null;
  const params = new URLSearchParams({ connection_limit: String(snapshot.poolMax) });
  if (snapshot.tlsRequired) params.set('sslmode', 'require');
  return `postgresql://${encodeURIComponent(snapshot.user)}:${encodeURIComponent(secret)}@${snapshot.host}:${snapshot.port}/${encodeURIComponent(snapshot.name)}?${params.toString()}`;
}

export function maskDatabaseUrl(url: string): { targetMasked: string; tlsEnabled: boolean } {
  const tlsEnabled = /sslmode=(require|verify-ca|verify-full)/i.test(url);
  if (url.startsWith('file:') || url.startsWith('sqlite:')) {
    return { targetMasked: 'sqlite:本地开发库', tlsEnabled: false };
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const maskedHost =
      host.length <= 3 ? '***' : `${host.slice(0, 3)}${'*'.repeat(Math.min(host.length - 3, 10))}`;
    return {
      targetMasked: `${parsed.protocol}//${maskedHost}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`,
      tlsEnabled,
    };
  } catch {
    return { targetMasked: '数据库（连接串无法解析）', tlsEnabled };
  }
}

/**
 * 在 Nest 容器创建前读取配置库，把数据库配置组装为运行期连接串。
 * 当前构建使用 SQLite provider 时跳过；生产切 PostgreSQL 后生效。
 */
export async function applyDatabaseConfigFromStore(): Promise<void> {
  const bootstrapUrl = process.env.DATABASE_URL;
  if (!bootstrapUrl) {
    globalThis.__COMPETITION_DB_BOOTSTRAP__ = {
      applied: false,
      source: 'env_bootstrap',
      configVersion: 0,
      targetMasked: '未配置 DATABASE_URL',
      tlsEnabled: false,
      reason: 'missing_env',
    };
    return;
  }
  if (!/^postgres(ql)?:\/\//i.test(bootstrapUrl)) {
    const masked = maskDatabaseUrl(bootstrapUrl);
    globalThis.__COMPETITION_DB_BOOTSTRAP__ = {
      applied: false,
      source: 'sqlite',
      configVersion: 0,
      targetMasked: masked.targetMasked,
      tlsEnabled: masked.tlsEnabled,
      reason: 'sqlite_provider_uses_env',
    };
    return;
  }

  const client = new PrismaClient();
  try {
    const latest = await client.systemConfigVersion.findFirst({ orderBy: { version: 'desc' } });
    if (!latest) {
      const masked = maskDatabaseUrl(bootstrapUrl);
      globalThis.__COMPETITION_DB_BOOTSTRAP__ = {
        applied: false,
        source: 'env_bootstrap',
        configVersion: 0,
        targetMasked: masked.targetMasked,
        tlsEnabled: masked.tlsEnabled,
        reason: 'no_config_version',
      };
      return;
    }
    const rows = await client.systemConfigValue.findMany({ where: { versionNo: latest.version } });
    const valueOf = (key: string): string | null => {
      const row = rows.find((entry) => entry.key === key);
      if (!row?.valueJson) return null;
      try {
        return String(JSON.parse(row.valueJson));
      } catch {
        return null;
      }
    };
    const snapshot: DatabaseConfigSnapshot = {
      host: valueOf('db.host') ?? '127.0.0.1',
      port: Number(valueOf('db.port') ?? 5432),
      name: valueOf('db.name') ?? 'competition',
      user: valueOf('db.user') ?? 'competition',
      secretRef: rows.find((entry) => entry.key === 'db.secretRef')?.secretRefId ?? null,
      tlsRequired: valueOf('db.tlsRequired') === 'true',
      poolMax: Number(valueOf('db.poolMax') ?? 10),
    };
    const vault = new CredentialVault(client as unknown as PrismaService);
    const secret = snapshot.secretRef ? vault.resolve(snapshot.secretRef) : null;
    const assembled = assembleDatabaseUrl(snapshot, secret);
    if (assembled) {
      process.env.DATABASE_URL = assembled;
      const masked = maskDatabaseUrl(assembled);
      globalThis.__COMPETITION_DB_BOOTSTRAP__ = {
        applied: true,
        source: 'config',
        configVersion: latest.version,
        targetMasked: masked.targetMasked,
        tlsEnabled: masked.tlsEnabled,
      };
    } else {
      const masked = maskDatabaseUrl(bootstrapUrl);
      globalThis.__COMPETITION_DB_BOOTSTRAP__ = {
        applied: false,
        source: 'env_bootstrap',
        configVersion: latest.version,
        targetMasked: masked.targetMasked,
        tlsEnabled: masked.tlsEnabled,
        reason: 'credential_missing',
      };
    }
  } catch (error) {
    const masked = maskDatabaseUrl(bootstrapUrl);
    globalThis.__COMPETITION_DB_BOOTSTRAP__ = {
      applied: false,
      source: 'env_bootstrap',
      configVersion: 0,
      targetMasked: masked.targetMasked,
      tlsEnabled: masked.tlsEnabled,
      reason: error instanceof Error ? error.message : 'bootstrap_failed',
    };
  } finally {
    await client.$disconnect();
  }
}