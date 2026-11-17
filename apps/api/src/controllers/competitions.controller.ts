import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { AuthContext, DiscoverySelection, SearchQuery } from '@competition/contracts';
import { AuthGuard, CurrentUser, Roles, RolesGuard } from '../platform/auth.module';
import { AgentLogService } from '../platform/agent-log.service';
import { CompetitionService } from '../services/competition.service';
import { CompetitionDiscoveryService } from '../services/competition-discovery.service';

@Controller()
@UseGuards(AuthGuard, RolesGuard)
export class CompetitionsController {
  constructor(
    private readonly competitions: CompetitionService,
    private readonly discovery: CompetitionDiscoveryService,
    private readonly agentLog: AgentLogService,
  ) {}

  @Post('competitions/:competitionId/discover')
  async discover(@Param('competitionId') id: string, @CurrentUser() user: AuthContext): Promise<unknown> {
    return this.agentLog.track('竞赛库采集', record => this.discovery.discoverForCompetition(id, user.userId, record, user.roles));
  }

  @Post('competitions/:competitionId/discovery-fields')
  @Roles('editor', 'reviewer', 'admin')
  async saveDiscoveryFields(
    @Param('competitionId') id: string,
    @Body() input: DiscoverySelection,
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    const { page, version } = this.discovery.selectedFields(id, user.userId, input);
    const detail = await this.competitions.saveDiscoveryFields(id, version, page, user.userId, user.roles);
    this.discovery.advanceSelectionVersion(input.runId, version);
    return detail;
  }

  @Post('search/competitions')
  async search(
    @Body() query: SearchQuery,
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.competitions.search(query ?? {}, user.userId, user.roles);
  }

  @Get('search/facets')
  async facets(@CurrentUser() user: AuthContext): Promise<unknown> {
    const result = await this.competitions.search({ limit: 100 }, user.userId);
    return result.facets;
  }

  @Get('competitions')
  async list(@Query('limit') limit?: string): Promise<unknown> {
    return this.competitions.listPublished(limit ? Number(limit) : 50);
  }

  @Get('competitions/my-drafts')
  async myDrafts(
    @CurrentUser() user: AuthContext,
    @Query('documentId') documentId?: string,
    @Query('page') page?: string,
  ): Promise<unknown> {
    return this.competitions.listMyDrafts(user.userId, documentId, page ? Number(page) : 1);
  }

  @Get('competitions/:competitionId')
  async detail(
    @Param('competitionId') competitionId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.competitions.detail(competitionId, user.userId);
  }

  @Get('competitions/:competitionId/change-events')
  async changeEvents(
    @Param('competitionId') competitionId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    const detail = await this.competitions.detail(competitionId, user.userId);
    return detail.changeEvents;
  }

  @Get('competitions/:competitionId/versions')
  async versions(@Param('competitionId') competitionId: string): Promise<unknown> {
    return this.competitions.versions(competitionId);
  }

  @Get('reviews/queue')
  @Roles('reviewer', 'admin')
  async reviewQueue(): Promise<unknown> {
    return this.competitions.reviewQueue();
  }

  @Post('competitions/:competitionId/submit-review')
  async submitReview(
    @Param('competitionId') competitionId: string,
    @Body() body: { comment?: string },
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.competitions.submitReview(competitionId, user.userId, body?.comment);
  }

  @Post('competitions/:competitionId/publish')
  @Roles('reviewer', 'admin')
  async publish(
    @Param('competitionId') competitionId: string,
    @Body() body: { comment?: string },
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.competitions.publish(competitionId, user.userId, body?.comment);
  }

  @Post('competitions/:competitionId/reject')
  @Roles('reviewer', 'admin')
  async reject(
    @Param('competitionId') competitionId: string,
    @Body() body: { comment?: string },
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.competitions.reject(competitionId, user.userId, body?.comment ?? '');
  }

  @Post('competitions/:competitionId/unpublish')
  @Roles('reviewer', 'admin')
  async unpublish(
    @Param('competitionId') competitionId: string,
    @Body() body: { comment?: string },
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.competitions.unpublish(competitionId, user.userId, body?.comment ?? '');
  }

  @Post('competitions/:competitionId/restore')
  @Roles('reviewer', 'admin')
  async restore(
    @Param('competitionId') competitionId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.competitions.restore(competitionId, user.userId);
  }

  @Post('competitions/:competitionId/favorite')
  async favorite(
    @Param('competitionId') competitionId: string,
    @Body() body: { favorite?: boolean },
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.competitions.favorite(competitionId, user.userId, body?.favorite !== false);
  }
}
