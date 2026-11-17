import { Injectable, Logger } from '@nestjs/common';
import {
  CONFIG_GROUP_META,
  MODEL_PRESETS,
  type ConfigApplyState,
  type ConfigChangeInput,
  type ConfigGroup,
  type ConfigItemView,
  type ConfigGroupView,
  type ConfigOverview,
  type ConfigRollbackRequest,
  type ConfigSaveItemResult,
  type ConfigSaveResult,
  type ConfigScope,
  type ConfigSource,
  type ConfigVersionChange,
  type ConfigVersionDiff,
  type ConfigVersionSummary,
  type ModelSetupRequest,
  type SystemConfigurationHealth,
} from '@competition/contracts';
import { PrismaService } from '../platform/prisma.module';
import { AuditService } from '../platform/audit.module';
import { AppException } from '../platform/app-exception';
import { CredentialVault } from './credential-vault.service';
import { ConfigResolverService, type ConfigSnapshotEntry } from './config-resolver.service';
import { ReadinessService } from './readiness.service';
import { ConnectionRuntimeService } from './connection-runtime.service';
import { ModelRequestError, parseModelJson, requestModelCompletion } from './model-completion';
import {
  CONFIG_ITEM_MAP,
  isConfigGroup,
  isSecuritySwitch,
  parseStoredValue,
  serializeValue,
  type ConfigItemDefinition,
  type ConfigValue,
} from './config-items';
import {
  rangeOf,
  validateCrossItems,
  validateValue,
  type ConfigViolation,
} from './config-validation';

export interface ActorContext {
  userId: string;
  roles: string[];
  teamId: string;
  sourceAddress?: string;
}

interface ValueRow {
  key: string;
  group: string;
  scope: string;
  valueJson: string | null;
  secretRefId: string | null;
  maskedTail: string | null;
  configured: boolean;
  source: string;
}

const REQUIRED_ROLE = 'admin';

const MODEL_TEST_MESSAGE: Record<string, string> = {
  http_401: 'API Key 未通过验证，请核对密钥和服务商。',
  http_403: '该 API Key 没有调用此模型的权限，请检查账户权限。',
  http_402: '服务商提示余额不足，请检查账户余额。',
  http_429: '服务商限制了请求，请检查用量或稍后再试。',
  http_404: '服务商未找到默认模型，请核对账户的模型权限。',
  minimax_1004: 'MiniMax API Key 未通过验证，请核对密钥。',
  minimax_1008: 'MiniMax 账户余额不足，请检查账户余额。',
  timeout: '连接验证超时，请稍后重试。',
  network_error: '项目服务器无法连接模型服务，请检查网络。',
  invalid_response: '模型未返回预期的验证结果，请重试。',
};

@Injectable()
export class ConfigService {
  private readonly logger = new Logger(ConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly resolver: ConfigResolverService,
    private readonly vault: CredentialVault,
    private readonly readiness: ReadinessService,
    private readonly connections: ConnectionRuntimeService,
  ) {}

  assertAdmin(actor: ActorContext): void {
    if (!actor.roles.includes(REQUIRED_ROLE)) {
      void this.audit.record({
        actorId: actor.userId,
        action: 'system_config.forbidden',
        objectType: 'system_config',
        objectId: 'settings',
        detail: { sourceAddress: actor.sourceAddress ?? null, path: 'system-settings' },
      });
      throw new AppException('CONF_FORBIDDEN');
    }
  }

  async overview(): Promise<ConfigOverview> {
    await this.resolver.ready();
    const entries = this.resolver.entries();
    const pendingRestartKeys = this.resolver.pendingRestartKeys();
    const applyFailedKeys = this.resolver.applyFailedKeys();
    const runtimeMismatchKeys = this.resolver.runtimeMismatchKeys();
    const groups = (Object.keys(CONFIG_GROUP_META) as ConfigGroup[]).map((group) => {
      const meta = CONFIG_GROUP_META[group];
      const groupEntries = entries.filter((entry) => entry.definition.group === group);
      return {
        group,
        label: meta.label,
        page: meta.page,
        itemCount: groupEntries.length,
        pendingRestartCount: groupEntries.filter((entry) =>
          pendingRestartKeys.includes(entry.key),
        ).length,
        applyFailedCount: groupEntries.filter((entry) => applyFailedKeys.includes(entry.key)).length,
        runtimeMismatchCount: groupEntries.filter((entry) =>
          runtimeMismatchKeys.includes(entry.key),
        ).length,
      };
    });
    return {
      version: this.resolver.snapshotVersion(),
      lastModifiedBy: this.resolver.lastModifiedBy(),
      lastModifiedAt: this.resolver.lastModifiedAt(),
      groups,
      pendingRestartKeys,
      applyFailedKeys,
      runtimeMismatchKeys,
      devIdentityEnabled: this.resolver.getBoolean('auth.devIdentityEnabled', false),
      devIdentityProfile: this.resolver.profile(),
      readiness: await this.readiness.current(),
      snapshotFingerprint: this.resolver.snapshotFingerprint(),
      loadedAt: this.resolver.loadedAt() ?? undefined,
      connectionProvenance: await this.connections.provenance(),
      clientBase: {
        apiBaseUrl: `${this.resolver
          .getString('server.publicBaseUrl', 'http://localhost:3000')
          .replace(/\/$/, '')}/api/v1`,
        source: 'configured',
        configVersion: this.resolver.snapshotVersion(),
        issuedAt: new Date().toISOString(),
        cacheMaxAgeSeconds: 60,
        stale: false,
      },
    };
  }

  async getGroup(groupValue: string): Promise<ConfigGroupView> {
    await this.resolver.ready();
    if (!isConfigGroup(groupValue)) throw new AppException('CONF_VALUE_INVALID');
    const group = groupValue;
    const meta = CONFIG_GROUP_META[group];
    const entries = this.resolver.groupEntries(group);
    const credentials = await this.prisma.credentialRef.findMany();
    const credentialMap = new Map(credentials.map((row) => [row.id, row]));
    const provenance =
      group === 'data_storage' ? await this.connections.provenance() : null;
    const items = entries.map((entry) =>
      this.toItemView(
        entry,
        credentialMap,
        provenance
          ? entry.key.startsWith('db.')
            ? provenance.database
            : provenance.objectStorage
          : null,
      ),
    );
    return {
      group,
      label: meta.label,
      page: meta.page,
      description: meta.description,
      version: this.resolver.snapshotVersion(),
      lastModifiedBy: this.resolver.lastModifiedBy(),
      lastModifiedAt: this.resolver.lastModifiedAt(),
      pendingRestartKeys: this.resolver.pendingRestartKeys(),
      items,
    };
  }

  private toItemView(
    entry: ConfigSnapshotEntry,
    credentials: Map<string, { maskedTail: string; lastUpdatedAt: Date; status: string }>,
    runtimeConnection: ConfigItemView['runtimeConnection'] = null,
  ): ConfigItemView {
    const definition = entry.definition;
    const isSecret = definition.dataType === 'secret_ref';
    const credential = entry.secretRefId ? credentials.get(entry.secretRefId) : undefined;
    return {
      key: entry.key,
      group: definition.group,
      label: definition.label,
      description: definition.description,
      dataType: definition.dataType,
      scope: definition.scope,
      source: entry.source,
      applyMode: definition.applyMode,
      applyState: entry.applyState,
      required: definition.required,
      editable:
        definition.scope !== 'locked' &&
        definition.readOnly !== true &&
        definition.applyMode !== 'immutable',
      unit: definition.unit,
      allowedRange: rangeOf(definition),
      enumValues: definition.enumValues,
      effectiveValue: isSecret ? null : (entry.value as ConfigItemView['effectiveValue']),
      deploymentValue: isSecret ? null : entry.deploymentValue,
      teamValue: isSecret ? null : entry.teamValue,
      configured: isSecret ? entry.configured : undefined,
      maskedTail: isSecret ? (credential?.maskedTail ?? entry.maskedTail) : undefined,
      lastUpdatedAt: isSecret
        ? (credential?.lastUpdatedAt.toISOString() ?? null)
        : null,
      runtimeMismatch: entry.runtimeMismatch,
      lockedReason: definition.lockedReason,
      runtimeConnection,
    };
  }

  async saveGroup(
    groupValue: string,
    request: { baseVersion: number; changes: ConfigChangeInput[]; confirmToken?: string; reason?: string },
    actor: ActorContext,
    ifMatchVersion: number | null,
    idempotencyKey?: string,
  ): Promise<ConfigSaveResult> {
    this.assertAdmin(actor);
    if (!isConfigGroup(groupValue)) throw new AppException('CONF_VALUE_INVALID');
    const group = groupValue;
    if (idempotencyKey) {
      const replayed = await this.loadIdempotent(`system-config:${group}`, idempotencyKey);
      if (replayed) return replayed as ConfigSaveResult;
    }
    const result = await this.persist(group, request, actor, ifMatchVersion, 'save');
    if (idempotencyKey) await this.storeIdempotent(`system-config:${group}`, idempotencyKey, result);
    return result;
  }

  async setupModel(request: ModelSetupRequest, actor: ActorContext): Promise<ConfigSaveResult> {
    this.assertAdmin(actor);
    if (typeof request?.provider !== 'string' || !Object.hasOwn(MODEL_PRESETS, request.provider)) {
      throw new AppException('CONF_VALUE_INVALID', undefined, '请选择 DeepSeek、MiniMax 或 ChatGPT。');
    }
    const apiKey = typeof request.apiKey === 'string' ? request.apiKey.trim() : '';
    if (!/^[!-~]{1,4096}$/.test(apiKey)) {
      throw new AppException('CONF_CREDENTIAL_MISSING', undefined, '请填写有效的 API Key。');
    }
    await this.resolver.ready();
    const currentVersion = this.resolver.snapshotVersion();
    if (request.baseVersion !== currentVersion) {
      throw new AppException('CONF_VERSION_CONFLICT', { currentVersion });
    }
    const preset = MODEL_PRESETS[request.provider];
    try {
      const { content } = await requestModelCompletion({
        baseUrl: preset.baseUrl,
        model: preset.model,
        apiKey,
        timeoutMs: 15_000,
        maxOutputTokens: 128,
        messages: [
          { role: 'system', content: 'Return a JSON object with the boolean field ok.' },
          { role: 'user', content: 'Reply with exactly {"ok":true}.' },
        ],
      });
      if (parseModelJson<{ ok?: boolean }>(content).ok !== true) throw new ModelRequestError('invalid_response');
    } catch (error) {
      const reason = error instanceof ModelRequestError ? error.reason : 'invalid_response';
      throw new AppException('CONF_MODEL_TEST_FAILED', { reason },
        MODEL_TEST_MESSAGE[reason] ?? '服务商未接受模型验证请求，请检查模型权限或稍后重试。');
    }

    const { secretRefId } = await this.writeCredential(null, { plaintext: apiKey, purpose: 'model_access' }, actor);
    const changes: ConfigChangeInput[] = [
      { key: 'model.serviceType', value: 'openai_compatible' },
      { key: 'model.baseUrl', value: preset.baseUrl },
      { key: 'model.model', value: preset.model },
      { key: 'model.secretRef', value: secretRefId },
      { key: 'model.enabled', value: true },
    ];
    if (this.resolver.getString('model.baseUrl', '').replace(/\/+$/, '') !== preset.baseUrl) {
      for (const entry of this.resolver.groupEntries('model_access')) {
        if (entry.key.startsWith('model.taskModel.') && entry.savedValue) changes.push({ key: entry.key, value: '' });
      }
    }
    try {
      return await this.saveGroup('model_access', {
        baseVersion: request.baseVersion,
        changes,
        reason: `快速启用 ${preset.label}`,
      }, actor, request.baseVersion);
    } catch (error) {
      try {
        const referenced = await this.prisma.systemConfigValue.findFirst({ where: { secretRefId }, select: { key: true } });
        if (!referenced) await this.vault.revoke(secretRefId);
      } catch {
        this.logger.warn('未能清理未关联的模型凭据');
      }
      throw error;
    }
  }

  async saveItem(
    groupValue: string,
    key: string,
    request: { baseVersion: number; value: ConfigValue; confirmToken?: string; reason?: string },
    actor: ActorContext,
    ifMatchVersion: number | null,
  ): Promise<ConfigSaveResult> {
    this.assertAdmin(actor);
    if (!isConfigGroup(groupValue)) throw new AppException('CONF_VALUE_INVALID');
    const definition = CONFIG_ITEM_MAP.get(key);
    if (!definition || definition.group !== groupValue) throw new AppException('CONF_VALUE_INVALID');
    return this.persist(
      groupValue,
      {
        baseVersion: request.baseVersion,
        changes: [{ key, value: request.value }],
        confirmToken: request.confirmToken,
        reason: request.reason,
      },
      actor,
      ifMatchVersion,
      'save_item',
    );
  }

  private async persist(
    group: ConfigGroup,
    request: { baseVersion: number; changes: ConfigChangeInput[]; confirmToken?: string; reason?: string },
    actor: ActorContext,
    ifMatchVersion: number | null,
    action: string,
  ): Promise<ConfigSaveResult> {
    await this.resolver.ready();
    const currentVersion = this.resolver.snapshotVersion();

    if (
      ifMatchVersion !== null &&
      Number.isFinite(ifMatchVersion) &&
      Number(ifMatchVersion) !== Number(request.baseVersion)
    ) {
      throw new AppException('CONF_VERSION_CONFLICT', {
        currentVersion,
        lastModifiedBy: this.resolver.lastModifiedBy(),
        lastModifiedAt: this.resolver.lastModifiedAt(),
      });
    }
    if (!Number.isInteger(request.baseVersion) || request.baseVersion < 1) {
      throw new AppException('CONF_VERSION_CONFLICT', {
        currentVersion,
        lastModifiedBy: this.resolver.lastModifiedBy(),
        lastModifiedAt: this.resolver.lastModifiedAt(),
      });
    }
    if (request.baseVersion !== currentVersion) {
      throw new AppException('CONF_VERSION_CONFLICT', {
        currentVersion,
        lastModifiedBy: this.resolver.lastModifiedBy(),
        lastModifiedAt: this.resolver.lastModifiedAt(),
      });
    }
    if (!Array.isArray(request.changes) || request.changes.length === 0) {
      throw new AppException('CONF_VALUE_INVALID', {
        violations: [{ key: '', reason: '至少提交一个变更项' }],
      });
    }

    const definitions = request.changes.map((change) => {
      const definition = CONFIG_ITEM_MAP.get(change.key);
      if (!definition) {
        throw new AppException('CONF_VALUE_INVALID', {
          violations: [{ key: change.key, reason: '配置项不存在' }],
        });
      }
      if (definition.group !== group) {
        throw new AppException('CONF_VALUE_INVALID', {
          violations: [{ key: change.key, reason: '配置项不属于当前分组' }],
        });
      }
      return definition;
    });

    const violations: ConfigViolation[] = [];
    for (const definition of definitions) {
      const change = request.changes.find((entry) => entry.key === definition.key)!;
      if (isSecuritySwitch(definition.key) && change.value !== true) {
        void this.audit.record({
          actorId: actor.userId,
          action: 'system_config.security_switch_close_attempt',
          objectType: 'system_config',
          objectId: definition.key,
          detail: { key: definition.key, attemptedValue: change.value, sourceAddress: actor.sourceAddress ?? null },
        });
        throw new AppException('CONF_SECURITY_SWITCH_LOCKED', {
          violations: [
            {
              key: definition.key,
              reason: '安全开关为强制开启，服务端拒绝关闭请求',
            },
          ],
        });
      }
      const violation = validateValue(definition, change.value, {
        profile: this.resolver.profile(),
        isChanged: true,
      });
      if (violation) violations.push(violation);
    }

    const merged = this.currentValueMap();
    for (const change of request.changes) merged.set(change.key, change.value);
    violations.push(...validateCrossItems(merged));

    for (const definition of definitions) {
      if (definition.dataType !== 'secret_ref') continue;
      const change = request.changes.find((entry) => entry.key === definition.key)!;
      const ref = typeof change.value === 'string' ? change.value : null;
      if (ref && !(await this.vault.exists(ref))) {
        violations.push({
          key: definition.key,
          reason: '凭据引用不存在或已失效',
          code: 'CONF_CREDENTIAL_MISSING',
        });
      }
    }

    if (violations.length > 0) {
      const locked = violations.find((entry) => entry.code === 'CONF_SECURITY_SWITCH_LOCKED');
      if (locked) throw new AppException('CONF_SECURITY_SWITCH_LOCKED', { violations });
      const readonlyViolation = violations.find((entry) => {
        const definition = CONFIG_ITEM_MAP.get(entry.key);
        return (
          entry.code === 'CONF_VALUE_INVALID' &&
          (definition?.readOnly === true || definition?.scope === 'locked')
        );
      });
      if (readonlyViolation) {
        throw new AppException('CONF_VALUE_INVALID', { violations });
      }
      const forbiddenAddress = violations.find((entry) => entry.code === 'CONF_ADDRESS_FORBIDDEN');
      if (forbiddenAddress) {
        void this.audit.record({
          actorId: actor.userId,
          action: 'system_config.address_forbidden',
          objectType: 'system_config',
          objectId: forbiddenAddress.key,
          detail: { key: forbiddenAddress.key, reason: forbiddenAddress.reason },
        });
        throw new AppException('CONF_ADDRESS_FORBIDDEN', { violations });
      }
      const devIdentity = violations.find((entry) => entry.code === 'CONF_DEV_IDENTITY_FORBIDDEN');
      if (devIdentity) {
        void this.audit.record({
          actorId: actor.userId,
          action: 'system_config.dev_identity_forbidden',
          objectType: 'system_config',
          objectId: devIdentity.key,
          detail: { key: devIdentity.key, profile: this.resolver.profile() },
        });
        throw new AppException('CONF_DEV_IDENTITY_FORBIDDEN', { violations });
      }
      const missingCredential = violations.find((entry) => entry.code === 'CONF_CREDENTIAL_MISSING');
      if (missingCredential) {
        throw new AppException('CONF_CREDENTIAL_MISSING', { violations });
      }
      throw new AppException('CONF_VALUE_INVALID', { violations });
    }

    const base = await this.prisma.systemConfigVersion.findFirst({ orderBy: { version: 'desc' } });
    if (!base) throw new AppException('CONF_PERSIST_FAILED');
    if (base.version !== request.baseVersion) {
      throw new AppException('CONF_VERSION_CONFLICT', {
        currentVersion: base.version,
        lastModifiedBy: base.actorId,
        lastModifiedAt: base.createdAt.toISOString(),
      });
    }

    const nextVersion = base.version + 1;
    const previousRows = await this.prisma.systemConfigValue.findMany({
      where: { versionNo: base.version },
    });

    const rows: ValueRow[] = previousRows.map((row) => ({
      key: row.key,
      group: row.group,
      scope: row.scope,
      valueJson: row.valueJson,
      secretRefId: row.secretRefId,
      maskedTail: row.maskedTail,
      configured: row.configured,
      source: row.source,
    }));

    const changeRecords: Array<{
      versionNo: number;
      key: string;
      group: string;
      scope: string;
      beforeValueJson: string | null;
      afterValueJson: string | null;
      applyMode: string;
      actorId: string;
      sourceAddress: string | null;
    }> = [];

    for (const change of request.changes) {
      const definition = CONFIG_ITEM_MAP.get(change.key)!;
      const index = rows.findIndex(
        (row) => row.key === definition.key && row.scope === definition.scope,
      );
      const before = index >= 0 ? rows[index] : null;
      const beforeValue =
        definition.dataType === 'secret_ref'
          ? before?.secretRefId ?? null
          : parseStoredValue(before?.valueJson ?? null);
      const isSecret = definition.dataType === 'secret_ref';
      const ref =
        isSecret && typeof change.value === 'string' && change.value.trim() !== ''
          ? change.value
          : null;
      const next: ValueRow = {
        key: definition.key,
        group: definition.group,
        scope: definition.scope,
        valueJson: isSecret ? null : serializeValue(change.value),
        secretRefId: isSecret ? ref : before?.secretRefId ?? null,
        maskedTail: isSecret ? (ref ? this.vault.tailOf(ref) : null) : before?.maskedTail ?? null,
        configured: isSecret ? Boolean(ref && (await this.vault.exists(ref))) : before?.configured ?? false,
        source: 'page_saved',
      };
      if (index >= 0) rows[index] = next;
      else rows.push(next);

      changeRecords.push({
        versionNo: nextVersion,
        key: definition.key,
        group: definition.group,
        scope: definition.scope,
        beforeValueJson: isSecret ? JSON.stringify(beforeValue) : serializeValue(beforeValue),
        afterValueJson: isSecret ? JSON.stringify(ref) : serializeValue(change.value),
        applyMode: definition.applyMode,
        actorId: actor.userId,
        sourceAddress: actor.sourceAddress ?? null,
      });
    }

    const applyStateByKey = new Map<string, ConfigApplyState>();
    for (const change of request.changes) {
      const definition = CONFIG_ITEM_MAP.get(change.key)!;
      const changed =
        definition.dataType === 'secret_ref'
          ? true
          : JSON.stringify(this.currentValueMap().get(definition.key)) !==
            JSON.stringify(change.value);
      applyStateByKey.set(
        definition.key,
        definition.applyMode === 'restart_required' && changed ? 'pending_restart' : 'applied',
      );
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.systemConfigVersion.create({
          data: {
            version: nextVersion,
            baseVersion: base.version,
            actorId: actor.userId,
            actorRole: actor.roles.join(','),
            reason: request.reason ?? (action === 'save_item' ? '单项保存' : '页面保存'),
            applyState: [...applyStateByKey.values()].includes('pending_restart')
              ? 'pending_restart'
              : 'applied',
            changeCount: request.changes.length,
          },
        });
        await tx.systemConfigValue.createMany({
          data: rows.map((row) => ({ versionNo: nextVersion, ...row })),
        });
        await tx.configChangeRecord.createMany({ data: changeRecords });
      });
    } catch (error) {
      this.logger.error(`配置持久化失败：${error instanceof Error ? error.message : String(error)}`);
      const latest = await this.latestVersionRowWithRetry();
      if (latest && latest.version !== base.version) {
        throw new AppException('CONF_VERSION_CONFLICT', {
          currentVersion: latest.version,
          lastModifiedBy: latest.actorId,
          lastModifiedAt: latest.createdAt.toISOString(),
        });
      }
      throw new AppException('CONF_PERSIST_FAILED');
    }

    await this.audit.record({
      actorId: actor.userId,
      action: `system_config.${action}`,
      objectType: 'system_config',
      objectId: `${group}:v${nextVersion}`,
      detail: {
        group,
        version: nextVersion,
        baseVersion: base.version,
        keys: request.changes.map((change) => change.key),
        sourceAddress: actor.sourceAddress ?? null,
        changes: changeRecords.map((record) => ({
          key: record.key,
          before: record.beforeValueJson,
          after: record.afterValueJson,
        })),
      },
    });

    await this.applyVersion(nextVersion, applyStateByKey, rows);
    await this.resolver.reload();

    const immediateFailed = await this.probeImmediate(request.changes);
    if (immediateFailed.length > 0) {
      await this.autoRevert(base.version, actor);
      throw new AppException('CONF_APPLY_FAILED', {
        revertedToVersion: base.version,
        violations: immediateFailed.map((key) => ({ key, reason: '生效校验失败' })),
      });
    }

    const pendingRestartKeys = this.resolver.pendingRestartKeys();
    const applyState: ConfigApplyState = pendingRestartKeys.length > 0 ? 'pending_restart' : 'applied';
    const results: ConfigSaveItemResult[] = request.changes.map((change) => ({
      key: change.key,
      saved: true,
      applyState: this.resolver.applyStateOf(change.key),
    }));

    const storageChanged =
      group === 'data_storage' &&
      request.changes.some((change) => change.key.startsWith('storage.'));
    const storageImpact = storageChanged ? await this.connections.storageImpact() : null;

    return {
      version: nextVersion,
      saveState: 'saved',
      applyState,
      results,
      pendingRestartKeys,
      affectedScopes: [...new Set(definitions.map((definition) => definition.scope))] as ConfigScope[],
      devIdentityWarning:
        this.resolver.getBoolean('auth.devIdentityEnabled', false) &&
        this.resolver.profile() !== 'prod'
          ? '开发身份模拟中，当前为模拟身份'
          : undefined,
      storageImpact,
    };
  }

  private currentValueMap(): Map<string, ConfigValue> {
    const map = new Map<string, ConfigValue>();
    for (const entry of this.resolver.entries()) {
      map.set(entry.key, entry.definition.dataType === 'secret_ref' ? entry.secretRefId : entry.savedValue);
    }
    return map;
  }

  private async applyVersion(
    versionNo: number,
    applyStateByKey: Map<string, ConfigApplyState>,
    rows: ValueRow[],
  ): Promise<void> {
    for (const [key, desiredState] of applyStateByKey) {
      const entry = this.resolver.entryOf(key);
      const definition = CONFIG_ITEM_MAP.get(key);
      if (!entry || !definition) continue;
      const row = rows.find((candidate) => candidate.key === key);
      const saved =
        definition.dataType === 'secret_ref'
          ? row?.secretRefId ?? null
          : parseStoredValue(row?.valueJson ?? null);
      const runtime =
        desiredState === 'pending_restart'
          ? entry.value
          : saved;
      await this.prisma.configApplyState.upsert({
        where: { key },
        create: {
          key,
          group: definition.group,
          versionNo,
          savedValueJson: serializeValue(saved),
          runtimeValueJson: serializeValue(runtime),
          applyState: desiredState,
          pendingRestartAt: desiredState === 'pending_restart' ? new Date() : null,
          runtimeMismatch: desiredState === 'pending_restart',
        },
        update: {
          versionNo,
          savedValueJson: serializeValue(saved),
          runtimeValueJson: serializeValue(runtime),
          applyState: desiredState,
          pendingRestartAt: desiredState === 'pending_restart' ? new Date() : null,
          runtimeMismatch: desiredState === 'pending_restart',
        },
      });
    }
  }

  private async probeImmediate(changes: ConfigChangeInput[]): Promise<string[]> {
    const failed: string[] = [];
    const immediateKeys = changes
      .map((change) => change.key)
      .filter((key) => CONFIG_ITEM_MAP.get(key)?.applyMode === 'immediate');
    if (immediateKeys.length === 0) return failed;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      failed.push(...immediateKeys);
      return failed;
    }
    if (immediateKeys.includes('model.secretRef')) {
      const ref = this.resolver.get<string | null>('model.secretRef', null);
      if (this.resolver.getBoolean('model.enabled', false) && !(await this.vault.exists(ref))) {
        failed.push('model.secretRef');
      }
    }
    return failed;
  }

  private async autoRevert(targetVersion: number, actor: ActorContext): Promise<void> {
    try {
      await this.rollbackTo(targetVersion, actor, '立即生效校验失败，自动回退');
    } catch (error) {
      this.logger.error(
        `自动回退到 v${targetVersion} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async versions(group?: string, limit = 20): Promise<ConfigVersionSummary[]> {
    const rows = await this.prisma.systemConfigVersion.findMany({
      where: group && isConfigGroup(group) ? {} : {},
      orderBy: { version: 'desc' },
      take: Math.max(10, Math.min(limit, 100)),
    });
    const latest = this.resolver.snapshotVersion();
    return rows.map((row) => ({
      version: row.version,
      baseVersion: row.baseVersion,
      actorId: row.actorId,
      actorRole: row.actorRole,
      reason: row.reason,
      applyState: row.applyState as ConfigApplyState,
      changeCount: row.changeCount,
      createdAt: row.createdAt.toISOString(),
      rollbackable: row.version <= latest && latest - row.version <= 9,
    }));
  }

  async versionDetail(versionNo: number): Promise<{ version: number; changes: ConfigVersionChange[] }> {
    const version = await this.prisma.systemConfigVersion.findUnique({ where: { version: versionNo } });
    if (!version) throw new AppException('RESOURCE_NOT_FOUND');
    const changes = await this.prisma.configChangeRecord.findMany({ where: { versionNo } });
    return {
      version: version.version,
      changes: changes.map((row) => ({
        key: row.key,
        group: row.group as ConfigGroup,
        scope: row.scope as ConfigScope,
        beforeValue: parseStoredValue(row.beforeValueJson),
        afterValue: parseStoredValue(row.afterValueJson),
        applyMode: row.applyMode as ConfigVersionChange['applyMode'],
        securityImpact: isSecuritySwitch(row.key),
      })),
    };
  }

  async diff(versionNo: number, against?: number): Promise<ConfigVersionDiff> {
    const againstVersion = against ?? this.resolver.snapshotVersion();
    const [left, right] = await Promise.all([
      this.prisma.systemConfigValue.findMany({ where: { versionNo } }),
      this.prisma.systemConfigValue.findMany({ where: { versionNo: againstVersion } }),
    ]);
    const leftMap = new Map(left.map((row) => [`${row.key}:${row.scope}`, row]));
    const rightMap = new Map(right.map((row) => [`${row.key}:${row.scope}`, row]));
    const added: ConfigVersionChange[] = [];
    const modified: ConfigVersionChange[] = [];
    const removed: ConfigVersionChange[] = [];
    for (const [composite, row] of leftMap) {
      const definition = CONFIG_ITEM_MAP.get(row.key);
      if (!definition) continue;
      const other = rightMap.get(composite);
      const valueOf = (candidate: typeof row | undefined): unknown =>
        !candidate
          ? null
          : definition.dataType === 'secret_ref'
            ? candidate.secretRefId
            : parseStoredValue(candidate.valueJson);
      const entry: ConfigVersionChange = {
        key: row.key,
        group: row.group as ConfigGroup,
        scope: row.scope as ConfigScope,
        beforeValue: valueOf(other),
        afterValue: valueOf(row),
        applyMode: definition.applyMode,
        securityImpact: isSecuritySwitch(row.key),
      };
      if (!other) added.push(entry);
      else if (JSON.stringify(entry.beforeValue) !== JSON.stringify(entry.afterValue)) modified.push(entry);
    }
    for (const [composite, row] of rightMap) {
      if (leftMap.has(composite)) continue;
      const definition = CONFIG_ITEM_MAP.get(row.key);
      if (!definition) continue;
      removed.push({
        key: row.key,
        group: row.group as ConfigGroup,
        scope: row.scope as ConfigScope,
        beforeValue: definition.dataType === 'secret_ref' ? row.secretRefId : parseStoredValue(row.valueJson),
        afterValue: null,
        applyMode: definition.applyMode,
        securityImpact: isSecuritySwitch(row.key),
      });
    }
    return {
      version: versionNo,
      against: againstVersion,
      added,
      modified,
      removed,
      pendingRestartKeys: modified
        .filter((entry) => entry.applyMode === 'restart_required')
        .map((entry) => entry.key),
      securityImpactKeys: modified
        .filter((entry) => entry.securityImpact)
        .map((entry) => entry.key),
    };
  }

  async rollback(
    request: ConfigRollbackRequest,
    actor: ActorContext,
  ): Promise<ConfigSaveResult> {
    this.assertAdmin(actor);
    if (!request.confirmed) {
      throw new AppException('CONF_ROLLBACK_FAILED', {
        violations: [{ key: '', reason: '缺少二次确认' }],
      });
    }
    const latestVersion = this.resolver.snapshotVersion();
    if (request.baseVersion !== latestVersion) {
      throw new AppException('CONF_VERSION_CONFLICT', {
        currentVersion: latestVersion,
        lastModifiedBy: this.resolver.lastModifiedBy(),
        lastModifiedAt: this.resolver.lastModifiedAt(),
      });
    }
    return this.rollbackTo(request.targetVersion, actor, '页面回滚');
  }

  private async rollbackTo(
    targetVersion: number,
    actor: ActorContext,
    reason: string,
  ): Promise<ConfigSaveResult> {
    await this.resolver.ready();
    const target = await this.prisma.systemConfigVersion.findUnique({
      where: { version: targetVersion },
    });
    if (!target) {
      throw new AppException('CONF_ROLLBACK_FAILED', {
        violations: [{ key: '', reason: '目标版本不存在' }],
      });
    }
    const latest = this.resolver.snapshotVersion();
    if (latest - targetVersion > 9) {
      throw new AppException('CONF_ROLLBACK_FAILED', {
        violations: [{ key: '', reason: '仅保留最近 10 个可回滚版本' }],
      });
    }
    const targetRows = await this.prisma.systemConfigValue.findMany({
      where: { versionNo: targetVersion },
    });

    const violations: ConfigViolation[] = [];
    const targetMap = new Map<string, ConfigValue>();
    for (const row of targetRows) {
      const definition = CONFIG_ITEM_MAP.get(row.key);
      if (!definition) continue;
      const value =
        definition.dataType === 'secret_ref'
          ? row.secretRefId
          : parseStoredValue(row.valueJson);
      targetMap.set(row.key, value);
      const violation = validateValue(definition, value, {
        profile: this.resolver.profile(),
        isChanged: false,
      });
      if (violation) violations.push(violation);
      if (definition.dataType === 'secret_ref' && value && !(await this.vault.exists(String(value)))) {
        violations.push({
          key: definition.key,
          reason: '目标版本引用的凭据已失效',
          code: 'CONF_CREDENTIAL_MISSING',
        });
      }
    }
    violations.push(...validateCrossItems(targetMap));
    if (violations.length > 0) {
      throw new AppException('CONF_ROLLBACK_FAILED', { targetVersion, violations });
    }

    const nextVersion = latest + 1;
    const nextRows: ValueRow[] = targetRows.map((row) => ({
      key: row.key,
      group: row.group,
      scope: row.scope,
      valueJson: row.valueJson,
      secretRefId: row.secretRefId,
      maskedTail: row.maskedTail,
      configured: row.configured,
      source: row.source,
    }));

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.systemConfigVersion.create({
          data: {
            version: nextVersion,
            baseVersion: latest,
            actorId: actor.userId,
            actorRole: actor.roles.join(','),
            reason,
            applyState: 'applied',
            changeCount: nextRows.length,
          },
        });
        await tx.systemConfigValue.createMany({
          data: nextRows.map((row) => ({ versionNo: nextVersion, ...row })),
        });
        await tx.configRollbackRecord.create({
          data: {
            sourceVersion: latest,
            targetVersion,
            resultVersion: nextVersion,
            resultsJson: JSON.stringify({ restored: nextRows.length }),
            actorId: actor.userId,
          },
        });
      });
    } catch (error) {
      this.logger.error(
        `配置回滚持久化失败：${error instanceof Error ? error.message : String(error)}`,
      );
      const latestRow = await this.latestVersionRowWithRetry();
      if (latestRow && latestRow.version > latest) {
        throw new AppException('CONF_VERSION_CONFLICT', {
          currentVersion: latestRow.version,
          lastModifiedBy: latestRow.actorId,
          lastModifiedAt: latestRow.createdAt.toISOString(),
        });
      }
      throw new AppException('CONF_PERSIST_FAILED');
    }

    await this.audit.record({
      actorId: actor.userId,
      action: 'system_config.rollback',
      objectType: 'system_config',
      objectId: `v${nextVersion}`,
      detail: { sourceVersion: latest, targetVersion, resultVersion: nextVersion },
    });

    const restartKeys = nextRows
      .filter((row) => {
        const definition = CONFIG_ITEM_MAP.get(row.key);
        if (definition?.applyMode !== 'restart_required') return false;
        const entry = this.resolver.entryOf(row.key);
        const nextValue =
          definition.dataType === 'secret_ref' ? row.secretRefId : parseStoredValue(row.valueJson);
        return JSON.stringify(entry?.value ?? null) !== JSON.stringify(nextValue);
      })
      .map((row) => row.key);
    const applyStates = new Map<string, ConfigApplyState>(
      nextRows.map((row) => [row.key, restartKeys.includes(row.key) ? 'pending_restart' : 'applied']),
    );
    await this.applyVersion(nextVersion, applyStates, nextRows);
    await this.resolver.reload();

    return {
      version: nextVersion,
      saveState: 'saved',
      applyState: restartKeys.length > 0 ? 'pending_restart' : 'applied',
      results: nextRows.map((row) => ({
        key: row.key,
        saved: true,
        applyState: applyStates.get(row.key) ?? 'applied',
      })),
      pendingRestartKeys: restartKeys,
      affectedScopes: [...new Set(nextRows.map((row) => row.scope))] as ConfigScope[],
    };
  }

  async writeCredential(
    secretRefId: string | null,
    body: { plaintext: string; purpose?: string },
    actor: ActorContext,
  ): Promise<{ secretRefId: string; maskedTail: string; configured: true; lastUpdatedAt: string }> {
    this.assertAdmin(actor);
    if (!body.plaintext || body.plaintext.trim().length === 0) {
      throw new AppException('CONF_CREDENTIAL_MISSING');
    }
    if (secretRefId) {
      const existing = await this.vault.exists(secretRefId);
      if (!existing) throw new AppException('CONF_CREDENTIAL_MISSING');
    }
    const result = await this.vault.write({
      secretRefId: undefined,
      purpose: body.purpose ?? 'system_config',
      plaintext: body.plaintext,
    });
    await this.audit.record({
      actorId: actor.userId,
      action: 'system_config.credential_write',
      objectType: 'system_config',
      objectId: result.secretRefId,
      detail: {
        previousRef: secretRefId,
        maskedTail: result.maskedTail,
        sourceAddress: actor.sourceAddress ?? null,
      },
    });
    return result;
  }

  async revokeCredential(secretRefId: string, actor: ActorContext): Promise<{ revoked: true }> {
    this.assertAdmin(actor);
    const referenced = await this.prisma.systemConfigValue.findFirst({
      where: { secretRefId, versionNo: this.resolver.snapshotVersion() },
    });
    if (referenced) throw new AppException('CONF_CREDENTIAL_IN_USE');
    if (!(await this.vault.exists(secretRefId))) throw new AppException('CONF_CREDENTIAL_MISSING');
    await this.vault.revoke(secretRefId);
    await this.audit.record({
      actorId: actor.userId,
      action: 'system_config.credential_revoke',
      objectType: 'system_config',
      objectId: secretRefId,
    });
    return { revoked: true };
  }

  async readinessView() {

    return this.readiness.current();
  }

  async recomputeReadiness() {
    return this.readiness.recompute();
  }

  async configurationHealth(): Promise<SystemConfigurationHealth> {
    const groups = Object.keys(CONFIG_GROUP_META) as ConfigGroup[];
    const sources = {} as Record<ConfigGroup, ConfigSource[]>;
    for (const group of groups) {
      const entries = this.resolver.groupEntries(group);
      sources[group] = [...new Set(entries.map((entry) => entry.source))];
    }
    return {
      version: this.resolver.snapshotVersion(),
      sources,
      applyStates: [...new Set(this.resolver.entries().map((entry) => entry.applyState))],
      runtimeMismatchKeys: this.resolver.runtimeMismatchKeys(),
      pendingRestartKeys: this.resolver.pendingRestartKeys(),
      devIdentityEnabled: this.resolver.getBoolean('auth.devIdentityEnabled', false),
      readiness: await this.readiness.overall(),
      asOf: new Date().toISOString(),
      runtimeProvenance: {
        configVersion: this.resolver.snapshotVersion(),
        loadedAt: this.resolver.loadedAt() ?? new Date().toISOString(),
        snapshotFingerprint: this.resolver.snapshotFingerprint(),
        itemSources: Object.fromEntries(
          this.resolver.entries().map((entry) => [entry.key, entry.source]),
        ) as Record<string, ConfigSource>,
      },
      connectionState: await this.connections.provenance(),
    };
  }

  private async latestVersionRowWithRetry() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 60 * attempt));
      }
      const latest = await this.prisma.systemConfigVersion
        .findFirst({ orderBy: { version: 'desc' } })
        .catch(() => null);
      if (latest) return latest;
    }
    return null;
  }

  private async loadIdempotent(scope: string, key: string): Promise<unknown | null> {
    const row = await this.prisma.idempotencyRecord.findUnique({ where: { key: `${scope}:${key}` } });
    if (!row || row.status !== 'completed' || !row.resultJson) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;
    return JSON.parse(row.resultJson) as unknown;
  }

  private async storeIdempotent(scope: string, key: string, result: unknown): Promise<void> {
    await this.prisma.idempotencyRecord.upsert({
      where: { key: `${scope}:${key}` },
      create: {
        key: `${scope}:${key}`,
        scope,
        status: 'completed',
        resultJson: JSON.stringify(result),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      update: {
        status: 'completed',
        resultJson: JSON.stringify(result),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  }
}
