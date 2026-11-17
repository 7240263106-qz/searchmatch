import { Injectable } from '@nestjs/common';
import type { SourceView } from '@competition/contracts';
import { PrismaService } from '../platform/prisma.module';
import { AuditService } from '../platform/audit.module';
import { AppException } from '../platform/app-exception';
import { isForbiddenAddress, normalizeAddress } from '../domain/normalize';
import { safeFetch } from '../platform/safe-fetch';
import { ConfigResolverService } from '../config/config-resolver.service';

@Injectable()
export class SourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly resolver: ConfigResolverService,
  ) {}

  async list(actorId: string): Promise<SourceView[]> {
    const rows = await this.prisma.sourceDefinition.findMany({
      where: {
        OR: [
          { ownerKind: 'personal', ownerId: actorId },
          { ownerKind: 'team' },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toView(row));
  }

  async create(
    input: {
      name: string;
      address: string;
      type?: string;
      ownerKind?: 'personal' | 'team';
      ownerId?: string;
      intervalSeconds?: number;
    },
    actorId: string,
  ): Promise<SourceView> {
    if (!input.name?.trim()) throw new AppException('VALIDATION_FAILED', { field: 'name' });
    let normalized: string;
    try {
      normalized = normalizeAddress(input.address);
    } catch {
      throw new AppException('VALIDATION_FAILED', { field: 'address' });
    }

    const interval =
      input.intervalSeconds ?? this.resolver.getNumber('crawl.defaultIntervalSeconds', 86400);
    const minInterval = this.resolver.getNumber('crawl.intervalMinSeconds', 600);
    const maxInterval = this.resolver.getNumber('crawl.intervalMaxSeconds', 604800);
    if (interval < minInterval || interval > maxInterval) {
      throw new AppException(
        'VALIDATION_FAILED',
        { field: 'intervalSeconds', min: minInterval, max: maxInterval },
        `采集间隔需在 ${Math.floor(minInterval / 60)} 分钟到 ${Math.floor(maxInterval / 86400)} 天之间`,
      );
    }

    if (isForbiddenAddress(normalized)) {
      await this.audit.record({
        actorId,
        action: 'source.address_blocked',
        objectType: 'source',
        objectId: normalized,
        detail: { reason: 'forbidden_address' },
      });
      throw new AppException('SOURCE_ADDRESS_FORBIDDEN');
    }

    const ownerKind = input.ownerKind ?? 'personal';
    const ownerId = ownerKind === 'team' ? (input.ownerId ?? 'team-demo') : actorId;

    const duplicate = await this.prisma.sourceDefinition.findFirst({
      where: { ownerKind, ownerId, normalizedAddress: normalized },
    });
    if (duplicate) {
      throw new AppException('SOURCE_DUPLICATE', { sourceId: duplicate.id, ownerKind, ownerId });
    }

    const row = await this.prisma.sourceDefinition.create({
      data: {
        name: input.name.trim(),
        address: input.address.trim(),
        normalizedAddress: normalized,
        type: input.type ?? 'official_site',
        ownerKind,
        ownerId,
        intervalSeconds: interval,
        enabled: false,
        verified: false,
      },
    });

    await this.audit.record({
      actorId,
      action: 'source.create',
      objectType: 'source',
      objectId: row.id,
      detail: { normalized },
    });
    return this.toView(row);
  }

  async probe(sourceId: string, actorId: string): Promise<{ verified: boolean; reason?: string; nextRunAt?: string }> {
    const source = await this.prisma.sourceDefinition.findUnique({ where: { id: sourceId } });
    if (!source) throw new AppException('RESOURCE_NOT_FOUND');

    try {
      const result = await safeFetch(source.address, { timeoutMs: 8000 });
      if (!result.ok) {
        await this.prisma.sourceDefinition.update({
          where: { id: sourceId },
          data: {
            verified: false,
            enabled: false,
            consecutiveFailures: { increment: 1 },
          },
        });
        await this.audit.record({
          actorId,
          action: 'source.probe_failed',
          objectType: 'source',
          objectId: sourceId,
          detail: { status: result.status, reason: result.internalReason },
        });
        return { verified: false, reason: result.internalReason ?? 'unreachable' };
      }

      const nextRunAt = new Date(Date.now() + source.intervalSeconds * 1000);
      await this.prisma.sourceDefinition.update({
        where: { id: sourceId },
        data: {
          verified: true,
          enabled: true,
          lastSuccessAt: new Date(),
          consecutiveFailures: 0,
        },
      });
      await this.audit.record({
        actorId,
        action: 'source.probe_success',
        objectType: 'source',
        objectId: sourceId,
        detail: { nextRunAt: nextRunAt.toISOString() },
      });
      return { verified: true, nextRunAt: nextRunAt.toISOString() };
    } catch (error) {
      await this.prisma.sourceDefinition.update({
        where: { id: sourceId },
        data: { verified: false, enabled: false, consecutiveFailures: { increment: 1 } },
      });
      const reason = error instanceof AppException ? 'forbidden_address' : 'probe_failed';
      return { verified: false, reason };
    }
  }

  async setEnabled(sourceId: string, enabled: boolean, actorId: string): Promise<SourceView> {
    const source = await this.prisma.sourceDefinition.findUnique({ where: { id: sourceId } });
    if (!source) throw new AppException('RESOURCE_NOT_FOUND');
    if (enabled && !source.verified) {
      throw new AppException('SOURCE_UNREACHABLE', { reason: '尚未通过探测验证' });
    }
    const row = await this.prisma.sourceDefinition.update({
      where: { id: sourceId },
      data: { enabled },
    });
    await this.audit.record({
      actorId,
      action: enabled ? 'source.enable' : 'source.disable',
      objectType: 'source',
      objectId: sourceId,
    });
    return this.toView(row);
  }

  async health(sourceId: string): Promise<unknown> {
    const source = await this.prisma.sourceDefinition.findUnique({ where: { id: sourceId } });
    if (!source) throw new AppException('RESOURCE_NOT_FOUND');
    return {
      sourceId,
      lastSuccessAt: source.lastSuccessAt?.toISOString() ?? null,
      consecutiveFailures: source.consecutiveFailures,
      structureSuspect: source.structureSuspect,
      structureSuspectBasis: source.structureSuspect ? '条目数量异常下降' : null,
      noDataDays: 0,
    };
  }

  private toView(row: {
    id: string;
    name: string;
    address: string;
    normalizedAddress: string;
    type: string;
    ownerKind: string;
    ownerId: string;
    intervalSeconds: number;
    enabled: boolean;
    verified: boolean;
    lastSuccessAt: Date | null;
    consecutiveFailures: number;
    structureSuspect: boolean;
  }): SourceView {
    return {
      id: row.id,
      name: row.name,
      address: row.address,
      normalizedAddress: row.normalizedAddress,
      type: row.type as SourceView['type'],
      ownerKind: row.ownerKind as 'personal' | 'team',
      ownerId: row.ownerId,
      intervalSeconds: row.intervalSeconds,
      enabled: row.enabled,
      verified: row.verified,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      consecutiveFailures: row.consecutiveFailures,
      structureSuspect: row.structureSuspect,
    };
  }
}