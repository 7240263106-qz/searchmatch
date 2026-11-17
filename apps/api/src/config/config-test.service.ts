import { Injectable } from '@nestjs/common';
import type {
  ConfigTestRequest,
  ConfigTestResult,
  ConfigTestResultCode,
  ConfigTestTarget,
} from '@competition/contracts';
import { PrismaService } from '../platform/prisma.module';
import { AuditService } from '../platform/audit.module';
import { AppException } from '../platform/app-exception';
import { ConfigResolverService } from './config-resolver.service';
import { CredentialVault } from './credential-vault.service';
import { checkAddress, parseHttpUrl } from './config-validation';

const TEST_TIMEOUT_MS = 10_000;
const COOLDOWN_MS = 60_000;

export function maskAddress(value: string): string {
  const url = parseHttpUrl(value);
  if (!url) return '未提供合法地址';
  const host = url.hostname;
  const maskedHost =
    host.length <= 3 ? '***' : `${host.slice(0, 3)}${'*'.repeat(Math.min(host.length - 3, 12))}`;
  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${maskedHost}${port}`;
}

@Injectable()
export class ConfigTestService {
  private readonly lastTest = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly resolver: ConfigResolverService,
    private readonly vault: CredentialVault,
  ) {}

  async test(
    request: ConfigTestRequest,
    actorId: string,
    teamId: string,
  ): Promise<ConfigTestResult> {
    const target = request.target;
    const resolution = await this.resolveTarget(request);
    const cooldownKey = `${teamId}:${target}:${resolution.maskedAddress}`;
    const now = Date.now();
    const previous = this.lastTest.get(cooldownKey);
    if (previous && now - previous < COOLDOWN_MS) {
      const cooldownSeconds = Math.ceil((COOLDOWN_MS - (now - previous)) / 1000);
      await this.audit.record({
        actorId,
        action: 'system_config.test_rate_limited',
        objectType: 'system_config',
        objectId: `${target}:${resolution.maskedAddress}`,
        detail: { target, cooldownSeconds, lastTestedAt: new Date(previous).toISOString() },
      });
      throw new AppException(
        'RATE_LIMITED',
        { cooldownSeconds, lastTestedAt: new Date(previous).toISOString() },
        `测试过于频繁，请在 ${cooldownSeconds} 秒后重试`,
      );
    }
    // 先占位再执行：并发请求同一目标时只允许一个真实外发，其余命中冷却。
    this.lastTest.set(cooldownKey, now);

    if (resolution.address) {
      const addressError = checkAddress(resolution.address, {
        allowLoopbackInDev: this.resolver.profile() !== 'prod',
        innerNetworkException: Boolean(request.innerNetworkException),
      });
      if (addressError) {
        await this.record(request, actorId, teamId, resolution, 0, 'target_refused', addressError);
        return {
          target,
          maskedAddress: resolution.maskedAddress,
          durationMs: 0,
          result: 'target_refused',
          suggestion: addressError,
          cooldownSeconds: 60,
          testedAt: new Date().toISOString(),
          validUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
          lastTestedAt: new Date(now).toISOString(),
          evidence: {
            requestedAt: new Date(now).toISOString(),
            realOutbound: false,
            egressRoute: 'address_rejected',
            cacheAgeSeconds: 0,
          },
        };
      }
    }

    const startedAt = Date.now();
    let result: ConfigTestResultCode;
    let suggestion: string;
    try {
      result = await this.execute(target, resolution.address, resolution.secretRef);
      suggestion = suggestionOf(result);
    } catch (error) {
      result = classifyError(error);
      suggestion = suggestionOf(result);
    }
    const durationMs = Date.now() - startedAt;

    await this.record(request, actorId, teamId, resolution, durationMs, result, suggestion);

    const testedAt = new Date().toISOString();
    return {
      target,
      maskedAddress: resolution.maskedAddress,
      durationMs,
      result,
      suggestion,
      cooldownSeconds: 60,
      testedAt,
      validUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
      lastTestedAt: testedAt,
      evidence: {
        requestedAt: new Date(startedAt).toISOString(),
        realOutbound:
          Boolean(resolution.address) &&
          target !== 'database' &&
          !(target === 'object_storage' && this.resolver.getString('storage.type', 'local') === 'local'),
        egressRoute: target === 'database' ? 'controlled-driver' : 'safe-fetch',
        cacheAgeSeconds: 0,
      },
    };
  }

  private async resolveTarget(request: ConfigTestRequest): Promise<{
    address: string;
    secretRef: string | null;
    maskedAddress: string;
  }> {
    if (request.target === 'database') {
      const host = this.resolver.getString('db.host', '127.0.0.1');
      const port = this.resolver.getNumber('db.port', 5432);
      const address = request.address ?? `http://${host}:${port}`;
      return {
        address,
        secretRef: request.secretRef ?? this.resolver.get<string | null>('db.secretRef', null),
        maskedAddress: maskAddress(address),
      };
    }
    if (request.target === 'python_parser') {
      const address = request.address ?? this.resolver.getString('parser.baseUrl', 'http://127.0.0.1:8000');
      return { address, secretRef: null, maskedAddress: maskAddress(address) };
    }
    if (request.target === 'model_service') {
      const address = request.address ?? this.resolver.getString('model.baseUrl', '');
      return {
        address,
        secretRef: request.secretRef ?? this.resolver.get<string | null>('model.secretRef', null),
        maskedAddress: maskAddress(address),
      };
    }
    if (request.target === 'object_storage') {
      const address = request.address ?? this.resolver.getString('storage.endpoint', '');
      return {
        address,
        secretRef: request.secretRef ?? this.resolver.get<string | null>('storage.secretRef', null),
        maskedAddress: maskAddress(address),
      };
    }
    const address =
      request.address ?? this.resolver.getString('server.publicBaseUrl', 'http://localhost:3000');
    return { address, secretRef: null, maskedAddress: maskAddress(address) };
  }

  private async execute(
    target: ConfigTestTarget,
    address: string,
    secretRef: string | null,
  ): Promise<ConfigTestResultCode> {
    if (target === 'database') {
      try {
        await this.prisma.$queryRaw`SELECT 1`;
        return 'success';
      } catch {
        return 'unreachable';
      }
    }

    if (target === 'object_storage' && this.resolver.getString('storage.type', 'local') === 'local') {
      return 'success';
    }

    if (!address) return 'unreachable';

    const secret = secretRef ? this.vault.resolve(secretRef) : null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    try {
      const healthPath =
        target === 'python_parser'
          ? this.resolver.getString('parser.healthPath', '/healthz')
          : '';
      const url =
        target === 'model_service'
          ? `${address.replace(/\/$/, '')}/models`
          : target === 'python_parser'
            ? `${address.replace(/\/$/, '')}${healthPath}`
            : address;
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (secret) headers.Authorization = `Bearer ${secret}`;
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'manual',
      });
      if (response.status >= 200 && response.status < 400) return 'success';
      if (response.status === 401 || response.status === 403) return 'auth_failed';
      return 'target_refused';
    } finally {
      clearTimeout(timer);
    }
  }

  private async record(
    request: ConfigTestRequest,
    actorId: string,
    teamId: string,
    resolution: { maskedAddress: string },
    durationMs: number,
    result: ConfigTestResultCode,
    failureReason: string,
  ): Promise<void> {
    await this.prisma.configTestRecord.create({
      data: {
        targetType: request.target,
        maskedAddress: resolution.maskedAddress,
        teamId,
        durationMs,
        resultCode: result,
        failureReason: result === 'success' ? null : failureReason,
        actorId,
      },
    });
    await this.audit.record({
      actorId,
      action: 'system_config.test_connection',
      objectType: 'system_config',
      objectId: `${request.target}:${resolution.maskedAddress}`,
      detail: { target: request.target, result, durationMs },
    });
  }
}

function classifyError(error: unknown): ConfigTestResultCode {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'AbortError' || /timeout|timed out/i.test(message)) return 'timeout';
  if (/certificate|CERT_/i.test(message)) return 'certificate_error';
  if (/protocol|ERR_INVALID_PROTOCOL/i.test(message)) return 'protocol_unsupported';
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|EAI_AGAIN/i.test(message)) return 'unreachable';
  return 'target_refused';
}

function suggestionOf(result: ConfigTestResultCode): string {
  switch (result) {
    case 'success':
      return '连接测试通过，现网配置未变更';
    case 'auth_failed':
      return '鉴权失败，请检查凭据引用或轮换密钥后重试';
    case 'unreachable':
      return '目标不可达，请检查地址、网络出口与端口';
    case 'timeout':
      return '连接超时，请检查目标负载、网络链路与超时时间';
    case 'certificate_error':
      return '证书校验失败，请使用受信任证书链的地址';
    case 'protocol_unsupported':
      return '协议不受支持，请使用 http/https 或受控连接';
    case 'target_refused':
      return '目标拒绝本次连接，请核对服务状态与访问策略';
    default:
      return '测试失败';
  }
}