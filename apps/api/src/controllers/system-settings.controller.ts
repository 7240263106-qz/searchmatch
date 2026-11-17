import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext, ConfigRollbackRequest, ConfigSaveRequest, ConfigTestRequest, ModelSetupRequest } from '@competition/contracts';
import { AuthGuard, CurrentUser } from '../platform/auth.module';
import { AppException } from '../platform/app-exception';
import { ConfigService, type ActorContext } from '../config/config.service';
import { ConfigTestService } from '../config/config-test.service';
import { ConfigResolverService } from '../config/config-resolver.service';
import { ConfigGateService } from '../config/config-gate.service';
import { ClientBootstrapLogService } from '../config/client-bootstrap-log.service';

function toActor(user: AuthContext, request: { ip?: string }): ActorContext {
  return {
    userId: user.userId,
    roles: user.roles,
    teamId: user.teamId ?? 'team-demo',
    sourceAddress: request.ip,
  };
}

function parseVersionHeader(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(/^W\//, '').replace(/"/g, '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

@Controller()
@UseGuards(AuthGuard)
export class SystemSettingsController {
  constructor(
    private readonly configs: ConfigService,
    private readonly tests: ConfigTestService,
    private readonly resolver: ConfigResolverService,
    private readonly gate: ConfigGateService,
    private readonly bootstrapLog: ClientBootstrapLogService,
  ) {}

  @Get('system/client-bootstrap')
  async clientBootstrap(
    @Res() response: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<void> {
    await this.resolver.ready();
    const configVersion = this.resolver.snapshotVersion();
    if (!configVersion) {
      throw new AppException('CONF_CLIENT_BOOTSTRAP_UNAVAILABLE');
    }
    const profile = this.resolver.profile();
    const publicBaseUrl = this.resolver.getString('server.publicBaseUrl', '').replace(/\/$/, '');
    const apiBaseUrl = publicBaseUrl ? `${publicBaseUrl}/api/v1` : '/api/v1';
    const apiBaseSource = publicBaseUrl ? 'configured' : 'same_origin';
    const issuedAt = new Date().toISOString();
    const info = {
      apiBaseUrl,
      apiBaseSource,
      configVersion,
      profile,
      devIdentityAllowed:
        profile !== 'prod' && this.resolver.getBoolean('auth.devIdentityEnabled', true),
      issuedAt,
      cacheMaxAgeSeconds: 60,
      snapshotFingerprint: this.resolver.snapshotFingerprint().slice(0, 12),
    };
    const etag = `"cfg-${configVersion}-${this.resolver.snapshotFingerprint().slice(0, 8)}"`;
    response.setHeader('ETag', etag);
    response.setHeader('Cache-Control', 'private, max-age=60');
    if (ifNoneMatch === etag) {
      response.status(304).end();
      return;
    }
    this.bootstrapLog.record({
      issuedAt,
      apiBaseUrl,
      apiBaseSource,
      configVersion,
      profile,
      cacheMaxAgeSeconds: 60,
      served: true,
    });
    response.status(200).json({ data: info, meta: { asOf: issuedAt } });
  }

  @Get('system/config-gate/last-report')
  async gateReport(
    @CurrentUser() user: AuthContext,
    @Req() request: { ip?: string },
  ): Promise<unknown> {
    this.configs.assertAdmin(toActor(user, request));
    const report = this.gate.read();
    if (!report) throw new AppException('CONF_GATE_REPORT_MISSING');
    return report;
  }

  @Get('system-settings')
  async overview(@CurrentUser() user: AuthContext, @Req() request: { ip?: string }): Promise<unknown> {
    this.configs.assertAdmin(toActor(user, request));
    return this.configs.overview();
  }

  @Get('system-settings/groups/:group')
  async group(
    @Param('group') group: string,
    @CurrentUser() user: AuthContext,
    @Req() request: { ip?: string },
  ): Promise<unknown> {
    this.configs.assertAdmin(toActor(user, request));
    return this.configs.getGroup(group);
  }

  @Put('system-settings/groups/:group')
  async saveGroup(
    @Param('group') group: string,
    @Body() body: ConfigSaveRequest,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AuthContext,
    @Req() request: { ip?: string },
  ): Promise<unknown> {
    return this.configs.saveGroup(
      group,
      body,
      toActor(user, request),
      parseVersionHeader(ifMatch),
      idempotencyKey,
    );
  }

  @Put('system-settings/groups/:group/items/:key')
  async saveItem(
    @Param('group') group: string,
    @Param('key') key: string,
    @Body() body: { baseVersion: number; value: string | number | boolean | string[] | null; confirmToken?: string; reason?: string },
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentUser() user: AuthContext,
    @Req() request: { ip?: string },
  ): Promise<unknown> {
    return this.configs.saveItem(group, key, body, toActor(user, request), parseVersionHeader(ifMatch));
  }

  @Post('system-settings/tests')
  @HttpCode(200)
  async testConnection(
    @Body() body: ConfigTestRequest,
    @CurrentUser() user: AuthContext,
    @Req() request: { ip?: string },
  ): Promise<unknown> {
    const actor = toActor(user, request);
    this.configs.assertAdmin(actor);
    return this.tests.test(body, actor.userId, actor.teamId);
  }

  @Post('system-settings/model-setup')
  @HttpCode(200)
  async setupModel(
    @Body() body: ModelSetupRequest,
    @CurrentUser() user: AuthContext,
    @Req() request: { ip?: string },
  ): Promise<unknown> {
    return this.configs.setupModel(body, toActor(user, request));
  }

  @Put('system-settings/credentials/:secretRefId')
  async writeCredential(
    @Param('secretRefId') secretRefId: string,
    @Body() body: { plaintext: string; purpose?: string },
    @CurrentUser() user: AuthContext,
    @Req() request: { ip?: string },
  ): Promise<unknown> {
    return this.configs.writeCredential(
      secretRefId === 'new' ? null : secretRefId,
      body,
      toActor(user, request),
    );
  }

  @Delete('system-settings/credentials/:secretRefId')
  async revokeCredential(
    @Param('secretRefId') secretRefId: string,
    @CurrentUser() user: AuthContext,
    @Req() request: { ip?: string },
  ): Promise<unknown> {
    return this.configs.revokeCredential(secretRefId, toActor(user, request));
  }

  @Get('system-settings/versions')
  async versions(
    @Query('group') group: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentUser() user: AuthContext,
    @Req() request: { ip?: string },
  ): Promise<unknown> {
    this.configs.assertAdmin(toActor(user, request));
    const parsed = limit ? Number(limit) : 20;
    return this.configs.versions(group, Number.isFinite(parsed) ? parsed : 20);
  }

  @Get('system-settings/versions/:version')
  async versionDetail(
    @Param('version') version: string,
    @CurrentUser() user: AuthContext,
    @Req() request: { ip?: string },
  ): Promise<unknown> {
    this.configs.assertAdmin(toActor(user, request));
    return this.configs.versionDetail(Number(version));
  }

  @Get('system-settings/versions/:version/diff')
  async diff(
    @Param('version') version: string,
    @Query('against') against: string | undefined,
    @CurrentUser() user: AuthContext,
    @Req() request: { ip?: string },
  ): Promise<unknown> {
    this.configs.assertAdmin(toActor(user, request));
    return this.configs.diff(Number(version), against ? Number(against) : undefined);
  }

  @Post('system-settings/rollback')
  @HttpCode(200)
  async rollback(
    @Body() body: ConfigRollbackRequest,
    @CurrentUser() user: AuthContext,
    @Req() request: { ip?: string },
  ): Promise<unknown> {
    return this.configs.rollback(body, toActor(user, request));
  }

  @Get('system-settings/readiness')
  async readiness(@CurrentUser() user: AuthContext, @Req() request: { ip?: string }): Promise<unknown> {
    this.configs.assertAdmin(toActor(user, request));
    return this.configs.readinessView();
  }

  @Post(['system-settings/readiness/recompute', 'system-settings/readiness:recompute'])
  @HttpCode(200)
  async recompute(@CurrentUser() user: AuthContext, @Req() request: { ip?: string }): Promise<unknown> {
    this.configs.assertAdmin(toActor(user, request));
    return this.configs.recomputeReadiness();
  }

  @Get('system/configuration-health')
  async configurationHealth(
    @CurrentUser() user: AuthContext,
    @Req() request: { ip?: string },
  ): Promise<unknown> {
    this.configs.assertAdmin(toActor(user, request));
    return this.configs.configurationHealth();
  }
}
