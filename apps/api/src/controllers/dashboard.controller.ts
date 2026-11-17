import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../platform/auth.module';
import { DashboardService } from '../services/dashboard.service';

@Controller()
@UseGuards(AuthGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard/overview')
  async overview(
    @Query('range') range?: '7d' | '30d' | '90d',
    @Query('metricBasis') basis?: 'discovered' | 'ingested' | 'published',
  ): Promise<unknown> {
    return this.dashboard.overview(range ?? '7d', basis ?? 'published');
  }

  @Get('dashboard/deadlines')
  async deadlines(@Query('days') days?: string): Promise<unknown> {
    return this.dashboard.deadlines(days ? Number(days) : 7);
  }

  @Get('reports/quality')
  async quality(): Promise<unknown> {
    return this.dashboard.qualityReport();
  }
}