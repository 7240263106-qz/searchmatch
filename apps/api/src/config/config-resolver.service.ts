import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  CONFIG_GROUP,
  type ConfigApplyMode,
  type ConfigApplyState,
  type ConfigGroup,
  type ConfigScope,
  type ConfigSource,
} from '@competition/contracts';
import { PrismaService } from '../platform/prisma.module';
import { CredentialVault } from './credential-vault.service';
import {
  CONFIG_ITEMS,
  configItemsOfGroup,
  parseStoredValue,
  serializeValue,
  type ConfigItemDefinition,
  type ConfigValue,
} from './config-items';

export interface ConfigSnapshotEntry {
  key: string;
  definition: ConfigItemDefinition;
  value: ConfigValue;
  savedValue: ConfigValue;
  source: ConfigSource;
  scope: ConfigScope;
  deploymentValue: ConfigValue;
  teamValue: ConfigValue;
  applyMode: ConfigApplyMode;
  applyState: ConfigApplyState;
  pendingRestartAt: string | null;
  runtimeMismatch: boolean;
  secretRefId: string | null;
  maskedTail: string | null;
  configured: boolean;
}

interface SnapshotState {
  version: number;
  lastModifiedBy: string | null;
  lastModifiedAt: string | null;
  loadedAt: string;
  fingerprint: string;
  entries: Map<string, ConfigSnapshotEntry>;
}

const PROFILE_VALUES = new Set(['dev', 'test', 'prod']);

@Injectable()
export class ConfigResolverService {
  private readonly logger = new Logger(ConfigResolverService.name);
  private state: SnapshotState | null = null;
  private initializing: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: CredentialVault,
  ) {}

  async ensureInitialized(): Promise<void> {
    if (this.state) return;
    if (!this.initializing) {
      this.initializing = this.initialize().finally(() => {
        this.initializing = null;
      });
    }
    await this.initializing;
  }

  private async initialize(): Promise<void> {
    let latest = await this.prisma.systemConfigVersion.findFirst({ orderBy: { version: 'desc' } });
    if (!latest) {
      await this.createInitialVersion();
      latest = await this.prisma.systemConfigVersion.findFirst({ orderBy: { version: 'desc' } });
    }
    if (!latest) throw new Error('配置初始化失败，未找到有效配置版本');
    await this.reconcilePendingOnBoot();
    await this.load(latest.version);
    await this.markRuntimeMismatch();
  }

  private async reconcilePendingOnBoot(): Promise<void> {
    const pending = await this.prisma.configApplyState.findMany({
      where: { applyState: 'pending_restart' },
    });
    for (const row of pending) {
      await this.prisma.configApplyState.update({
        where: { key: row.key },
        data: {
          runtimeValueJson: row.savedValueJson,
          applyState: 'applied',
          pendingRestartAt: null,
          runtimeMismatch: false,
        },
      });
    }
    if (pending.length > 0) {
      this.logger.log(`启动校验：${pending.length} 个待重启配置项已按保存值生效`);
    }
  }

  private envProfile(): 'dev' | 'test' | 'prod' {
    const raw = (process.env.APP_ENV ?? process.env.NODE_ENV ?? 'dev').toLowerCase();
    if (raw === 'production' || raw === 'prod') return 'prod';
    if (raw === 'test') return 'test';
    return 'dev';
  }

  private coerceFromEnv(definition: ConfigItemDefinition, raw: string): ConfigValue {
    const trimmed = raw.trim();
    switch (definition.dataType) {
      case 'int':
      case 'number': {
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : definition.defaultValue;
      }
      case 'bool':
        return ['1', 'true', 'TRUE', 'yes', 'on'].includes(trimmed);
      case 'string_array':
        return trimmed
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
      case 'enum':
        return definition.enumValues?.includes(trimmed) ? trimmed : definition.defaultValue;
      default:
        return trimmed;
    }
  }

  private initialValueOf(definition: ConfigItemDefinition): {
    value: ConfigValue;
    source: ConfigSource;
  } {
    if (definition.scope === 'locked') {
      return { value: definition.defaultValue, source: 'locked' };
    }
    if (definition.key === 'env.profile') {
      return { value: this.envProfile(), source: 'env_default' };
    }
    const raw = definition.envVar ? process.env[definition.envVar] : undefined;
    if (raw !== undefined && raw !== '') {
      const coerced = this.coerceFromEnv(definition, raw);
      if (coerced !== null) return { value: coerced, source: 'env_default' };
    }
    return { value: definition.defaultValue, source: 'builtin_default' };
  }

  private async createInitialVersion(): Promise<void> {
    const values: Array<{
      key: string;
      group: ConfigGroup;
      scope: string;
      valueJson: string | null;
      source: ConfigSource;
    }> = [];
    const legacyModel = await this.prisma.modelProviderConfig.findFirst({
      where: { enabled: true },
      orderBy: { updatedAt: 'desc' },
    });
    const legacyCount = await this.prisma.modelProviderConfig.count();
    if (legacyCount > 1) {
      this.logger.warn('检测到多条模型配置，已迁移启用行，其余行保留并记录告警');
    }
    let modelSecretRef: string | null = null;

    for (const definition of CONFIG_ITEMS) {
      const initial = this.initialValueOf(definition);
      values.push({
        key: definition.key,
        group: definition.group,
        scope: definition.scope,
        valueJson: definition.dataType === 'secret_ref' ? null : serializeValue(initial.value),
        source: initial.source,
      });
    }

    if (legacyModel) {
      const overrides: Array<{ key: string; value: ConfigValue }> = [
        { key: 'model.baseUrl', value: legacyModel.baseUrl },
        { key: 'model.model', value: legacyModel.model },
        { key: 'model.enabled', value: legacyModel.enabled },
        { key: 'model.timeoutMs', value: legacyModel.timeoutMs },
      ];
      for (const override of overrides) {
        const target = values.find((entry) => entry.key === override.key);
        if (target) target.valueJson = serializeValue(override.value);
      }
      if (legacyModel.secretRef && (await this.vault.exists(legacyModel.secretRef))) {
        modelSecretRef = legacyModel.secretRef;
      }
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const versionRow = await tx.systemConfigVersion.create({
        data: {
          version: 1,
          baseVersion: null,
          actorId: 'system',
          actorRole: 'system',
          reason: '首次初始化',
          applyState: 'applied',
          changeCount: values.length,
        },
      });
      await tx.systemConfigValue.createMany({
        data: values.map((entry) => ({
          versionNo: versionRow.version,
          key: entry.key,
          group: entry.group,
          scope: entry.scope,
          valueJson: entry.valueJson,
          source: entry.source,
          secretRefId: entry.key === 'model.secretRef' ? modelSecretRef : null,
        })),
      });
      return versionRow;
    });

    const createdValues = await this.prisma.systemConfigValue.findMany({
      where: { versionNo: created.version },
    });
    for (const row of createdValues) {
      const definition = CONFIG_ITEMS.find((entry) => entry.key === row.key);
      if (!definition) continue;
      await this.prisma.configApplyState.upsert({
        where: { key: row.key },
        create: {
          key: row.key,
          group: row.group,
          versionNo: created.version,
          savedValueJson: row.valueJson,
          runtimeValueJson: row.valueJson,
          applyState: 'applied',
        },
        update: {},
      });
    }

  }

  async reload(): Promise<void> {
    const latest = await this.prisma.systemConfigVersion.findFirst({ orderBy: { version: 'desc' } });
    if (!latest) {
      await this.ensureInitialized();
      return;
    }
    await this.load(latest.version);
  }

  private async load(versionNo: number): Promise<void> {
    const [version, rows, applyRows] = await Promise.all([
      this.prisma.systemConfigVersion.findUnique({ where: { version: versionNo } }),
      this.prisma.systemConfigValue.findMany({ where: { versionNo } }),
      this.prisma.configApplyState.findMany(),
    ]);
    if (!version) throw new Error(`配置版本 ${versionNo} 不存在`);

    const applyMap = new Map(applyRows.map((row) => [row.key, row]));
    const entries = new Map<string, ConfigSnapshotEntry>();

    for (const definition of CONFIG_ITEMS) {
      const scoped = rows.filter((row) => row.key === definition.key);
      const deployment = scoped.find((row) => row.scope === 'deployment');
      const team = scoped.find((row) => row.scope === 'team');
      const locked = definition.scope === 'locked' || definition.readOnly === true;
      const deploymentValue = deployment ? parseStoredValue(deployment.valueJson) : null;
      const teamValue = team ? parseStoredValue(team.valueJson) : null;

      let value: ConfigValue;
      let source: ConfigSource;
      let secretRefId: string | null = null;
      let maskedTail: string | null = null;

      if (locked) {
        value =
          ['env.profile', 'auth.deploymentActorId'].includes(definition.key)
            ? (scoped.find((row) => row.scope === definition.scope)?.valueJson
                ? parseStoredValue(
                    scoped.find((row) => row.scope === definition.scope)?.valueJson ?? null,
                  )
                : definition.key === 'env.profile' ? this.envProfile() : definition.defaultValue)
            : definition.defaultValue;
        source = definition.scope === 'locked' ? 'locked' : (deployment?.source as ConfigSource) ?? 'builtin_default';
        secretRefId = null;
      } else if (definition.dataType === 'secret_ref') {
        const row = scoped.find((item) => item.scope === definition.scope) ?? deployment ?? team;
        secretRefId = row?.secretRefId ?? null;
        maskedTail = secretRefId ? (this.vault.tailOf(secretRefId) ?? row?.maskedTail ?? null) : null;
        value = secretRefId;
        source = (row?.source as ConfigSource) ?? 'builtin_default';
      } else if (deployment && deployment.source === 'page_saved') {
        value = deploymentValue;
        source = 'page_saved';
      } else if (team && team.source === 'page_saved') {
        value = teamValue;
        source = 'page_saved';
      } else if (deployment) {
        value = deploymentValue;
        source = deployment.source as ConfigSource;
      } else if (team) {
        value = teamValue;
        source = team.source as ConfigSource;
      } else {
        value = definition.defaultValue;
        source = 'builtin_default';
      }

      const applyRow = applyMap.get(definition.key);
      const applyState: ConfigApplyState =
        (applyRow?.applyState as ConfigApplyState) ?? 'applied';
      const runtimeValue =
        applyState === 'pending_restart' && applyRow && applyRow.runtimeValueJson !== null
          ? parseStoredValue(applyRow.runtimeValueJson)
          : value;
      const pendingRestartAt =
        applyState === 'pending_restart' && applyRow?.pendingRestartAt
          ? applyRow.pendingRestartAt.toISOString()
          : null;
      const effectiveRuntime = runtimeValue;
      const savedValue = definition.dataType === 'secret_ref' ? secretRefId : value;

      entries.set(definition.key, {
        key: definition.key,
        definition,
        value: effectiveRuntime,
        savedValue,
        source,
        scope: definition.scope,
        deploymentValue,
        teamValue,
        applyMode: definition.applyMode,
        applyState,
        pendingRestartAt,
        runtimeMismatch:
          applyState === 'pending_restart' &&
          JSON.stringify(runtimeValue) !== JSON.stringify(value),
        secretRefId,
        maskedTail,
        configured: Boolean(secretRefId && (this.vault.tailOf(secretRefId) ?? maskedTail)),
      });
    }

    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify(
          [...entries.values()]
            .map((entry) => [entry.key, entry.value, entry.source, entry.applyState])
            .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
        ),
      )
      .digest('hex')
      .slice(0, 32);

    this.state = {
      version: version.version,
      lastModifiedBy: version.actorId,
      lastModifiedAt: version.createdAt.toISOString(),
      loadedAt: new Date().toISOString(),
      fingerprint,
      entries,
    };
    this.logger.log(`配置文件版本 v${version.version} 已加载，共 ${entries.size} 项`);
  }

  private async markRuntimeMismatch(): Promise<void> {
    if (!this.state) return;
    for (const entry of this.state.entries.values()) {
      if (entry.applyState !== 'pending_restart') continue;
      const applyRow = await this.prisma.configApplyState.findUnique({ where: { key: entry.key } });
      if (!applyRow) continue;
      const saved = parseStoredValue(applyRow.savedValueJson);
      const runtime = parseStoredValue(applyRow.runtimeValueJson);
      entry.runtimeMismatch = JSON.stringify(saved) !== JSON.stringify(runtime);
      if (!entry.runtimeMismatch) {
        entry.applyState = 'applied';
        entry.pendingRestartAt = null;
        await this.prisma.configApplyState.update({
          where: { key: entry.key },
          data: { applyState: 'applied', pendingRestartAt: null, runtimeMismatch: false },
        });
      }
    }
  }

  async ready(): Promise<void> {
    await this.ensureInitialized();
  }

  snapshotVersion(): number {
    return this.state?.version ?? 0;
  }

  lastModifiedBy(): string | null {
    return this.state?.lastModifiedBy ?? null;
  }

  lastModifiedAt(): string | null {
    return this.state?.lastModifiedAt ?? null;
  }

  loadedAt(): string | null {
    return this.state?.loadedAt ?? null;
  }

  snapshotFingerprint(): string {
    return this.state?.fingerprint ?? '';
  }

  entryOf(key: string): ConfigSnapshotEntry | null {
    return this.state?.entries.get(key) ?? null;
  }

  get<T extends ConfigValue>(key: string, fallback: T): T {
    const entry = this.state?.entries.get(key);
    return (entry ? entry.value : fallback) as T;
  }

  getBoolean(key: string, fallback = false): boolean {
    return Boolean(this.get<boolean>(key, fallback));
  }

  getNumber(key: string, fallback = 0): number {
    const value = this.get<number>(key, fallback);
    return typeof value === 'number' ? value : Number(value);
  }

  getString(key: string, fallback = ''): string {
    const value = this.get<string>(key, fallback);
    return typeof value === 'string' ? value : String(value ?? '');
  }

  getStringArray(key: string, fallback: string[] = []): string[] {
    const value = this.get<string[]>(key, fallback);
    return Array.isArray(value) ? value.map(String) : fallback;
  }

  sourceOf(key: string): ConfigSource {
    return this.state?.entries.get(key)?.source ?? 'builtin_default';
  }

  applyStateOf(key: string): ConfigApplyState {
    return this.state?.entries.get(key)?.applyState ?? 'applied';
  }

  pendingRestartKeys(): string[] {
    if (!this.state) return [];
    return [...this.state.entries.values()]
      .filter((entry) => entry.applyState === 'pending_restart')
      .map((entry) => entry.key);
  }

  applyFailedKeys(): string[] {
    if (!this.state) return [];
    return [...this.state.entries.values()]
      .filter((entry) => entry.applyState === 'apply_failed')
      .map((entry) => entry.key);
  }

  runtimeMismatchKeys(): string[] {
    if (!this.state) return [];
    return [...this.state.entries.values()]
      .filter((entry) => entry.runtimeMismatch)
      .map((entry) => entry.key);
  }

  entries(): ConfigSnapshotEntry[] {
    return this.state ? [...this.state.entries.values()] : [];
  }

  groupEntries(group: ConfigGroup): ConfigSnapshotEntry[] {
    return this.entries().filter((entry) => entry.definition.group === group);
  }

  groups(): ConfigGroup[] {
    return [...CONFIG_GROUP];
  }

  itemsOfGroup(group: ConfigGroup): ConfigItemDefinition[] {
    return configItemsOfGroup(group);
  }

  isDevProfile(): boolean {
    return this.envProfile() !== 'prod';
  }

  profile(): 'dev' | 'test' | 'prod' {
    return this.envProfile();
  }

  static allProfiles(): ReadonlySet<string> {
    return PROFILE_VALUES;
  }

  markApplyFailed(keys: string[]): void {
    if (!this.state) return;
    for (const key of keys) {
      const entry = this.state.entries.get(key);
      if (entry) entry.applyState = 'apply_failed';
    }
  }

  async setApplyStates(
    updates: Array<{ key: string; applyState: ConfigApplyState; versionNo: number; saved?: ConfigValue; runtime?: ConfigValue; pendingAt?: Date | null }>,
  ): Promise<void> {
    for (const update of updates) {
      const entry = this.state?.entries.get(update.key);
      if (entry) entry.applyState = update.applyState;
      await this.prisma.configApplyState.upsert({
        where: { key: update.key },
        create: {
          key: update.key,
          group: entry?.definition.group ?? 'service_env',
          versionNo: update.versionNo,
          savedValueJson: serializeValue(update.saved ?? update.runtime ?? null),
          runtimeValueJson: serializeValue(update.runtime ?? update.saved ?? null),
          applyState: update.applyState,
          pendingRestartAt: update.pendingAt ?? null,
        },
        update: {
          versionNo: update.versionNo,
          savedValueJson: serializeValue(update.saved ?? update.runtime ?? null),
          runtimeValueJson: serializeValue(update.runtime ?? update.saved ?? null),
          applyState: update.applyState,
          pendingRestartAt: update.pendingAt ?? null,
          runtimeMismatch: update.applyState === 'pending_restart',
        },
      });
    }
  }

  /** 供启动期快速读取，不依赖 Nest 生命周期。 */
  async bootValue(key: string, fallback: ConfigValue): Promise<ConfigValue> {
    await this.ensureInitialized();
    return this.get(key, fallback as never);
  }
}
