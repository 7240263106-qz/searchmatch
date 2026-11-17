import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { AuthContext } from '@competition/contracts';
import { AuthGuard, CurrentUser, Roles, RolesGuard } from '../platform/auth.module';
import { SignupService } from '../services/signup.service';
import { SourceService } from '../services/source.service';

@Controller()
@UseGuards(AuthGuard, RolesGuard)
export class SignupSourceController {
  constructor(
    private readonly signup: SignupService,
    private readonly sources: SourceService,
  ) {}

  @Post('signup-entries')
  async addEntry(
    @Body()
    body: {
      competitionId: string;
      type?: string;
      url?: string;
      method?: 'web' | 'email' | 'school_unified' | 'offline' | 'to_be_announced';
      note?: string;
      contact?: string;
    },
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.signup.addEntry(body.competitionId, body, user.userId);
  }

  @Post('signup-entries/:entryId/verify')
  async verify(
    @Param('entryId') entryId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.signup.verify(entryId, user.userId);
  }

  @Post('signup-entries/:entryId/trust-domain')
  async trustDomain(
    @Param('entryId') entryId: string,
    @Body() body: { domain?: string },
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.signup.trustDomain(entryId, body?.domain ?? '', user.userId);
  }

  @Get('signup-entries/:entryId/history')
  async history(@Param('entryId') entryId: string): Promise<unknown> {
    return this.signup.history(entryId);
  }

  @Get('signup-entries/:entryId/resolve-redirect')
  async resolveRedirect(@Param('entryId') entryId: string): Promise<unknown> {
    return this.signup.resolveRedirect(entryId);
  }

  @Get('sources')
  async listSources(@CurrentUser() user: AuthContext): Promise<unknown> {
    return this.sources.list(user.userId);
  }

  @Post('sources')
  async createSource(
    @Body()
    body: {
      name: string;
      address: string;
      type?: string;
      ownerKind?: 'personal' | 'team';
      intervalSeconds?: number;
    },
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.sources.create(body, user.userId);
  }

  @Post('sources/:sourceId/probe')
  async probe(
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.sources.probe(sourceId, user.userId);
  }

  @Post('sources/:sourceId/enable')
  async enable(
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.sources.setEnabled(sourceId, true, user.userId);
  }

  @Post('sources/:sourceId/disable')
  async disable(
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.sources.setEnabled(sourceId, false, user.userId);
  }

  @Get('sources/:sourceId/health')
  async health(@Param('sourceId') sourceId: string): Promise<unknown> {
    return this.sources.health(sourceId);
  }
}