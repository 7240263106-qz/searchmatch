import { describe, expect, it } from 'vitest';
import { CONFIG_ITEMS, CONFIG_ITEM_MAP, SECURITY_SWITCH_KEYS, configItemsOfGroup } from './config-items';
import { checkAddress, validateCrossItems, validateValue } from './config-validation';
import { maskAddress } from './config-test.service';

const dev = { profile: 'dev' as const, isChanged: true };

describe('配置项定义清单', () => {
  it('八分组齐全且无竞赛业务条目', () => {
    const groups = new Set(CONFIG_ITEMS.map((item) => item.group));
    expect([...groups].sort()).toEqual(
      [
        'auth_identity',
        'crawl_runtime',
        'data_storage',
        'model_access',
        'python_parser',
        'retention_audit',
        'security_switches',
        'service_env',
      ].sort(),
    );
    for (const item of CONFIG_ITEMS) {
      expect(item.key).not.toMatch(/competition|deadline|signupUrl/i);
      expect(item.description).not.toMatch(/报名时间|报名入口地址|竞赛名称/);
    }
  });

  it('五项强制安全开关恒为 true 且不可编辑', () => {
    expect(SECURITY_SWITCH_KEYS).toHaveLength(5);
    for (const key of SECURITY_SWITCH_KEYS) {
      const item = CONFIG_ITEM_MAP.get(key)!;
      expect(item.defaultValue).toBe(true);
      expect(item.scope).toBe('locked');
      expect(item.applyMode).toBe('immutable');
    }
  });

  it('采集运行与留存分组均包含关键项', () => {
    expect(configItemsOfGroup('crawl_runtime').some((item) => item.key === 'crawl.enabled')).toBe(true);
    expect(configItemsOfGroup('retention_audit').some((item) => item.key === 'retention.documentDays')).toBe(true);
  });
});

describe('逐项校验', () => {
  it('端口越界返回允许范围', () => {
    const violation = validateValue(CONFIG_ITEM_MAP.get('server.port')!, 70000, dev);
    expect(violation?.code).toBe('CONF_VALUE_INVALID');
    expect(violation?.allowedRange).toBe('1–65535');
  });

  it('安全开关关闭被硬拦截', () => {
    const violation = validateValue(CONFIG_ITEM_MAP.get('security.ssrfCheck')!, false, dev);
    expect(violation?.code).toBe('CONF_SECURITY_SWITCH_LOCKED');
  });

  it('只读项不可通过页面修改', () => {
    const violation = validateValue(CONFIG_ITEM_MAP.get('env.profile')!, 'prod', dev);
    expect(violation?.code).toBe('CONF_VALUE_INVALID');
  });

  it('前端来源禁用通配符', () => {
    const violation = validateValue(CONFIG_ITEM_MAP.get('server.corsOrigins')!, ['*'], dev);
    expect(violation?.code).toBe('CONF_VALUE_INVALID');
  });

  it('审计范围不得移除关键动作', () => {
    const violation = validateValue(CONFIG_ITEM_MAP.get('audit.scope')!, ['auth'], dev);
    expect(violation?.code).toBe('CONF_VALUE_INVALID');
  });

  it('生产环境禁止启用开发身份模拟', () => {
    const violation = validateValue(
      CONFIG_ITEM_MAP.get('auth.devIdentityEnabled')!,
      true,
      { profile: 'prod', isChanged: true },
    );
    expect(violation?.code).toBe('CONF_DEV_IDENTITY_FORBIDDEN');
  });

  it('对象存储禁止 public 访问策略', () => {
    const violation = validateValue(CONFIG_ITEM_MAP.get('storage.accessPolicy')!, 'public', dev);
    expect(violation?.code).toBe('CONF_VALUE_INVALID');
  });
});

describe('地址与 SSRF', () => {
  it('拒绝云元数据与内网地址', () => {
    expect(checkAddress('http://169.254.169.254/latest/meta-data')).toContain('云元数据');
    expect(checkAddress('http://10.0.0.8/api')).toContain('内网');
    expect(checkAddress('http://192.168.1.2/api')).toContain('内网');
    expect(checkAddress('file:///etc/passwd')).not.toBeNull();
    expect(checkAddress('https://example.com/api')).toBeNull();
  });

  it('开发环境允许回环地址，生产默认拒绝', () => {
    expect(checkAddress('http://127.0.0.1:8000', { allowLoopbackInDev: true })).toBeNull();
    expect(checkAddress('http://127.0.0.1:8000', { allowLoopbackInDev: false })).not.toBeNull();
  });

  it('内网例外只对显式标注生效', () => {
    expect(checkAddress('http://10.1.1.1/api', { innerNetworkException: true })).toBeNull();
  });

  it('测试连接地址脱敏不暴露完整主机与路径', () => {
    const masked = maskAddress('https://internal.example.com:8443/secret/path');
    expect(masked).not.toContain('internal.example.com');
    expect(masked).not.toContain('/secret/path');
    expect(masked.startsWith('https://')).toBe(true);
  });
});

describe('跨项校验', () => {
  const base = new Map<string, string | number | boolean | string[] | null>(
    CONFIG_ITEMS.map((item) => [item.key, item.defaultValue]),
  );

  it('间隔下限必须小于上限', () => {
    const values = new Map(base);
    values.set('crawl.intervalMinSeconds', 604800);
    values.set('crawl.intervalMaxSeconds', 600);
    const violations = validateCrossItems(values);
    expect(violations.some((entry) => entry.key === 'crawl.intervalMinSeconds')).toBe(true);
  });

  it('启用模型必须有地址、模型标识与凭据', () => {
    const values = new Map(base);
    values.set('model.enabled', true);
    values.set('model.baseUrl', '');
    values.set('model.model', '');
    values.set('model.secretRef', null);
    const violations = validateCrossItems(values);
    const keys = violations.map((entry) => entry.key);
    expect(keys).toContain('model.baseUrl');
    expect(keys).toContain('model.model');
    expect(keys).toContain('model.secretRef');
  });
});