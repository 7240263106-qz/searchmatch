import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../platform/prisma.module';
import { AuditService } from '../platform/audit.module';
import { AppException } from '../platform/app-exception';
import { CrawlerService } from './crawler.service';

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crawler: CrawlerService,
  ) {}

  async createBatch(
    input: { name?: string; clientKey?: string; sourceId: string; entryLimit?: number },
    actorId: string,
  ): Promise<unknown> {
    const source = await this.prisma.sourceDefinition.findUnique({ where: { id: input.sourceId } });
    if (!source) throw new AppException('RESOURCE_NOT_FOUND', { reason: 'source_not_found' });
    if (!/lanqiao|蓝桥杯/i.test(source.address + source.name)) {
      throw new AppException('VALIDATION_FAILED', { reason: 'verification_subject_mismatch' }, '验证批次仅支持蓝桥杯官方源');
    }

    const active = await this.prisma.verificationBatch.findFirst({
      where: { status: { in: ['created', 'collecting', 'verifying'] } },
    });
    if (active) {
      throw new AppException('STATE_TRANSITION_INVALID', { reason: 'active_batch_exists', batchId: active.id });
    }

    const batch = await this.prisma.verificationBatch.create({
      data: {
        name: input.name || '蓝桥杯真实采集验证',
        subject: 'lanqiao_official_series',
        clientKey: input.clientKey ?? null,
        sourceId: input.sourceId,
        entryLimit: input.entryLimit ?? 12,
        createdBy: actorId,
      },
    });

    await this.audit.record({
      actorId,
      action: 'verification.create',
      objectType: 'verification_batch',
      objectId: batch.id,
      detail: { sourceId: input.sourceId },
    });

    return this.detail(batch.id);
  }

  async startCollection(batchId: string, actorId: string): Promise<unknown> {
    const batch = await this.prisma.verificationBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new AppException('RESOURCE_NOT_FOUND');
    if (!batch.sourceId) throw new AppException('VALIDATION_FAILED', { reason: 'source_missing' });
    if (!['created', 'failed'].includes(batch.status)) {
      throw new AppException('STATE_TRANSITION_INVALID', { from: batch.status, to: 'collecting' });
    }

    await this.prisma.verificationBatch.update({
      where: { id: batchId },
      data: { status: 'collecting', startedAt: new Date() },
    });

    try {
      const report = await this.crawler.crawlSource(batch.sourceId, {
        trigger: 'verification',
        batchId,
        limit: batch.entryLimit,
      });

      const status = report.status === 'succeeded' ? 'verifying' : 'failed';
      await this.prisma.verificationBatch.update({
        where: { id: batchId },
        data: {
          status,
          finishedAt: new Date(),
          reportJson: JSON.stringify(report),
        },
      });

      await this.audit.record({
        actorId,
        action: 'verification.collect',
        objectType: 'verification_batch',
        objectId: batchId,
        detail: { status, counters: report.counters },
      });

      return this.detail(batchId);
    } catch (error) {
      await this.prisma.verificationBatch.update({
        where: { id: batchId },
        data: { status: 'failed', finishedAt: new Date(), reportJson: JSON.stringify({ error: (error as Error).message }) },
      });
      throw error;
    }
  }

  async list(): Promise<unknown[]> {
    const rows = await this.prisma.verificationBatch.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return Promise.all(rows.map((row) => this.summary(row.id)));
  }

  async detail(batchId: string): Promise<unknown> {
    const batch = await this.prisma.verificationBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new AppException('RESOURCE_NOT_FOUND');

    const [competitions, candidates, snapshots, attachments] = await Promise.all([
      this.prisma.competition.findMany({
        where: { verificationBatchId: batchId, deletedAt: null },
        select: {
          id: true,
          name: true,
          category: true,
          level: true,
          publishStatus: true,
          completeness: true,
          credibility: true,
          registrationStatus: true,
          nearestDeadline: true,
          dataOrigin: true,
          trackId: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.candidate.count({ where: { batchId } }),
      this.prisma.rawPageSnapshot.count({ where: { batchId } }),
      this.prisma.crawlAttachment.count({ where: { batchId } }),
    ]);

    return {
      id: batch.id,
      name: batch.name,
      subject: batch.subject,
      status: batch.status,
      dataOrigin: batch.dataOrigin,
      sourceId: batch.sourceId,
      entryLimit: batch.entryLimit,
      report: JSON.parse(batch.reportJson),
      counts: {
        competitions: competitions.length,
        candidates,
        snapshots,
        attachments,
        promoted: competitions.filter((item) => item.dataOrigin === 'formal').length,
      },
      competitions: competitions.map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        level: item.level,
        publishStatus: item.publishStatus,
        completeness: item.completeness,
        credibility: item.credibility,
        registrationStatus: item.registrationStatus,
        nearestDeadline: item.nearestDeadline?.toISOString() ?? null,
        dataOrigin: item.dataOrigin,
        trackId: item.trackId,
      })),
      startedAt: batch.startedAt?.toISOString() ?? null,
      finishedAt: batch.finishedAt?.toISOString() ?? null,
      promotedAt: batch.promotedAt?.toISOString() ?? null,
      clearedAt: batch.clearedAt?.toISOString() ?? null,
      createdAt: batch.createdAt.toISOString(),
    };
  }

  async promote(batchId: string, actorId: string): Promise<unknown> {
    const batch = await this.prisma.verificationBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new AppException('RESOURCE_NOT_FOUND');
    if (batch.status !== 'verifying') {
      throw new AppException('STATE_TRANSITION_INVALID', { from: batch.status, to: 'promoted' });
    }

    const competitions = await this.prisma.competition.findMany({
      where: { verificationBatchId: batchId, deletedAt: null },
    });
    if (competitions.length === 0) {
      throw new AppException('VALIDATION_FAILED', { reason: 'empty_batch' }, '批次内没有可转正式的竞赛');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.competition.updateMany({
        where: { verificationBatchId: batchId, deletedAt: null },
        data: { dataOrigin: 'formal' },
      });
      await tx.verificationBatch.update({
        where: { id: batchId },
        data: { status: 'promoted', promotedAt: new Date() },
      });
    });

    await this.audit.record({
      actorId,
      action: 'verification.promote',
      objectType: 'verification_batch',
      objectId: batchId,
      detail: { count: competitions.length },
    });

    return this.detail(batchId);
  }

  async clear(batchId: string, actorId: string): Promise<unknown> {
    const batch = await this.prisma.verificationBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new AppException('RESOURCE_NOT_FOUND');
    if (batch.status === 'cleared') {
      return this.detail(batchId);
    }

    const competitions = await this.prisma.competition.findMany({
      where: { verificationBatchId: batchId },
      select: { id: true },
    });
    const ids = competitions.map((item) => item.id);

    await this.prisma.$transaction(async (tx) => {
      if (ids.length > 0) {
        await tx.changeEvent.deleteMany({ where: { competitionId: { in: ids } } });
        await tx.competitionVersion.deleteMany({ where: { competitionId: { in: ids } } });
        await tx.reviewRecord.deleteMany({ where: { competitionId: { in: ids } } });
        await tx.fieldEvidence.deleteMany({ where: { competitionId: { in: ids } } });
        await tx.documentCompetitionLink.deleteMany({ where: { competitionId: { in: ids } } });
        await tx.sourceMaterial.deleteMany({ where: { competitionId: { in: ids } } });
        await tx.signupEntry.deleteMany({ where: { competitionId: { in: ids } } });
        await tx.registrationStage.deleteMany({ where: { competitionId: { in: ids } } });
        await tx.competitionOrganizer.deleteMany({ where: { competitionId: { in: ids } } });
        await tx.favorite.deleteMany({ where: { competitionId: { in: ids } } });
        await tx.competition.deleteMany({ where: { id: { in: ids } } });
      }
      await tx.crawlAttachment.deleteMany({ where: { batchId } });
      await tx.rawPageSnapshot.deleteMany({ where: { batchId } });
      await tx.requestEvidence.deleteMany({ where: { batchId } });
      await tx.candidate.deleteMany({ where: { batchId } });
      await tx.crawlTask.deleteMany({ where: { batchId } });
      await tx.verificationBatch.update({
        where: { id: batchId },
        data: { status: 'cleared', clearedAt: new Date() },
      });
    });

    await this.audit.record({
      actorId,
      action: 'verification.clear',
      objectType: 'verification_batch',
      objectId: batchId,
      detail: { removed: ids.length },
    });

    return this.detail(batchId);
  }

  private async summary(batchId: string): Promise<unknown> {
    const detail = (await this.detail(batchId)) as {
      id: string;
      name: string;
      status: string;
      counts: unknown;
      createdAt: string;
    };
    return {
      id: detail.id,
      name: detail.name,
      status: detail.status,
      counts: detail.counts,
      createdAt: detail.createdAt,
    };
  }
}