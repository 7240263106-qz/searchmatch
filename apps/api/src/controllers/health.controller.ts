import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../platform/prisma.module';
import { ConfigResolverService } from '../config/config-resolver.service';

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: ConfigResolverService,
  ) {}

  @Get('healthz')
  health(): { status: string } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async ready(): Promise<{
    status: string;
    dependencies: Record<string, string>;
    configuration: { version: number; profile: string; applyStates: string[]; pendingRestart: number };
  }> {
    const dependencies: Record<string, string> = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      dependencies.database = 'ready';
    } catch {
      dependencies.database = 'down';
    }
    const parserUrl = this.resolver.getString('parser.baseUrl', '');
    if (parserUrl) {
      const healthPath = this.resolver.getString('parser.healthPath', '/healthz');
      try {
        const response = await fetch(`${parserUrl.replace(/\/$/, '')}${healthPath}`, {
          signal: AbortSignal.timeout(1500),
        });
        dependencies.parser = response.ok ? 'ready' : 'degraded';
      } catch {
        dependencies.parser = 'degraded';
      }
    } else {
      dependencies.parser = 'degraded';
    }
    const applyStates = [...new Set(this.resolver.entries().map((entry) => entry.applyState))];
    return {
      status: dependencies.database === 'ready' ? 'ok' : 'degraded',
      dependencies,
      configuration: {
        version: this.resolver.snapshotVersion(),
        profile: this.resolver.profile(),
        applyStates,
        pendingRestart: this.resolver.pendingRestartKeys().length,
      },
    };
  }
}