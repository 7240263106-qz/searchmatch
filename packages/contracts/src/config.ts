export const CONFIG_GROUP = [
  'service_env',
  'auth_identity',
  'data_storage',
  'python_parser',
  'model_access',
  'crawl_runtime',
  'retention_audit',
  'security_switches',
] as const;
export type ConfigGroup = (typeof CONFIG_GROUP)[number];

export const CONFIG_PAGE = [
  'service_env',
  'data_storage',
  'python_parser',
  'model_access',
  'crawl_runtime',
  'retention_audit',
  'versions',
] as const;
export type ConfigPageKey = (typeof CONFIG_PAGE)[number];

export const CONFIG_GROUP_META: Record<
  ConfigGroup,
  { label: string; page: ConfigPageKey; description: string }
> = {
  service_env: { label: '服务与环境', page: 'service_env', description: '监听地址、端口、对外基地址与前端来源' },
  auth_identity: { label: '认证与开发身份', page: 'service_env', description: '身份服务、令牌有效期与开发身份模拟' },
  data_storage: { label: '数据存储', page: 'data_storage', description: '数据库与对象存储连接、凭据与访问策略' },
  python_parser: { label: 'Python 解析服务', page: 'python_parser', description: '解析服务地址、超时、并发与降级策略' },
  model_access: { label: '模型接入', page: 'model_access', description: '模型服务、凭据、超时配额与任务分配' },
  crawl_runtime: { label: '采集运行', page: 'crawl_runtime', description: '采集总开关、间隔、并发、渠道适配与体积上限' },
  retention_audit: { label: '留存与审计', page: 'retention_audit', description: '留存期限、告警阈值、审计范围与安全开关' },
  security_switches: { label: '安全开关', page: 'retention_audit', description: '五项强制开启的只读安全能力' },
};

export const CONFIG_SCOPE = ['locked', 'deployment', 'team'] as const;
export type ConfigScope = (typeof CONFIG_SCOPE)[number];

export const CONFIG_SOURCE = ['page_saved', 'env_default', 'builtin_default', 'locked'] as const;
export type ConfigSource = (typeof CONFIG_SOURCE)[number];
export const CONFIG_SOURCE_META: Record<ConfigSource, string> = {
  page_saved: '页面保存值',
  env_default: '环境默认值',
  builtin_default: '内置默认值',
  locked: '强制只读',
};

export const CONFIG_APPLY_MODE = ['immediate', 'next_task', 'restart_required', 'immutable'] as const;
export type ConfigApplyMode = (typeof CONFIG_APPLY_MODE)[number];
export const CONFIG_APPLY_MODE_META: Record<ConfigApplyMode, string> = {
  immediate: '立即生效',
  next_task: '下次任务生效',
  restart_required: '需重启生效',
  immutable: '不可变更',
};

export const CONFIG_APPLY_STATE = [
  'applied',
  'pending_restart',
  'partially_applied',
  'apply_failed',
] as const;
export type ConfigApplyState = (typeof CONFIG_APPLY_STATE)[number];
export const CONFIG_APPLY_STATE_META: Record<ConfigApplyState, string> = {
  applied: '已生效',
  pending_restart: '待重启',
  partially_applied: '部分生效',
  apply_failed: '生效校验失败',
};

export const CONFIG_DATA_TYPE = [
  'string',
  'int',
  'number',
  'bool',
  'enum',
  'string_array',
  'url',
  'path',
  'secret_ref',
] as const;
export type ConfigDataType = (typeof CONFIG_DATA_TYPE)[number];

export const CONFIG_TEST_TARGET = [
  'database',
  'object_storage',
  'python_parser',
  'model_service',
  'public_base_url',
] as const;
export type ConfigTestTarget = (typeof CONFIG_TEST_TARGET)[number];

export const CONFIG_TEST_RESULT = [
  'success',
  'auth_failed',
  'unreachable',
  'timeout',
  'certificate_error',
  'protocol_unsupported',
  'target_refused',
] as const;
export type ConfigTestResultCode = (typeof CONFIG_TEST_RESULT)[number];

export const CONFIG_READINESS_OVERALL = ['ready', 'ready_rule_mode', 'not_ready'] as const;
export type ConfigReadinessOverall = (typeof CONFIG_READINESS_OVERALL)[number];

export const CONFIG_READINESS_STATE = [
  'ready',
  'optional_not_configured',
  'degraded',
  'not_ready',
  'disabled',
] as const;
export type ConfigReadinessState = (typeof CONFIG_READINESS_STATE)[number];

export interface ConfigItemView {
  key: string;
  group: ConfigGroup;
  label: string;
  description: string;
  dataType: ConfigDataType;
  scope: ConfigScope;
  source: ConfigSource;
  applyMode: ConfigApplyMode;
  applyState: ConfigApplyState;
  required: boolean;
  editable: boolean;
  unit?: string;
  allowedRange?: string;
  enumValues?: string[];
  effectiveValue: string | number | boolean | string[] | null;
  deploymentValue: string | number | boolean | string[] | null;
  teamValue: string | number | boolean | string[] | null;
  configured?: boolean;
  maskedTail?: string | null;
  lastUpdatedAt?: string | null;
  runtimeMismatch: boolean;
  lockedReason?: string;
  runtimeConnection?: RuntimeConnectionView | null;
}

export interface RuntimeConnectionView {
  kind: 'database' | 'object_storage';
  targetMasked: string;
  configVersion: number;
  connectedAt: string;
  tlsEnabled: boolean | null;
  status: 'ready' | 'degraded' | 'not_enabled' | 'failed';
  lastFailure: string | null;
  detail?: string;
}

export interface ClientBaseView {
  apiBaseUrl: string;
  source: 'configured' | 'same_origin';
  configVersion: number;
  issuedAt: string;
  cacheMaxAgeSeconds: number;
  stale: boolean;
}

export interface ClientBootstrapInfo {
  apiBaseUrl: string;
  apiBaseSource: 'configured' | 'same_origin';
  configVersion: number;
  profile: string;
  devIdentityAllowed: boolean;
  issuedAt: string;
  cacheMaxAgeSeconds: number;
  snapshotFingerprint?: string;
}

export interface ConfigGateViolation {
  file: string;
  line: number;
  variable: string;
  type: string;
}

export interface ConfigGateReport {
  scannedAt: string;
  scope: string[];
  durationMs: number;
  whitelist: Array<{ file: string; variable: string; purpose: string; approvedBy: string }>;
  violations: ConfigGateViolation[];
  sameSourceAssertion: {
    passed: boolean;
    versions: { page: number; health: number; log: number };
    fingerprint: string;
  };
  evidencePath: string;
  passed: boolean;
}

export interface ConfigGroupView {
  group: ConfigGroup;
  label: string;
  page: ConfigPageKey;
  description: string;
  version: number;
  lastModifiedBy: string | null;
  lastModifiedAt: string | null;
  pendingRestartKeys: string[];
  items: ConfigItemView[];
}

export interface ConfigOverview {
  version: number;
  lastModifiedBy: string | null;
  lastModifiedAt: string | null;
  groups: Array<{
    group: ConfigGroup;
    label: string;
    page: ConfigPageKey;
    itemCount: number;
    pendingRestartCount: number;
    applyFailedCount: number;
    runtimeMismatchCount: number;
  }>;
  pendingRestartKeys: string[];
  applyFailedKeys: string[];
  runtimeMismatchKeys: string[];
  devIdentityEnabled: boolean;
  devIdentityProfile: string;
  readiness: ConfigReadinessView | null;
  snapshotFingerprint?: string;
  loadedAt?: string;
  connectionProvenance?: {
    database: RuntimeConnectionView;
    objectStorage: RuntimeConnectionView;
  };
  clientBase?: ClientBaseView;
}

export interface ConfigChangeInput {
  key: string;
  value: string | number | boolean | string[] | null;
  applyToExistingSources?: boolean;
  confirmScope?: string[];
}

export interface ConfigSaveRequest {
  baseVersion: number;
  changes: ConfigChangeInput[];
  confirmToken?: 'APPLY_TO_EXISTING_SOURCES' | 'RESTART_ACKNOWLEDGED';
  reason?: string;
}

export interface ConfigSaveItemResult {
  key: string;
  saved: boolean;
  applyState: ConfigApplyState;
  reason?: string;
  allowedRange?: string;
}

export interface ConfigSaveResult {
  version: number;
  saveState: 'saved';
  applyState: ConfigApplyState;
  results: ConfigSaveItemResult[];
  pendingRestartKeys: string[];
  affectedScopes: ConfigScope[];
  devIdentityWarning?: string;
  storageImpact?: {
    affectedArtifacts: number;
    message: string;
  } | null;
}

export interface ConfigTestRequest {
  target: ConfigTestTarget;
  address?: string;
  secretRef?: string;
  realNetworkRequired?: boolean;
  innerNetworkException?: {
    purpose: string;
    confirmedBy: string;
    expiresAt: string;
  };
}

export interface ConfigTestResult {
  target: ConfigTestTarget;
  maskedAddress: string;
  durationMs: number;
  result: ConfigTestResultCode;
  suggestion: string;
  cooldownSeconds: number;
  testedAt?: string;
  validUntil?: string;
  lastTestedAt?: string | null;
  evidence?: {
    requestedAt: string;
    realOutbound: boolean;
    egressRoute: string;
    cacheAgeSeconds: number;
  };
}

export interface ConfigVersionSummary {
  version: number;
  baseVersion: number | null;
  actorId: string;
  actorRole: string | null;
  reason: string | null;
  applyState: ConfigApplyState;
  changeCount: number;
  createdAt: string;
  rollbackable: boolean;
}

export interface ConfigVersionChange {
  key: string;
  group: ConfigGroup;
  scope: ConfigScope;
  beforeValue: unknown;
  afterValue: unknown;
  applyMode: ConfigApplyMode;
  securityImpact: boolean;
}

export interface ConfigVersionDiff {
  version: number;
  against: number;
  added: ConfigVersionChange[];
  modified: ConfigVersionChange[];
  removed: ConfigVersionChange[];
  pendingRestartKeys: string[];
  securityImpactKeys: string[];
}

export interface ConfigRollbackRequest {
  targetVersion: number;
  baseVersion: number;
  confirmed: boolean;
}

export interface ConfigReadinessItem {
  key: 'service_address' | 'data_storage' | 'python_parser' | 'model_access' | 'source' | 'crawl_switch';
  label: string;
  required: boolean;
  state: ConfigReadinessState;
  fixPath: string;
  detail: string;
}

export interface ConfigReadinessView {
  overall: ConfigReadinessOverall;
  items: ConfigReadinessItem[];
  computedAt: string;
}

export interface SystemConfigurationHealth {
  version: number;
  sources: Record<ConfigGroup, ConfigSource[]>;
  applyStates: ConfigApplyState[];
  runtimeMismatchKeys: string[];
  pendingRestartKeys: string[];
  devIdentityEnabled: boolean;
  readiness: ConfigReadinessOverall;
  asOf: string;
  runtimeProvenance?: {
    configVersion: number;
    loadedAt: string;
    snapshotFingerprint: string;
    itemSources: Record<string, ConfigSource>;
  };
  connectionState?: {
    database: RuntimeConnectionView;
    objectStorage: RuntimeConnectionView;
  };
}