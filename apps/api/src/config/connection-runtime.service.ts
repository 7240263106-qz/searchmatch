import { Injectable } from '@nestjs/common';
import type { RuntimeConnectionView } from '@competition/contracts';
import { PrismaService } from '../platform/prisma.module';
import { ConfigResolverService } from './config-resolver.service';
import { maskDatabaseUrl } from './database-bootstrap';

@Injectable()
export class ConnectionRuntimeService {
  private readonly startedAt = new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: ConfigResolverService,
  ) {}

  async database(): Promise<RuntimeConnectionView> {
    const bootstrap = globalThis.__COMPETITION_DB_BOOTSTRAP__;
    const url = process.env.DATABASE_URL ?? 'file:./dev.db';
    const masked = maskDatabaseUrl(url);
    const configuredTls = this.resolver.getBoolean('db.tlsRequired', false);
    let status: RuntimeConnectionView['status'] = 'ready';
    let lastFailure: string | null = null;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      status = 'failed';
      lastFailure = 'database_unreachable';
    }
    const failure = await this.prisma.configTestRecord.findFirst({
      where: { targetType: 'database', resultCode: { not: 'success' } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      kind: 'database',
      targetMasked:
        bootstrap?.applied && bootstrap.targetMasked
          ? bootstrap.targetMasked
          : masked.targetMasked,
      configVersion: this.resolver.snapshotVersion(),
      connectedAt: this.startedAt.toISOString(),
      tlsEnabled: masked.tlsEnabled || configuredTls,
      status,
      lastFailure: failure?.resultCode ?? lastFailure,
      detail:
        bootstrap?.source === 'config'
          ? '运行期连接来自配置快照'
          : bootstrap?.source === 'sqlite'
            ? '本地 SQLite 使用环境引导连接，配置项仅用于 PostgreSQL 生产部署'
            : '使用环境引导连接；配置未完成启用',
    };
  }

  async objectStorage(): Promise<RuntimeConnectionView> {
    const blob = globalThis.__COMPETITION_BLOB_STATE__;
    if (blob) {
      return {
        kind: 'object_storage',
        targetMasked: blob.target.maskedTarget,
        configVersion: this.resolver.snapshotVersion(),
        connectedAt: blob.updatedAt,
        tlsEnabled: blob.target.tlsEnabled,
        status: blob.state === 'ready' ? 'ready' : blob.state,
        lastFailure: blob.lastFailure,
        detail: blob.detail,
      };
    }
    const type = this.resolver.getString('storage.type', 'local');
    const endpoint = this.resolver.getString('storage.endpoint', '');
    const failure = await this.prisma.configTestRecord.findFirst({
      where: { targetType: 'object_storage', resultCode: { not: 'success' } },
      orderBy: { createdAt: 'desc' },
    });
    if (type === 'local' || !endpoint) {
      return {
        kind: 'object_storage',
        targetMasked: '本地文件存储',
        configVersion: this.resolver.snapshotVersion(),
        connectedAt: this.startedAt.toISOString(),
        tlsEnabled: null,
        status: 'ready',
        lastFailure: failure?.resultCode ?? null,
        detail: '当前运行使用本地文件存储；远端对象存储配置已保存但适配器未启用',
      };
    }
    const url = (() => {
      try {
        const parsed = new URL(endpoint);
        const host = parsed.hostname;
        const maskedHost =
          host.length <= 3 ? '***' : `${host.slice(0, 3)}${'*'.repeat(Math.min(host.length - 3, 10))}`;
        return `${parsed.protocol}//${maskedHost}${parsed.port ? `:${parsed.port}` : ''}`;
      } catch {
        return '对象存储（地址无法解析）';
      }
    })();
    return {
      kind: 'object_storage',
      targetMasked: url,
      configVersion: this.resolver.snapshotVersion(),
      connectedAt: this.startedAt.toISOString(),
      tlsEnabled: endpoint.startsWith('https://'),
      status: 'degraded',
      lastFailure: failure?.resultCode ?? null,
      detail: '对象存储配置已保存，运行期读写尚未切换到远端适配器',
    };
  }

  async provenance(): Promise<{
    database: RuntimeConnectionView;
    objectStorage: RuntimeConnectionView;
  }> {
    return {
      database: await this.database(),
      objectStorage: await this.objectStorage(),
    };
  }

  async storageImpact(): Promise<{ affectedArtifacts: number; message: string }> {
    const [snapshots, attachments, documents] = await Promise.all([
      this.prisma.rawPageSnapshot.count(),
      this.prisma.crawlAttachment.count(),
      this.prisma.competitionDocument.count(),
    ]);
    const affectedArtifacts = snapshots + attachments + documents;
    return {
      affectedArtifacts,
      message:
        affectedArtifacts > 0
          ? `切换存储目标将影响 ${affectedArtifacts} 个历史原件：已有原件不删除、不改写指纹，读取时按新目标标注可用性`
          : '当前无历史原件，切换存储目标不产生迁移影响',
    };
  }
}