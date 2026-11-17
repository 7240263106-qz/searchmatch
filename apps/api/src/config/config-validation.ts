import type { ConfigValue } from './config-items';
import {
  CONFIG_ITEM_MAP,
  isSecuritySwitch,
  type ConfigItemDefinition,
} from './config-items';

export interface ConfigViolation {
  key: string;
  reason: string;
  allowedRange?: string;
  code?:
    | 'CONF_VALUE_INVALID'
    | 'CONF_SECURITY_SWITCH_LOCKED'
    | 'CONF_ADDRESS_FORBIDDEN'
    | 'CONF_DEV_IDENTITY_FORBIDDEN'
    | 'CONF_CREDENTIAL_MISSING';
}

export interface AddressCheckOptions {
  allowLoopbackInDev?: boolean;
  innerNetworkException?: boolean;
}

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^127\./,
  /^7\d{2}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/,
];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

export function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

export function describeAllowed(mode: 'url' | 'path' | 'string'): string {
  if (mode === 'url') return '仅允许 http:// 或 https:// 地址';
  if (mode === 'path') return '以 / 开头，不含查询串与片段';
  return '';
}

export function checkAddress(value: string, options: AddressCheckOptions = {}): string | null {
  const url = parseHttpUrl(value);
  if (!url) return '仅允许 http/https 地址，且必须是合法 URL';
  const host = url.hostname.toLowerCase();
  if (options.innerNetworkException) return null;
  if (METADATA_HOSTS.has(host)) return '禁止访问云元数据地址';
  const isLoopback = LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
  if (isLoopback) {
    return options.allowLoopbackInDev ? null : '默认禁止访问回环地址';
  }
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    return '默认禁止访问内网、回环与链路本地地址';
  }
  if (host === '0.0.0.0' || host === '::' || host === '[::]') return '禁止使用通配监听/访问地址';
  if (url.protocol === 'http:') return '生产与非例外场景不允许明文 HTTP 降级';
  return null;
}

function typeViolation(definition: ConfigItemDefinition, value: unknown): string | null {
  switch (definition.dataType) {
    case 'int':
      return Number.isInteger(value) ? null : '必须是整数';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : '必须是数字';
    case 'bool':
      return typeof value === 'boolean' ? null : '必须是布尔值';
    case 'enum':
      return typeof value === 'string' && (definition.enumValues ?? []).includes(value)
        ? null
        : `必须是以下值之一：${(definition.enumValues ?? []).join(' / ')}`;
    case 'string_array':
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? null
        : '必须是字符串数组';
    case 'secret_ref':
      return value === null || typeof value === 'string' ? null : '必须是凭据引用或 null';
    case 'url':
    case 'path':
    case 'string':
    default:
      return typeof value === 'string' ? null : '必须是字符串';
  }
}

export function rangeOf(definition: ConfigItemDefinition): string | undefined {
  if (definition.min !== undefined && definition.max !== undefined) {
    return `${definition.min}–${definition.max}${definition.unit ? ` ${definition.unit}` : ''}`;
  }
  if (definition.min !== undefined) return `≥ ${definition.min}`;
  if (definition.max !== undefined) return `≤ ${definition.max}`;
  if (definition.enumValues?.length) return definition.enumValues.join(' / ');
  return undefined;
}

export function validateValue(
  definition: ConfigItemDefinition,
  value: ConfigValue,
  options: { profile: 'dev' | 'test' | 'prod'; isChanged: boolean },
): ConfigViolation | null {
  const allowedRange = rangeOf(definition);

  if (isSecuritySwitch(definition.key)) {
    if (value !== true) {
      return {
        key: definition.key,
        reason: '安全开关为强制开启，服务端拒绝关闭请求',
        code: 'CONF_SECURITY_SWITCH_LOCKED',
      };
    }
  }

  if ((definition.scope === 'locked' || definition.readOnly) && options.isChanged) {
    return {
      key: definition.key,
      reason: definition.lockedReason ?? '该配置项只读，不能通过页面修改',
      allowedRange,
      code: 'CONF_VALUE_INVALID',
    };
  }

  const typeError = typeViolation(definition, value);
  if (typeError) {
    return { key: definition.key, reason: typeError, allowedRange, code: 'CONF_VALUE_INVALID' };
  }

  if (
    definition.required &&
    definition.dataType !== 'secret_ref' &&
    (value === null || value === '' || (Array.isArray(value) && value.length === 0))
  ) {
    return {
      key: definition.key,
      reason: '该配置项为必填项',
      allowedRange,
      code: 'CONF_VALUE_INVALID',
    };
  }

  if (typeof value === 'number') {
    if (definition.min !== undefined && value < definition.min) {
      return {
        key: definition.key,
        reason: `取值低于允许下限 ${definition.min}`,
        allowedRange,
        code: 'CONF_VALUE_INVALID',
      };
    }
    if (definition.max !== undefined && value > definition.max) {
      return {
        key: definition.key,
        reason: `取值高于允许上限 ${definition.max}`,
        allowedRange,
        code: 'CONF_VALUE_INVALID',
      };
    }
  }

  if (definition.dataType === 'url' && typeof value === 'string' && value !== '') {
    const addressError = checkAddress(value, {
      allowLoopbackInDev: options.profile !== 'prod',
    });
    if (addressError) {
      return {
        key: definition.key,
        reason: addressError,
        allowedRange: '合法 http/https 地址，且不得指向内网或云元数据',
        code: 'CONF_ADDRESS_FORBIDDEN',
      };
    }
  }

  if (definition.dataType === 'path' && typeof value === 'string') {
    if (!value.startsWith('/') || value.includes('?') || value.includes('#')) {
      return {
        key: definition.key,
        reason: '路径必须以 / 开头且不含查询串或片段',
        allowedRange: describeAllowed('path'),
        code: 'CONF_VALUE_INVALID',
      };
    }
  }

  if (definition.key === 'server.corsOrigins' && Array.isArray(value)) {
    for (const origin of value) {
      if (origin === '*') {
        return {
          key: definition.key,
          reason: '不允许使用通配来源 *',
          allowedRange: '逐项合法的 http/https origin',
          code: 'CONF_VALUE_INVALID',
        };
      }
      const parsed = parseHttpUrl(origin);
      if (!parsed || parsed.origin !== origin) {
        return {
          key: definition.key,
          reason: `来源 ${origin} 不是合法的 origin`,
          allowedRange: '例如 http://localhost:5173',
          code: 'CONF_VALUE_INVALID',
        };
      }
    }
  }

  if (definition.key === 'audit.scope' && Array.isArray(value)) {
    const required = ['auth', 'config', 'review', 'publish', 'delete', 'verification', 'model'];
    const missing = required.filter((entry) => !value.includes(entry));
    if (missing.length > 0) {
      return {
        key: definition.key,
        reason: `审计范围不得移除关键动作：${missing.join('、')}`,
        allowedRange: required.join(' / '),
        code: 'CONF_VALUE_INVALID',
      };
    }
  }

  if (
    definition.key === 'auth.devIdentityEnabled' &&
    value === true &&
    options.profile === 'prod'
  ) {
    return {
      key: definition.key,
      reason: '生产环境不允许启用开发身份模拟',
      code: 'CONF_DEV_IDENTITY_FORBIDDEN',
    };
  }

  if (definition.key === 'storage.accessPolicy' && value === 'public') {
    return {
      key: definition.key,
      reason: '对象存储访问策略禁止设为 public',
      allowedRange: 'private / readonly',
      code: 'CONF_VALUE_INVALID',
    };
  }

  return null;
}

export function validateCrossItems(values: ReadonlyMap<string, ConfigValue>): ConfigViolation[] {
  const violations: ConfigViolation[] = [];
  const num = (key: string): number | null => {
    const value = values.get(key);
    return typeof value === 'number' ? value : null;
  };

  const min = num('crawl.intervalMinSeconds');
  const max = num('crawl.intervalMaxSeconds');
  const fallback = num('crawl.defaultIntervalSeconds');
  if (min !== null && max !== null && min >= max) {
    violations.push({
      key: 'crawl.intervalMinSeconds',
      reason: '间隔下限必须小于间隔上限',
      allowedRange: `小于 ${max}`,
      code: 'CONF_VALUE_INVALID',
    });
  }
  if (min !== null && max !== null && fallback !== null && (fallback < min || fallback > max)) {
    violations.push({
      key: 'crawl.defaultIntervalSeconds',
      reason: '默认采集间隔必须落在间隔区间内',
      allowedRange: `${min}–${max}`,
      code: 'CONF_VALUE_INVALID',
    });
  }

  const auditDays = num('retention.auditLogDays');
  const snapshotDays = num('retention.snapshotDays');
  const documentDays = num('retention.documentDays');
  if (auditDays !== null) {
    const floor = Math.max(snapshotDays ?? 0, documentDays ?? 0);
    if (auditDays < floor) {
      violations.push({
        key: 'retention.auditLogDays',
        reason: '审计日志留存不得短于其他追溯期限',
        allowedRange: `≥ ${floor} 天`,
        code: 'CONF_VALUE_INVALID',
      });
    }
  }

  const modelEnabled = values.get('model.enabled') === true;
  if (modelEnabled) {
    const baseUrl = values.get('model.baseUrl');
    const model = values.get('model.model');
    const secretRef = values.get('model.secretRef');
    if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
      violations.push({
        key: 'model.baseUrl',
        reason: '启用模型接入前必须填写服务地址',
        code: 'CONF_VALUE_INVALID',
      });
    }
    if (typeof model !== 'string' || model.trim() === '') {
      violations.push({
        key: 'model.model',
        reason: '启用模型接入前必须填写模型标识',
        code: 'CONF_VALUE_INVALID',
      });
    }
    if (typeof secretRef !== 'string' || secretRef.trim() === '') {
      violations.push({
        key: 'model.secretRef',
        reason: '启用模型接入前必须配置可用凭据',
        code: 'CONF_CREDENTIAL_MISSING',
      });
    }
  }

  const profile = values.get('env.profile');
  if (profile === 'prod' && values.get('auth.devIdentityEnabled') === true) {
    violations.push({
      key: 'auth.devIdentityEnabled',
      reason: '生产环境不允许启用开发身份模拟',
      code: 'CONF_DEV_IDENTITY_FORBIDDEN',
    });
  }

  const accessPolicy = values.get('storage.accessPolicy');
  if (accessPolicy === 'public') {
    violations.push({
      key: 'storage.accessPolicy',
      reason: '对象存储访问策略禁止设为 public',
      allowedRange: 'private / readonly',
      code: 'CONF_VALUE_INVALID',
    });
  }

  return violations;
}

export function definitionsOf(keys: readonly string[]): ConfigItemDefinition[] {
  return keys
    .map((key) => CONFIG_ITEM_MAP.get(key))
    .filter((entry): entry is ConfigItemDefinition => Boolean(entry));
}