import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@competition/contracts';
import { AuthGuard, CurrentUser } from '../platform/auth.module';
import { AgentLogService } from '../platform/agent-log.service';
import { AgentService } from '../services/agent.service';
import { CompetitionDiscoveryService } from '../services/competition-discovery.service';

@Controller()
@UseGuards(AuthGuard)
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly discovery: CompetitionDiscoveryService,
    private readonly agentLog: AgentLogService,
  ) {}

  @Post('agent/discover')
  async discover(@Body() body: { name?: string }, @CurrentUser() user: AuthContext): Promise<unknown> {
    return this.agentLog.track('竞赛官网采集', record => this.discovery.discover(body?.name, user.userId, record));
  }

  @Post('agent/discovery-runs')
  startDiscovery(@Body() body: { name?: string; competitionId?: string }, @CurrentUser() user: AuthContext): unknown {
    return this.discovery.startRun(body ?? {}, user.userId, user.roles);
  }

  @Get('agent/discovery-runs/:runId')
  discoveryRun(@Param('runId') runId: string, @CurrentUser() user: AuthContext): unknown {
    return this.discovery.getRun(runId, user.userId);
  }

  @Post('agent/query')
  async query(
    @Body() body: { sessionId?: string; message: string },
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.agentLog.track('智能体对话', () => this.agent.query(body?.sessionId, body?.message ?? '', user.userId));
  }

  @Post('agent/actions/:actionId/confirm')
  async confirm(
    @Param('actionId') actionId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.agentLog.track('智能体操作确认', () => this.agent.confirmAction(actionId, user.userId));
  }

  @Get('agent/sessions/:sessionId')
  async session(
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.agent.session(sessionId, user.userId);
  }
}
