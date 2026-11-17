import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles, RolesGuard } from '../platform/auth.module';
import type { AuthContext } from '@competition/contracts';
import { CrawlerService } from '../services/crawler.service';
import { VerificationService } from '../services/verification.service';
import { SystemService } from '../services/system.service';

@Controller()
@UseGuards(AuthGuard, RolesGuard)
export class CrawlerController {
  constructor(
    private readonly crawler: CrawlerService,
    private readonly verification: VerificationService,
    private readonly system: SystemService,
  ) {}

  @Post('sources/:sourceId/crawl')
  @Roles('reviewer', 'admin')
  async crawlSource(
    @Param('sourceId') sourceId: string,
    @Body() body: { limit?: number },
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.crawler.crawlSource(sourceId, { trigger: 'manual', limit: body?.limit });
  }

  @Get('crawl-tasks')
  async listTasks(@Query('limit') limit?: string): Promise<unknown> {
    return this.crawler.listTasks(limit ? Number(limit) : 30);
  }

  @Get('crawl-tasks/:taskId')
  async taskDetail(@Param('taskId') taskId: string): Promise<unknown> {
    return this.crawler.taskDetail(taskId);
  }

  @Post('verification-batches')
  @Roles('reviewer', 'admin')
  async createBatch(
    @Body() body: { name?: string; clientKey?: string; sourceId: string; entryLimit?: number },
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.verification.createBatch(body, user.userId);
  }

  @Post('verification-batches/:batchId/collect')
  @Roles('reviewer', 'admin')
  async collect(
    @Param('batchId') batchId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.verification.startCollection(batchId, user.userId);
  }

  @Get('verification-batches')
  async listBatches(): Promise<unknown> {
    return this.verification.list();
  }

  @Get('verification-batches/:batchId')
  async batchDetail(@Param('batchId') batchId: string): Promise<unknown> {
    return this.verification.detail(batchId);
  }

  @Post('verification-batches/:batchId/promote')
  @Roles('reviewer', 'admin')
  async promote(
    @Param('batchId') batchId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.verification.promote(batchId, user.userId);
  }

  @Post('verification-batches/:batchId/clear')
  @Roles('reviewer', 'admin')
  async clear(
    @Param('batchId') batchId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.verification.clear(batchId, user.userId);
  }

  @Get('system/empty-state')
  async emptyState(): Promise<unknown> {
    return this.system.emptyState();
  }

  @Get('system/initialization')
  async initialization(): Promise<unknown> {
    return this.system.initialization();
  }

  @Post('system/crawl-toggle')
  @Roles('admin')
  async crawlToggle(
    @Body() body: { enabled: boolean },
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.system.setCrawlEnabled(Boolean(body?.enabled), user.userId);
  }

  @Get('system/onboarding')
  async onboarding(): Promise<unknown> {
    return this.system.initialization();
  }

  @Post('system/onboarding/skip')
  async skipOnboarding(@CurrentUser() user: AuthContext): Promise<unknown> {
    return this.system.skipOnboarding(user.userId);
  }

  @Post('system/onboarding/reset')
  async resetOnboarding(): Promise<unknown> {
    return this.system.resetOnboarding();
  }
}