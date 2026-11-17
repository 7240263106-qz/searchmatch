import { Injectable } from '@nestjs/common';
import { PrismaService } from '../platform/prisma.module';
import { AuditService } from '../platform/audit.module';
import { AppException } from '../platform/app-exception';
import { ConfigResolverService } from '../config/config-resolver.service';
import { ConfigService } from '../config/config.service';
import { ReadinessService } from '../config/readiness.service';

@Injectable()
export class SystemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly resolver: ConfigResolverService,
    private readonly configs: ConfigService,
    private readonly readiness: ReadinessService,
  ) {}

  async emptyState(): Promise<unknown> {
    const readiness = await this.readiness.current();
    const [published, formalDrafts, sources, batches, tasks, onboarding] = await Promise.all([
      this.prisma.competition.count({
        where: { publishStatus: 'published', dataOrigin: 'formal', demoFlag: false, deletedAt: null },
      }),
      this.prisma.competition.count({
        where: { publishStatus: { in: ['draft', 'pending_review'] }, dataOrigin: 'formal', demoFlag: false, deletedAt: null },
      }),
      this.prisma.sourceDefinition.count(),
      this.prisma.verificationBatch.count({ where: { status: { in: ['created', 'collecting', 'verifying'] } } }),
      this.prisma.crawlTask.count(),
      this.prisma.onboardingState.findFirst(),
    ]);

    const crawlEnabled = this.resolver.getBoolean('crawl.enabled', onboarding?.crawlEnabled ?? false);
    let reason = 'empty';
    let guidance = '配置信息源并启动首次采集';
    let actions: Array<{ action: string; label: string; path: string }> = [
      { action: 'open_sources', label: '配置信息源', path: '/sources' },
    ];
    if (readiness.overall === 'not_ready' && published === 0 && formalDrafts === 0) {
      reason = 'system_config_not_ready';
      guidance = '系统运行配置未就绪，请先完成系统设置';
      actions = [
        { action: 'open_system_settings', label: '前往系统设置', path: '/settings' },
        { action: 'open_sources', label: '配置信息源', path: '/sources' },
      ];
    } else if (sources === 0) {
      reason = 'no_source';
      guidance = '先添加官方网站或 RSS 信息源';
    } else if (batches > 0 && published === 0) {
      reason = 'verification_only';
      guidance = '当前仅有验证批次数据，可在验证管理中查看并转正式';
    } else if (formalDrafts > 0 && published === 0) {
      reason = 'unpublished_only';
      guidance = '已有草稿或待审核数据，请前往审核工作台';
    } else if (sources > 0 && tasks === 0) {
      reason = 'never_crawled';
      guidance = '信息源已配置，可手动启动一次真实采集';
    } else if (published > 0) {
      reason = 'has_data';
      guidance = '';
      actions = [];
    }

    return {
      empty: published === 0 && formalDrafts === 0,
      reason,
      guidance,
      actions,
      readiness: { overall: readiness.overall },
      counts: {
        published,
        formalDrafts,
        sources,
        activeBatches: batches,
        crawlTasks: tasks,
      },
      crawlEnabled,
      asOf: new Date().toISOString(),
    };
  }

  async initialization(): Promise<unknown> {
    const empty = await this.emptyState();
    const onboarding = await this.prisma.onboardingState.findFirst();
    return {
      empty,
      onboarding: onboarding
        ? {
            currentStep: onboarding.currentStep,
            completed: JSON.parse(onboarding.completedJson),
            skipped: onboarding.skipped,
          }
        : { currentStep: 'source', completed: [], skipped: false },
    };
  }

  async setCrawlEnabled(enabled: boolean, actorId: string): Promise<unknown> {
    if (enabled) {
      const readiness = await this.readiness.current();
      if (readiness.overall === 'not_ready') {
        const failing = readiness.items
          .filter((item) => item.required && item.state === 'not_ready')
          .map((item) => item.key);
        throw new AppException('CRAWL_PRECHECK_FAILED', { failing });
      }
      const source = await this.prisma.sourceDefinition.findFirst({
        where: { enabled: true, verified: true },
      });
      if (!source) {
        throw new AppException('CRAWL_PRECHECK_FAILED', {
          failing: ['source'],
          message: '至少需要一个探测通过且已启用的信息源才能开启采集',
        });
      }
    }

    const baseVersion = this.resolver.snapshotVersion();
    const result = await this.configs.saveItem(
      'crawl_runtime',
      'crawl.enabled',
      {
        baseVersion,
        value: enabled,
        reason: enabled ? '开启采集总开关' : '关闭采集总开关',
      },
      {
        userId: actorId,
        roles: ['admin'],
        teamId: this.resolver.getString('auth.teamId', 'team-demo'),
      },
      baseVersion,
    );

    await this.prisma.onboardingState.upsert({
      where: { ownerId: 'system' },
      create: { ownerId: 'system', crawlEnabled: enabled },
      update: { crawlEnabled: enabled },
    });

    return {
      enabled,
      configVersion: result.version,
      applyState: result.applyState,
      pendingRestartKeys: result.pendingRestartKeys,
    };
  }

  async skipOnboarding(actorId: string): Promise<unknown> {
    const state = await this.prisma.onboardingState.upsert({
      where: { ownerId: 'system' },
      create: { ownerId: 'system', skipped: true, currentStep: 'done' },
      update: { skipped: true, currentStep: 'done' },
    });
    await this.audit.record({
      actorId,
      action: 'system.onboarding_skipped',
      objectType: 'system',
      objectId: 'onboarding',
    });
    return { skipped: state.skipped };
  }

  async resetOnboarding(): Promise<unknown> {
    const state = await this.prisma.onboardingState.upsert({
      where: { ownerId: 'system' },
      create: { ownerId: 'system' },
      update: { skipped: false, currentStep: 'source', completedJson: '[]' },
    });
    return { skipped: state.skipped, currentStep: state.currentStep };
  }
}