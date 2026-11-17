import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Global,
  Injectable,
  Module,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthContext } from '@competition/contracts';
import { ConfigModule } from '../config/config.module';
import { ConfigResolverService } from '../config/config-resolver.service';
import { AuditService } from './audit.module';
import { AppException } from './app-exception';

export const ROLES_KEY = 'competition:roles';
export const Roles = (...roles: string[]): MethodDecorator => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthContext }>();
    return request.user;
  },
);

function decodeHeaderValue(value: string | undefined): string | undefined {
  if (!value) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly resolver: ConfigResolverService,
    private readonly audit: AuditService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: AuthContext;
    }>();
    const header = (name: string): string | undefined => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };

    const profile = this.resolver.profile();
    const requestedRoleHeader = decodeHeaderValue(header('x-actor-roles'));
    if (profile === 'prod' && (requestedRoleHeader || header('x-actor-id'))) {
      void this.audit.record({
        actorId: decodeHeaderValue(header('x-actor-id')) ?? 'unknown',
        action: 'security.dev_identity_forbidden',
        objectType: 'system_config',
        objectId: 'auth.devIdentityEnabled',
        detail: { profile, reason: '生产环境禁止请求头模拟身份' },
      });
      throw new AppException('CONF_DEV_IDENTITY_FORBIDDEN');
    }

    const devIdentityEnabled = this.resolver.getBoolean(
      'auth.devIdentityEnabled',
      profile !== 'prod',
    );
    const configuredRole = this.resolver.getString('auth.devIdentityRole', 'viewer');
    const configuredTeam = this.resolver.getString('auth.teamId', 'team-demo');
    const roles = devIdentityEnabled
      ? (requestedRoleHeader ?? configuredRole)
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [configuredRole];

    request.user = {
      userId: (devIdentityEnabled ? decodeHeaderValue(header('x-actor-id')) : undefined)
        ?? this.resolver.getString('auth.deploymentActorId', 'u-dev'),
      displayName: (devIdentityEnabled ? decodeHeaderValue(header('x-actor-name')) : undefined)
        ?? (profile === 'prod' ? '管理用户' : '开发环境用户'),
      roles,
      teamId: (devIdentityEnabled ? decodeHeaderValue(header('x-team-id')) : undefined) ?? configuredTeam,
    };
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const request = context.switchToHttp().getRequest<{ user?: AuthContext }>();
    const roles = request.user?.roles ?? [];
    return required.some((role) => roles.includes(role));
  }
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [AuthGuard, RolesGuard, Reflector],
  exports: [AuthGuard, RolesGuard, Reflector],
})
export class AuthModule {}
