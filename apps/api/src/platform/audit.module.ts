import { createHash, randomUUID } from 'node:crypto';
import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from './prisma.module';

@Injectable()
export class AuditService {
  private lastHash: string | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async record(input: {
    actorId: string;
    action: string;
    objectType: string;
    objectId: string;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    const previous =
      this.lastHash ??
      (
        await this.prisma.auditEntry.findFirst({
          orderBy: { createdAt: 'desc' },
          select: { hash: true },
        })
      )?.hash ??
      'GENESIS';
    const canonical = JSON.stringify({
      actorId: input.actorId,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      detail: input.detail ?? null,
      nonce: randomUUID(),
    });
    const hash = createHash('sha256').update(previous + canonical).digest('hex');
    this.lastHash = hash;
    await this.prisma.auditEntry.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        objectType: input.objectType,
        objectId: input.objectId,
        detailJson: JSON.stringify(input.detail ?? {}),
        prevHash: previous,
        hash,
      },
    });
  }

  async list(filter: {
    objectType?: string;
    objectId?: string;
    actorId?: string;
    limit?: number;
  }): Promise<unknown[]> {
    const rows = await this.prisma.auditEntry.findMany({
      where: {
        ...(filter.objectType ? { objectType: filter.objectType } : {}),
        ...(filter.objectId ? { objectId: filter.objectId } : {}),
        ...(filter.actorId ? { actorId: filter.actorId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: filter.limit ?? 100,
    });
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      action: row.action,
      objectType: row.objectType,
      objectId: row.objectId,
      detail: row.detailJson ? JSON.parse(row.detailJson) : null,
      createdAt: row.createdAt.toISOString(),
      hash: row.hash,
    }));
  }
}

@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}