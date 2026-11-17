import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigResolverService } from '../config/config-resolver.service';
import type { AuditService } from './audit.module';
import { AuthGuard } from './auth.module';

function fixture(profile: string, enabled: boolean, headers: Record<string, string> = {}) {
  const values: Record<string, unknown> = {
    'auth.devIdentityEnabled': enabled,
    'auth.devIdentityRole': 'admin',
    'auth.teamId': 'team-demo',
    'auth.deploymentActorId': 'u-demo',
  };
  const resolver = {
    profile: () => profile,
    getBoolean: (key: string) => values[key],
    getString: (key: string) => values[key],
  } as unknown as ConfigResolverService;
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const request: { headers: Record<string, string>; user?: { userId: string; teamId?: string } } = { headers };
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as ExecutionContext;
  const guard = new AuthGuard(resolver, audit as unknown as AuditService);
  return { guard, context, request, audit };
}

describe('受保护部署的工作区身份', () => {
  it('生产部署使用已配置的原工作区归属', () => {
    const test = fixture('prod', false, { 'x-team-id': 'untrusted' });
    expect(test.guard.canActivate(test.context)).toBe(true);
    expect(test.request.user).toMatchObject({ userId: 'u-demo', teamId: 'team-demo' });
  });

  it('生产环境拒绝伪造开发身份', () => {
    const test = fixture('prod', false, { 'x-actor-id': 'attacker' });
    expect(() => test.guard.canActivate(test.context)).toThrow();
    expect(test.audit.record).toHaveBeenCalledOnce();
  });

  it('本机开发仍可切换演示工作区身份', () => {
    const test = fixture('dev', true, { 'x-actor-id': 'editor', 'x-team-id': 'team-local' });
    expect(test.guard.canActivate(test.context)).toBe(true);
    expect(test.request.user).toMatchObject({ userId: 'editor', teamId: 'team-local' });
  });
});
