import { Injectable } from '@nestjs/common';
import type { Bucket, DashboardOverview, DeadlineItem } from '@competition/contracts';
import { PrismaService } from '../platform/prisma.module';
import { remainingDays } from '../domain/time';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(range: '7d' | '30d' | '90d' = '7d', basis: 'discovered' | 'ingested' | 'published' = 'published'): Promise<DashboardOverview> {
    const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [published, pendingReview, draft, closingSoon, publishedRows, pendingRows, entries] =
      await Promise.all([
        this.prisma.competition.count({ where: { publishStatus: 'published', dataOrigin: 'formal', demoFlag: false, deletedAt: null } }),
        this.prisma.competition.count({ where: { publishStatus: 'pending_review', dataOrigin: 'formal', demoFlag: false, deletedAt: null } }),
        this.prisma.competition.count({ where: { publishStatus: 'draft', dataOrigin: 'formal', demoFlag: false, deletedAt: null } }),
        this.prisma.competition.count({
          where: { publishStatus: 'published', dataOrigin: 'formal', demoFlag: false, registrationStatus: 'closing_soon', deletedAt: null },
        }),
        this.prisma.competition.findMany({
          where: { publishStatus: 'published', dataOrigin: 'formal', demoFlag: false, deletedAt: null },
          select: {
            category: true,
            level: true,
            credibility: true,
            completeness: true,
            createdAt: true,
            publishedAt: true,
            registrationStatus: true,
          },
        }),
        this.prisma.competition.findMany({
          where: { publishStatus: 'pending_review', dataOrigin: 'formal', demoFlag: false, deletedAt: null },
          select: { updatedAt: true },
          orderBy: { updatedAt: 'asc' },
          take: 1,
        }),
        this.prisma.signupEntry.findMany({ select: { status: true } }),
      ]);

    const trendPoints: Array<{ date: string; count: number }> = [];
    for (let index = days - 1; index >= 0; index -= 1) {
      const day = new Date(Date.now() - index * 24 * 60 * 60 * 1000);
      const key = day.toISOString().slice(0, 10);
      const count = publishedRows.filter((row) => {
        const source =
          basis === 'published' ? row.publishedAt : row.createdAt;
        return source ? source.toISOString().slice(0, 10) === key : false;
      }).length;
      trendPoints.push({ date: key, count });
    }

    const completenessRate = publishedRows.length
      ? Math.round(
          (publishedRows.filter((row) => row.completeness === 'complete').length /
            publishedRows.length) *
            100,
        )
      : 0;
    const credibilityHighRate = publishedRows.length
      ? Math.round(
          (publishedRows.filter((row) => row.credibility === 'high').length /
            publishedRows.length) *
            100,
        )
      : 0;
    const available = entries.filter((entry) => entry.status === 'accessible').length;
    const siteAvailabilityRate = entries.length ? Math.round((available / entries.length) * 100) : 0;
    const pendingReviewOldestHours = pendingRows[0]
      ? Math.round((Date.now() - pendingRows[0].updatedAt.getTime()) / (60 * 60 * 1000))
      : 0;

    return {
      asOf: new Date().toISOString(),
      totals: { published, pendingReview, draft, closingSoon },
      distributions: {
        category: this.bucket(publishedRows.map((row) => row.category ?? '未分类')),
        level: this.bucket(publishedRows.map((row) => row.level ?? '未分级')),
        credibility: this.bucket(publishedRows.map((row) => row.credibility)),
      },
      trend: { basis, points: trendPoints },
      quality: {
        completenessRate,
        credibilityHighRate,
        siteAvailabilityRate,
        pendingReviewOldestHours,
      },
      definitions: {
        published: { definition: '发布状态为已发布的竞赛数量', scope: '不含草稿、待审核与已下架' },
        pendingReview: { definition: '发布状态为待审核的竞赛数量', scope: '全部可见范围' },
        closingSoon: { definition: '最近未完成报名阶段在 7 天内截止的已发布竞赛', scope: '仅已发布' },
        completenessRate: { definition: '信息完整性为“完整”的已发布竞赛占比', scope: '仅已发布' },
        siteAvailabilityRate: { definition: '最近一次校验为“可访问”的报名入口占比', scope: '全部报名入口' },
        trend: {
          definition:
            basis === 'published'
              ? '按正式发布时间统计'
              : basis === 'discovered'
                ? '按首次入库时间统计'
                : '按入库时间统计',
          scope: `近 ${days} 天`,
        },
      },
    };
  }

  async deadlines(days = 7): Promise<DeadlineItem[]> {
    const now = new Date();
    const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.competition.findMany({
      where: {
        publishStatus: 'published',
        dataOrigin: 'formal',
        demoFlag: false,
        deletedAt: null,
        nearestDeadline: { gte: now, lte: until },
      },
      orderBy: { nearestDeadline: 'asc' },
      include: { stages: true },
      take: 20,
    });

    return rows.map((row) => {
      const nearest = row.stages
        .filter((stage) => stage.endAt)
        .sort((a, b) => (a.endAt?.getTime() ?? 0) - (b.endAt?.getTime() ?? 0))[0];
      const deadline = row.nearestDeadline?.toISOString() ?? null;
      const missing: string[] = [];
      if (row.completeness !== 'complete') missing.push('部分字段缺失');
      if (!row.level) missing.push('竞赛级别');
      return {
        competitionId: row.id,
        name: row.name,
        stageName: nearest?.name ?? '报名阶段',
        deadline: {
          at: deadline,
          precision: (nearest?.endPrecision as 'day' | 'second' | 'unknown') ?? 'day',
          timezone: nearest?.endTimezone ?? 'Asia/Shanghai',
          rawText: nearest?.endRawText ?? null,
        },
        remainingDays: deadline
          ? remainingDays(
              {
                at: deadline,
                precision: (nearest?.endPrecision as 'day' | 'second' | 'unknown') ?? 'day',
                timezone: nearest?.endTimezone ?? 'Asia/Shanghai',
                rawText: nearest?.endRawText ?? null,
              },
              now,
            )
          : -1,
        registrationStatus: row.registrationStatus as DeadlineItem['registrationStatus'],
        siteStatus: row.siteStatus as DeadlineItem['siteStatus'],
        missingFields: missing,
      };
    });
  }

  async qualityReport(): Promise<unknown> {
    const [published, parsed, failed, reviews, entries, sources] = await Promise.all([
      this.prisma.competition.count({ where: { publishStatus: 'published', dataOrigin: 'formal', demoFlag: false, deletedAt: null } }),
      this.prisma.parseTask.count({ where: { status: 'succeeded' } }),
      this.prisma.parseTask.count({ where: { status: 'failed' } }),
      this.prisma.competition.count({ where: { publishStatus: 'pending_review', dataOrigin: 'formal', demoFlag: false, deletedAt: null } }),
      this.prisma.signupEntry.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.sourceDefinition.count(),
    ]);
    return {
      asOf: new Date().toISOString(),
      metrics: [
        { key: 'published', label: '已发布竞赛', value: published, formula: '发布状态=已发布', cycle: '实时' },
        { key: 'parse_success', label: '解析成功任务', value: parsed, formula: '解析状态=成功', cycle: '实时' },
        { key: 'parse_fail', label: '解析失败任务', value: failed, formula: '解析状态=失败', cycle: '实时' },
        { key: 'review_backlog', label: '审核积压', value: reviews, formula: '发布状态=待审核', cycle: '小时' },
        { key: 'sources', label: '信息源数量', value: sources, formula: '全部未删除信息源', cycle: '实时' },
      ],
      siteStatus: entries.map((entry) => ({ key: entry.status, count: entry._count._all })),
    };
  }

  private bucket(values: string[]): Bucket[] {
    const map = new Map<string, number>();
    for (const value of values) {
      map.set(value, (map.get(value) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([key, count]) => ({ key, label: key, count }))
      .sort((a, b) => b.count - a.count);
  }
}