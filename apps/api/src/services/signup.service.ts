import { Injectable } from '@nestjs/common';
import type { SiteStatus, SignupMethod } from '@competition/contracts';
import { PrismaService } from '../platform/prisma.module';
import { AuditService } from '../platform/audit.module';
import { AppException } from '../platform/app-exception';
import { isHttpUrl } from '../domain/normalize';
import { safeFetch } from '../platform/safe-fetch';

const ENTRY_LIMITS: Record<string, number> = {
  official: 1,
  school: 1,
  backup: 4,
  instruction: 1,
};

@Injectable()
export class SignupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async addEntry(
    competitionId: string,
    input: {
      type?: string;
      url?: string | null;
      method?: SignupMethod;
      note?: string | null;
      contact?: string | null;
    },
    actorId: string,
  ): Promise<{ id: string; status: SiteStatus }> {
    const competition = await this.prisma.competition.findFirst({
      where: { id: competitionId, deletedAt: null },
    });
    if (!competition) throw new AppException('RESOURCE_NOT_FOUND');

    const method = input.method ?? 'web';
    if (!method) throw new AppException('SIGNUP_METHOD_REQUIRED');
    if (method === 'web' && !input.url) throw new AppException('SIGNUP_URL_REQUIRED');
    if (input.url && !isHttpUrl(input.url)) {
      throw new AppException('VALIDATION_FAILED', { field: 'url' });
    }
    if (method !== 'web' && !input.note && !input.contact) {
      throw new AppException('VALIDATION_FAILED', { field: 'note' }, '非网页报名需填写说明或联系信息');
    }

    const type = input.type ?? 'official';
    const existing = await this.prisma.signupEntry.count({
      where: { competitionId, type },
    });
    if (existing >= (ENTRY_LIMITS[type] ?? 1)) {
      throw new AppException('SIGNUP_ENTRY_LIMIT', { type, limit: ENTRY_LIMITS[type] });
    }

    const entry = await this.prisma.signupEntry.create({
      data: {
        competitionId,
        type,
        url: input.url ?? null,
        method,
        status: 'unverified',
        note: input.note ?? null,
        contact: input.contact ?? null,
      },
    });

    await this.prisma.competition.update({
      where: { id: competitionId },
      data: {
        signupMethod: method,
        signupUrl: input.url ?? competition.signupUrl,
        siteStatus: 'unverified',
      },
    });

    await this.audit.record({
      actorId,
      action: 'signup_entry.create',
      objectType: 'signup_entry',
      objectId: entry.id,
      detail: { competitionId, type, method, url: input.url ?? null },
    });

    return { id: entry.id, status: 'unverified' };
  }

  async verify(entryId: string, actorId: string): Promise<{
    status: SiteStatus;
    internalReason: string | null;
    checkedAt: string;
    redirectChain: string[];
  }> {
    const entry = await this.prisma.signupEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new AppException('RESOURCE_NOT_FOUND');

    if (!entry.url) {
      return {
        status: 'temporarily_unavailable',
        internalReason: 'no_url',
        checkedAt: new Date().toISOString(),
        redirectChain: [],
      };
    }

    let status: SiteStatus = 'unverified';
    let internalReason: string | null = null;
    let redirectChain: string[] = [];

    try {
      const result = await safeFetch(entry.url);
      redirectChain = result.redirectChain;
      const domainMismatch = result.finalUrl !== entry.url;
      const loginPage = /(统一身份认证|请登录|login|sign in|验证码)/i.test(result.bodyPreview);

      if (result.internalReason === 'timeout') {
        status = 'temporarily_unavailable';
        internalReason = 'timeout';
      } else if (result.internalReason === 'network_error') {
        status = 'temporarily_unavailable';
        internalReason = 'network_error';
      } else if (result.status === 401) {
        status = 'login_required';
        internalReason = 'unauthorized';
      } else if (result.status === 403) {
        status = 'temporarily_unavailable';
        internalReason = 'forbidden_programmatic_access';
      } else if (result.status === 404 || result.status === 410) {
        status = 'suspected_invalid';
        internalReason = 'not_found';
      } else if (result.status >= 500) {
        status = 'temporarily_unavailable';
        internalReason = 'server_error';
      } else if (loginPage) {
        status = 'login_required';
        internalReason = 'login_redirect';
      } else if (result.ok) {
        status = 'accessible';
        if (domainMismatch) internalReason = 'domain_mismatch';
      } else {
        status = 'temporarily_unavailable';
        internalReason = 'unknown';
      }
    } catch (error) {
      status = 'temporarily_unavailable';
      internalReason = error instanceof AppException ? 'ssrf_blocked' : 'probe_failed';
    }

    await this.prisma.signupEntry.update({
      where: { id: entryId },
      data: { status, internalReason, lastCheckedAt: new Date() },
    });
    await this.prisma.competition.update({
      where: { id: entry.competitionId },
      data: { siteStatus: status },
    });
    await this.audit.record({
      actorId,
      action: 'signup_entry.verify',
      objectType: 'signup_entry',
      objectId: entryId,
      detail: { status, internalReason, redirectChain },
    });

    return {
      status,
      internalReason,
      checkedAt: new Date().toISOString(),
      redirectChain,
    };
  }

  async trustDomain(entryId: string, domain: string, actorId: string): Promise<{ trusted: boolean }> {
    const entry = await this.prisma.signupEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new AppException('RESOURCE_NOT_FOUND');
    await this.prisma.signupEntry.update({
      where: { id: entryId },
      data: { trustedDomain: true },
    });
    await this.audit.record({
      actorId,
      action: 'signup_entry.trust_domain',
      objectType: 'signup_entry',
      objectId: entryId,
      detail: { domain },
    });
    return { trusted: true };
  }

  async resolveRedirect(entryId: string): Promise<{ targetUrl: string; requiresConfirmation: boolean; reason: string }> {
    const entry = await this.prisma.signupEntry.findUnique({ where: { id: entryId } });
    if (!entry?.url) throw new AppException('RESOURCE_NOT_FOUND');
    if (entry.trustedDomain && entry.status === 'accessible') {
      return { targetUrl: entry.url, requiresConfirmation: false, reason: '可信官方入口' };
    }
    return {
      targetUrl: entry.url,
      requiresConfirmation: true,
      reason: '该入口尚未标记为可信，请确认目标域名后再访问',
    };
  }

  async history(entryId: string): Promise<unknown[]> {
    return this.audit.list({ objectType: 'signup_entry', objectId: entryId, limit: 50 });
  }
}