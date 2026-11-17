import { Injectable } from '@nestjs/common';
import type {
  ConfigReadinessItem,
  ConfigReadinessOverall,
  ConfigReadinessView,
  ConfigReadinessState,
} from '@competition/contracts';
import { PrismaService } from '../platform/prisma.module';
import { ConfigResolverService } from './config-resolver.service';

const CACHE_MS = 30_000;

@Injectable()
export class ReadinessService {
  private cached: ConfigReadinessView | null = null;
  private cachedAt = 0;
  private recomputing: Promise<ConfigReadinessView> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: ConfigResolverService,
  ) {}

  async current(force = false): Promise<ConfigReadinessView> {
    if (!force && this.cached && Date.now() - this.cachedAt < CACHE_MS) return this.cached;
    if (!this.recomputing) {
      this.recomputing = this.compute().finally(() => {
        this.recomputing = null;
      });
    }
    return this.recomputing;
  }

  async recompute(): Promise<ConfigReadinessView> {
    return this.current(true);
  }

  latestSnapshot(): Promise<{ overall: string; itemsJson: string; computedAt: Date } | null> {
    return this.prisma.configReadinessSnapshot.findFirst({ orderBy: { computedAt: 'desc' } });
  }

  private async compute(): Promise<ConfigReadinessView> {
    await this.resolver.ready();
    const port = this.resolver.getNumber('server.port', 3000);
    const host = this.resolver.getString('server.listenHost', '127.0.0.1');
    const serviceAddressReady = port >= 1 && port <= 65535 && host.length > 0;

    let databaseReady = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      databaseReady = true;
    } catch {
      databaseReady = false;
    }
    const storageConfigured = this.resolver.getString('storage.type', 'local') === 'local' ||
      Boolean(this.resolver.getString('storage.bucket', ''));

    let parserState: ConfigReadinessState = 'degraded';
    let parserDetail = '解析服务不可达，已按降级策略继续规则运行';
    const parserUrl = this.resolver.getString('parser.baseUrl', '');
    if (parserUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const response = await fetch(
          `${parserUrl.replace(/\/$/, '')}${this.resolver.getString('parser.healthPath', '/healthz')}`,
          { signal: controller.signal },
        );
        if (response.ok) {
          parserState = 'ready';
          parserDetail = '解析服务健康';
        } else {
          parserState = 'degraded';
          parserDetail = `解析服务返回 ${response.status}，已降级可用`;
        }
      } catch {
        parserState = 'degraded';
        parserDetail = '解析服务不可达，已按降级策略继续规则运行';
      } finally {
        clearTimeout(timer);
      }
    } else {
      parserState = 'degraded';
      parserDetail = '未配置解析服务地址，按规则模式运行';
    }

    const modelEnabled = this.resolver.getBoolean('model.enabled', false);
    const modelSecret = this.resolver.get<string | null>('model.secretRef', null);
    const modelConfigured =
      modelEnabled &&
      Boolean(this.resolver.getString('model.baseUrl', '')) &&
      Boolean(modelSecret);
    const modelState: ConfigReadinessState = modelConfigured
      ? 'ready'
      : 'optional_not_configured';
    const modelDetail = modelConfigured
      ? '模型接入已配置'
      : '模型接入可选未配置，当前以规则模式运行';

    const verifiedSources = await this.prisma.sourceDefinition.count({
      where: { enabled: true, verified: true },
    });
    const sourceState: ConfigReadinessState = verifiedSources > 0 ? 'ready' : 'not_ready';
    const sourceDetail =
      verifiedSources > 0
        ? `已有 ${verifiedSources} 个启用且探测通过的信息源`
        : '至少需要一个启用且探测通过的信息源';

    const crawlEnabled = this.resolver.getBoolean('crawl.enabled', false);
    const crawlState: ConfigReadinessState = crawlEnabled ? 'ready' : 'disabled';
    const crawlDetail = crawlEnabled ? '采集总开关已开启' : '采集总开关默认关闭，可在采集运行中开启';

    const items: ConfigReadinessItem[] = [
      {
        key: 'service_address',
        label: '服务地址',
        required: true,
        state: serviceAddressReady ? 'ready' : 'not_ready',
        fixPath: '/settings/service_env',
        detail: serviceAddressReady ? `${host}:${port}` : '监听地址或端口不合法',
      },
      {
        key: 'data_storage',
        label: '数据存储',
        required: true,
        state: databaseReady && storageConfigured ? 'ready' : 'not_ready',
        fixPath: '/settings/data_storage',
        detail: databaseReady
          ? storageConfigured
            ? '数据库连通且存储已配置'
            : '对象存储尚未配置'
          : '数据库当前不可用',
      },
      {
        key: 'python_parser',
        label: 'Python 解析服务',
        required: true,
        state: parserState,
        fixPath: '/settings/python_parser',
        detail: parserDetail,
      },
      {
        key: 'model_access',
        label: '模型接入',
        required: false,
        state: modelState,
        fixPath: '/settings/model_access',
        detail: modelDetail,
      },
      {
        key: 'source',
        label: '信息源',
        required: true,
        state: sourceState,
        fixPath: '/sources',
        detail: sourceDetail,
      },
      {
        key: 'crawl_switch',
        label: '采集总开关',
        required: true,
        state: crawlState,
        fixPath: '/settings/crawl_runtime',
        detail: crawlDetail,
      },
    ];

    const blocking = items.some(
      (item) =>
        item.required &&
        item.key !== 'crawl_switch' &&
        item.key !== 'python_parser' &&
        item.state === 'not_ready',
    );
    const overall: ConfigReadinessOverall = blocking
      ? 'not_ready'
      : modelConfigured
        ? 'ready'
        : 'ready_rule_mode';

    const view: ConfigReadinessView = {
      overall,
      items,
      computedAt: new Date().toISOString(),
    };
    this.cached = view;
    this.cachedAt = Date.now();
    await this.prisma.configReadinessSnapshot.create({
      data: { overall, itemsJson: JSON.stringify(items) },
    });
    return view;
  }

  async overall(): Promise<ConfigReadinessOverall> {
    const view = await this.current();
    return view.overall;
  }
}