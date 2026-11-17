import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '@competition/contracts';
import { AuthGuard, CurrentUser } from '../platform/auth.module';
import { AuditService } from '../platform/audit.module';
import { CompetitionService } from '../services/competition.service';
import { PrismaService } from '../platform/prisma.module';

@Controller()
@UseGuards(AuthGuard)
export class MiscController {
  constructor(
    private readonly audit: AuditService,
    private readonly competitions: CompetitionService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('audit-logs')
  async auditLogs(
    @Query('objectType') objectType?: string,
    @Query('objectId') objectId?: string,
    @Query('actorId') actorId?: string,
  ): Promise<unknown> {
    return this.audit.list({ objectType, objectId, actorId, limit: 100 });
  }

  @Get('tasks')
  async tasks(@Query('status') status?: string): Promise<unknown> {
    const rows = await this.prisma.parseTask.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { document: true },
    });
    return rows.map((row) => ({
      id: row.id,
      type: 'parse',
      documentId: row.documentId,
      documentName: row.document.fileName,
      status: row.status,
      stage: row.stage,
      progress: row.progress,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  @Get('subscriptions')
  async subscriptions(): Promise<unknown> {
    const rows = await this.prisma.subscriptionRule.findMany({ take: 50 });
    return {
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        frequency: row.frequency,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: { featurePhase: 2 },
    };
  }

  @Get('push-records')
  async pushRecords(): Promise<unknown> {
    const rows = await this.prisma.pushBatch.findMany({ take: 50, include: { items: true } });
    return {
      data: rows.map((row) => ({
        id: row.id,
        batchNo: row.batchNo,
        channel: row.channel,
        status: row.status,
        itemCount: row.items.length,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: { featurePhase: 2 },
    };
  }

  @Get('reminders')
  async reminders(): Promise<unknown> {
    return { data: [], meta: { featurePhase: 2 } };
  }

  @Get('exports/competitions')
  async export(
    @CurrentUser() user: AuthContext,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.competitions.search({ limit: 100 }, user.userId);
    const header = ['竞赛名称', '学科', '级别', '报名状态', '可信度', '最近截止'];
    const lines = [header.join(',')];
    for (const item of result.items) {
      lines.push(
        [
          `"${item.name.replace(/"/g, '""')}"`,
          item.category ?? '',
          item.level ?? '',
          item.registrationStatus,
          item.credibility,
          item.nearestDeadline?.at ?? '',
        ].join(','),
      );
    }
    const csv = `\uFEFF${lines.join('\r\n')}`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''competitions.csv");
    res.send(Buffer.from(csv, 'utf8'));
  }
}