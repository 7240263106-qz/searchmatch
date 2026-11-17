import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  CONFIG_APPLY_MODE_META,
  CONFIG_APPLY_STATE_META,
  CONFIG_GROUP_META,
  CONFIG_SOURCE_META,
  type ConfigGroupView,
  type ConfigItemView,
  type ConfigOverview,
  type ConfigTestResult,
  type ConfigTestTarget,
  type ConfigVersionDiff,
  type ConfigVersionSummary,
  type ConfigGateReport,
} from '@competition/contracts';
import { ApiError, api, getApiBaseInfo, getUser } from '../lib/api';
import { AsyncState, Badge, Button, Card, Icon, PageHeader } from '../components/ui';
import ModelSetupPanel from '../components/ModelSetupPanel';

type EditableValue = string | number | boolean | string[] | null;

const PAGES: Array<{ key: string; label: string; groups: string[]; testTarget?: ConfigTestTarget }> = [
  { key: 'model_access', label: '模型接入', groups: ['model_access'], testTarget: 'model_service' },
  { key: 'service_env', label: '服务与环境', groups: ['service_env', 'auth_identity'], testTarget: 'public_base_url' },
  { key: 'data_storage', label: '数据存储', groups: ['data_storage'], testTarget: 'object_storage' },
  { key: 'python_parser', label: 'Python 解析服务', groups: ['python_parser'], testTarget: 'python_parser' },
  { key: 'crawl_runtime', label: '采集运行', groups: ['crawl_runtime'] },
  { key: 'retention_audit', label: '留存与审计', groups: ['retention_audit', 'security_switches'] },
  { key: 'versions', label: '变更与回滚记录', groups: [] },
];

const SCOPE_LABEL: Record<string, string> = {
  locked: '强制只读',
  deployment: '部署级',
  team: '团队级',
};

function currentPage(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  return parts[1] && PAGES.some((page) => page.key === parts[1]) ? parts[1] : 'model_access';
}

function formatValue(item: ConfigItemView): string {
  const value = item.effectiveValue;
  if (item.dataType === 'secret_ref') {
    return item.configured ? `已配置 · 末四位 ${item.maskedTail ?? '****'}` : '未配置';
  }
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.join('、');
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  return `${value}${item.unit ? ` ${item.unit}` : ''}`;
}

function toEditable(item: ConfigItemView): EditableValue {
  if (item.dataType === 'secret_ref') return null;
  return item.effectiveValue;
}

function toneOfApplyState(state: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  if (state === 'applied') return 'success';
  if (state === 'pending_restart') return 'warning';
  if (state === 'apply_failed') return 'danger';
  return 'info';
}

export default function SettingsPage(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const page = currentPage(location.pathname);
  const pageMeta = PAGES.find((entry) => entry.key === page) ?? PAGES[0];
  const user = getUser();
  const isAdmin = user.roles.includes('admin');

  const [overview, setOverview] = useState<ConfigOverview | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'forbidden' | 'ready'>('loading');
  const [errorText, setErrorText] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);

  const loadOverview = useCallback(async (background = false) => {
    if (!background) setStatus('loading');
    try {
      const data = await api.get<ConfigOverview>('/system-settings');
      setOverview(data);
      setStatus('ready');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONF_FORBIDDEN') {
        setStatus('forbidden');
      } else if (!background) {
        setStatus('error');
      }
      setErrorText(error instanceof Error ? error.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      setStatus('forbidden');
      return;
    }
    void loadOverview();
  }, [isAdmin, loadOverview, refreshToken]);

  const refresh = () => {
    setRefreshToken((value) => value + 1);
  };

  if (!isAdmin) {
    return (
      <AsyncState status="forbidden" message="系统设置仅团队管理员可访问。" />
    );
  }

  return (
    <div className="stack">
      <PageHeader
        title="系统设置"
        description={page === 'model_access' ? '连接模型服务，用于文档提取和联网采集。' : '管理项目的运行配置。'}
        actions={
          <Button size="sm" onClick={refresh}>
            <Icon name="refresh" size={13} /> 刷新
          </Button>
        }
      />

      {page !== 'model_access' && <StatusBanner overview={overview} />}

      <div className="settings-tabs">
        {PAGES.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={entry.key === page ? 'active' : ''}
            aria-current={entry.key === page ? 'page' : undefined}
            onClick={() => navigate(`/settings/${entry.key}`)}
          >
            {entry.label}
            {overview?.pendingRestartKeys.length
              ? entry.groups.some((group) => overview.groups.find((item) => item.group === group)?.pendingRestartCount)
                ? ' ·'
                : ''
              : ''}
          </button>
        ))}
      </div>

      <AsyncState status={status === 'ready' ? 'ready' : status} message={errorText} onRetry={refresh}>
        <div className="stack">
          {page !== 'model_access' && <ReadinessCard overview={overview} />}
          {pageMeta.key === 'service_env' && <ClientBaseCard overview={overview} />}
          {pageMeta.key === 'data_storage' && <ConnectionProvenanceCard overview={overview} />}
          {pageMeta.key === 'model_access' ? (
            <>
              <ModelSetupPanel version={overview?.version ?? 0} onSaved={() => void loadOverview(true)} />
              <details className="model-advanced">
                <summary>高级设置</summary>
                <GroupEditor
                  key={`model_access-${overview?.version ?? 0}`}
                  group="model_access"
                  testTarget="model_service"
                  profile={overview?.devIdentityProfile ?? 'dev'}
                  onSaved={() => void loadOverview(true)}
                />
              </details>
            </>
          ) : pageMeta.key === 'versions' ? (
            <>
              <VersionsPanel overview={overview} onRollback={refresh} />
              <ConfigGateCard />
            </>
          ) : (
            pageMeta.groups.map((group) => (
              <GroupEditor
                key={`${group}-${overview?.version ?? 0}-${refreshToken}`}
                group={group}
                testTarget={group === pageMeta.key ? pageMeta.testTarget : undefined}
                profile={overview?.devIdentityProfile ?? 'dev'}
                onSaved={() => {
                  void loadOverview();
                  setRefreshToken((value) => value + 1);
                }}
              />
            ))
          )}
        </div>
      </AsyncState>
    </div>
  );
}

function StatusBanner({ overview }: { overview: ConfigOverview | null }): JSX.Element {
  if (!overview) return <div className="banner info">正在加载配置概要…</div>;
  const pending = overview.pendingRestartKeys.length;
  const failed = overview.applyFailedKeys.length;
  const mismatch = overview.runtimeMismatchKeys.length;
  const clientBase = getApiBaseInfo();
  const fallback = clientBase.source === 'same_origin' || Boolean(clientBase.error);
  const inconsistent =
    !fallback &&
    overview.clientBase !== undefined &&
    overview.clientBase.apiBaseUrl.replace(/\/$/, '') !== clientBase.apiBaseUrl.replace(/\/$/, '');
  const warn = pending > 0 || failed > 0 || mismatch > 0 || fallback || inconsistent;
  return (
    <div className={`banner ${warn ? 'warning' : 'info'}`}>
      <div className="toolbar">
        <span>
          <strong>配置版本 v{overview.version}</strong>
          {overview.lastModifiedBy ? ` · 最后修改 ${overview.lastModifiedBy}` : ''}
          {overview.lastModifiedAt ? ` · ${new Date(overview.lastModifiedAt).toLocaleString('zh-CN')}` : ''}
        </span>
        <span className="spacer" />
        <Badge tone={fallback ? 'warning' : 'success'}>
          客户端基地址：{fallback ? '同源兜底' : '运行期下发'}
        </Badge>
        {inconsistent && <Badge tone="danger">基地址未按配置生效</Badge>}
        {overview.devIdentityEnabled && (
          <Badge tone="warning">开发身份模拟中（{overview.devIdentityProfile}）</Badge>
        )}
        <Badge tone={pending ? 'warning' : 'success'}>待重启 {pending}</Badge>
        <Badge tone={failed ? 'danger' : 'neutral'}>生效失败 {failed}</Badge>
        <Badge tone={mismatch ? 'warning' : 'neutral'}>运行值不一致 {mismatch}</Badge>
      </div>
      {fallback && (
        <div className="setting-desc" style={{ marginTop: 6 }}>
          API 地址未按配置下发，当前使用同源地址{clientBase.error ? `（${clientBase.error}）` : ''}。
        </div>
      )}
    </div>
  );
}

function ClientBaseCard({ overview }: { overview: ConfigOverview | null }): JSX.Element {
  const info = getApiBaseInfo();
  const configured = overview?.clientBase;
  const inconsistent =
    info.source === 'configured' &&
    configured !== undefined &&
    configured.apiBaseUrl.replace(/\/$/, '') !== info.apiBaseUrl.replace(/\/$/, '');
  return (
    <Card title="前端接入（只读）" subtitle="API 基地址由服务端在运行期下发，构建期变量不再决定连接地址。">
      <div className="readiness-grid">
        <div className="readiness-item">
          <div className="toolbar">
            <strong>当前使用基地址</strong>
            <Badge tone={info.source === 'configured' ? 'success' : 'warning'}>
              {info.source === 'configured' ? '运行期下发' : '同源兜底'}
            </Badge>
          </div>
          <div className="readiness-detail mono">{info.apiBaseUrl}</div>
          <div className="readiness-fix">
            最近获取：{info.issuedAt ? new Date(info.issuedAt).toLocaleString('zh-CN') : '未取得'}
            {info.stale ? ' · 已超过缓存期限' : ''}
          </div>
        </div>
        <div className="readiness-item">
          <div className="toolbar">
            <strong>服务端下发值</strong>
            <Badge tone={configured?.source === 'configured' ? 'success' : 'warning'}>
              {configured?.source === 'configured' ? '配置值' : '同源推导'}
            </Badge>
          </div>
          <div className="readiness-detail mono">{configured?.apiBaseUrl ?? '未取得'}</div>
          <div className="readiness-fix">
            配置版本 v{configured?.configVersion ?? overview?.version ?? 0} · 缓存上限{' '}
            {configured?.cacheMaxAgeSeconds ?? 60} 秒
          </div>
        </div>
      </div>
      {(inconsistent || info.error) && (
        <div className="banner warning" style={{ marginTop: 12 }}>
          {inconsistent
            ? '基地址未按配置生效：当前使用地址与服务端下发值不一致。'
            : `基地址未按配置下发：${info.error}`}
        </div>
      )}
    </Card>
  );
}

function ConnectionProvenanceCard({ overview }: { overview: ConfigOverview | null }): JSX.Element | null {
  const provenance = overview?.connectionProvenance;
  if (!provenance) return null;
  return (
    <Card title="运行期连接来源" subtitle="与配置页、健康检查共用同一配置快照；不返回口令与完整连接串。">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>目标</th>
              <th>脱敏目标</th>
              <th>配置版本</th>
              <th>连接建立时间</th>
              <th>传输加密</th>
              <th>状态</th>
              <th>最近失败分类</th>
            </tr>
          </thead>
          <tbody>
            {[provenance.database, provenance.objectStorage].map((item) => (
              <tr key={item.kind}>
                <td>{item.kind === 'database' ? '数据库' : '对象存储'}</td>
                <td className="mono">{item.targetMasked}</td>
                <td>v{item.configVersion}</td>
                <td>{new Date(item.connectedAt).toLocaleString('zh-CN')}</td>
                <td>{item.tlsEnabled === null ? '不适用' : item.tlsEnabled ? '已启用' : '未启用'}</td>
                <td>
                  <Badge
                    tone={
                      item.status === 'ready'
                        ? 'success'
                        : item.status === 'degraded'
                          ? 'warning'
                          : item.status === 'not_enabled'
                            ? 'neutral'
                            : 'danger'
                    }
                  >
                    {item.status === 'ready'
                      ? '运行中'
                      : item.status === 'degraded'
                        ? '降级'
                        : item.status === 'not_enabled'
                          ? '未启用'
                          : '连接失败'}
                  </Badge>
                </td>
                <td>{item.lastFailure ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="setting-desc" style={{ marginTop: 8 }}>
        {provenance.database.detail ?? ''}
        {provenance.objectStorage.detail ? ` · ${provenance.objectStorage.detail}` : ''}
      </div>
    </Card>
  );
}

function ConfigGateCard(): JSX.Element {
  const [report, setReport] = useState<ConfigGateReport | null>(null);
  const [message, setMessage] = useState('');
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    api
      .get<ConfigGateReport>('/system/config-gate/last-report')
      .then((data) => setReport(data))
      .catch((error) => {
        if (error instanceof ApiError && error.code === 'CONF_GATE_REPORT_MISSING') {
          setMissing(true);
        } else {
          setMessage(error instanceof Error ? error.message : '加载门禁报告失败');
        }
      });
  }, []);

  return (
    <Card
      title="配置门禁报告"
      subtitle="最近一次环境变量静态扫描与同源取值断言结果；失败将阻断发布。"
      actions={
        report ? <Badge tone={report.passed ? 'success' : 'danger'}>{report.passed ? '通过' : '失败'}</Badge> : undefined
      }
    >
      {missing && <div className="banner info">尚无扫描报告，请先执行 pnpm gate:env。</div>}
      {message && <div className="banner warning">{message}</div>}
      {report && (
        <div className="stack">
          <div className="toolbar">
            <span>扫描时间：{new Date(report.scannedAt).toLocaleString('zh-CN')}</span>
            <span>耗时：{report.durationMs}ms</span>
            <span>证据：<span className="mono">{report.evidencePath}</span></span>
          </div>
          <div className="setting-desc">
            同源断言：{report.sameSourceAssertion.passed ? '通过' : '失败'} · 页面 v
            {report.sameSourceAssertion.versions.page} / 健康检查 v
            {report.sameSourceAssertion.versions.health} / 日志 v
            {report.sameSourceAssertion.versions.log} · 快照指纹{' '}
            {report.sameSourceAssertion.fingerprint || '—'}
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>文件</th>
                  <th>行号</th>
                  <th>变量</th>
                  <th>违规类型</th>
                </tr>
              </thead>
              <tbody>
                {report.violations.length === 0 ? (
                  <tr>
                    <td colSpan={4}>未发现越界读取</td>
                  </tr>
                ) : (
                  report.violations.map((violation) => (
                    <tr key={`${violation.file}-${violation.line}-${violation.variable}`}>
                      <td className="mono">{violation.file}</td>
                      <td>{violation.line}</td>
                      <td className="mono">{violation.variable}</td>
                      <td>{violation.type}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="setting-desc">
            白名单 {report.whitelist.length} 条，扫描范围 {report.scope.join('、')}
          </div>
        </div>
      )}
    </Card>
  );
}

function ReadinessCard({ overview }: { overview: ConfigOverview | null }): JSX.Element | null {
  if (!overview?.readiness) return null;
  const readiness = overview.readiness;
  const tone =
    readiness.overall === 'ready'
      ? 'success'
      : readiness.overall === 'ready_rule_mode'
        ? 'info'
        : 'danger';
  const label =
    readiness.overall === 'ready'
      ? '已就绪'
      : readiness.overall === 'ready_rule_mode'
        ? '已就绪（规则模式）'
        : '未就绪';
  return (
    <Card title="就绪清单" subtitle={`计算于 ${new Date(readiness.computedAt).toLocaleString('zh-CN')}`} actions={<Badge tone={tone}>{label}</Badge>}>
      <div className="readiness-grid">
        {readiness.items.map((item) => (
          <div key={item.key} className="readiness-item">
            <div className="toolbar">
              <strong>{item.label}</strong>
              <Badge tone={item.required ? 'neutral' : 'info'}>{item.required ? '必需' : '可选'}</Badge>
              <Badge
                tone={
                  item.state === 'ready'
                    ? 'success'
                    : item.state === 'optional_not_configured'
                      ? 'info'
                      : item.state === 'degraded'
                        ? 'warning'
                        : item.state === 'disabled'
                          ? 'neutral'
                          : 'danger'
                }
              >
                {item.state === 'ready'
                  ? '就绪'
                  : item.state === 'optional_not_configured'
                    ? '可选未配置'
                    : item.state === 'degraded'
                      ? '降级可用'
                      : item.state === 'disabled'
                        ? '关闭'
                        : '未就绪'}
              </Badge>
            </div>
            <div className="readiness-detail">{item.detail}</div>
            <div className="readiness-fix mono">{item.fixPath}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function GroupEditor({
  group,
  testTarget,
  profile,
  onSaved,
}: {
  group: string;
  testTarget?: ConfigTestTarget;
  profile: string;
  onSaved: () => void;
}): JSX.Element {
  const [view, setView] = useState<ConfigGroupView | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [edits, setEdits] = useState<Record<string, EditableValue>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [failure, setFailure] = useState('');
  const [testResult, setTestResult] = useState<ConfigTestResult | null>(null);
  const [conflict, setConflict] = useState<{ currentVersion: number; lastModifiedBy?: string; lastModifiedAt?: string } | null>(null);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const data = await api.get<ConfigGroupView>(`/system-settings/groups/${group}`);
      setView(data);
      setLoadState('ready');
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '加载失败');
      setLoadState('error');
    }
  }, [group]);

  useEffect(() => {
    void load();
  }, [load]);

  const changedKeys = useMemo(() => {
    if (!view) return [];
    return view.items
      .filter((item) => {
        if (item.dataType === 'secret_ref') return Boolean(secrets[item.key]?.trim());
        if (!item.editable) return false;
        if (!(item.key in edits)) return false;
        return JSON.stringify(edits[item.key]) !== JSON.stringify(toEditable(item));
      })
      .map((item) => item.key);
  }, [view, edits, secrets]);

  if (loadState === 'loading') return <Card title={CONFIG_GROUP_META[group as keyof typeof CONFIG_GROUP_META]?.label ?? group}><AsyncState status="loading" /></Card>;
  if (loadState === 'error' || !view) {
    return (
      <Card title={CONFIG_GROUP_META[group as keyof typeof CONFIG_GROUP_META]?.label ?? group}>
        <AsyncState status="error" message={failure} onRetry={load} />
      </Card>
    );
  }

  const meta = CONFIG_GROUP_META[view.group];

  const save = async () => {
    if (changedKeys.length === 0) return;
    setSaving(true);
    setFeedback('');
    setFailure('');
    setConflict(null);
    try {
      const changes: Array<{ key: string; value: EditableValue }> = [];
      for (const key of changedKeys) {
        const item = view.items.find((entry) => entry.key === key)!;
        if (item.dataType === 'secret_ref') {
          const credential = await api.put<{ secretRefId: string }>('/system-settings/credentials/new', {
            plaintext: secrets[key],
            purpose: item.group,
          });
          changes.push({ key, value: credential.secretRefId });
        } else {
          changes.push({ key, value: coerceValue(item, edits[key]) });
        }
      }
      const result = await api.put<{
        version: number;
        applyState: string;
        pendingRestartKeys: string[];
        results: Array<{ key: string; applyState: string }>;
        storageImpact?: { affectedArtifacts: number; message: string } | null;
      }>(
        `/system-settings/groups/${group}`,
        { baseVersion: view.version, changes, reason: '页面保存' },
        {
          'If-Match': `"${view.version}"`,
          'Idempotency-Key': `${group}-${view.version}-${Date.now()}`,
        },
      );
      setFeedback(
        `已保存 v${result.version}，${result.applyState === 'applied' ? '已生效' : result.applyState === 'pending_restart' ? '部分项待重启' : result.applyState === 'apply_failed' ? '生效校验失败，已回退' : '部分生效'}${result.pendingRestartKeys.length ? `（待重启 ${result.pendingRestartKeys.length} 项）` : ''}${result.storageImpact ? ` · ${result.storageImpact.message}` : ''}`,
      );
      setEdits({});
      setSecrets({});
      await load();
      onSaved();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONF_VERSION_CONFLICT') {
        const details = (error.details ?? {}) as {
          currentVersion?: number;
          lastModifiedBy?: string;
          lastModifiedAt?: string;
        };
        setConflict({
          currentVersion: details.currentVersion ?? view.version,
          lastModifiedBy: details.lastModifiedBy,
          lastModifiedAt: details.lastModifiedAt,
        });
        setFailure('配置已被其他管理员更新，已保留你填写的内容，请以最新版本重新编辑。');
      } else if (error instanceof ApiError && error.code === 'CONF_APPLY_FAILED') {
        setFailure(`生效校验失败，已回退上一有效版本：${error.message}`);
      } else if (error instanceof ApiError && error.code === 'CONF_SECURITY_SWITCH_LOCKED') {
        setFailure('安全开关为强制开启，不能关闭。');
      } else if (error instanceof ApiError && error.code === 'CONF_VALUE_INVALID') {
        const violations = ((error.details ?? {}) as { violations?: Array<{ key: string; reason: string; allowedRange?: string }> })
          .violations ?? [];
        setFailure(
          violations.length
            ? `校验未通过：${violations.map((entry) => `${entry.key}（${entry.reason}${entry.allowedRange ? `，允许范围 ${entry.allowedRange}` : ''}）`).join('；')}`
            : error.message,
        );
      } else {
        setFailure(error instanceof Error ? error.message : '保存失败');
      }
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (!testTarget) return;
    setTestResult(null);
    setFailure('');
    try {
      const result = await api.post<ConfigTestResult>('/system-settings/tests', {
        target: testTarget,
        address: testAddressOf(view, testTarget),
      });
      setTestResult(result);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'RATE_LIMITED') {
        const details = (error.details ?? {}) as {
          cooldownSeconds?: number;
          lastTestedAt?: string;
        };
        setFailure(
          `测试冷却中：剩余 ${details.cooldownSeconds ?? 60} 秒${
            details.lastTestedAt
              ? `（上次 ${new Date(details.lastTestedAt).toLocaleString('zh-CN')}）`
              : ''
          }`,
        );
      } else {
        setFailure(error instanceof Error ? error.message : '连接测试失败');
      }
    }
  };

  return (
    <Card
      title={meta.label}
      subtitle={`${meta.description} · v${view.version}`}
      actions={
        <div className="toolbar">
          {testTarget && (
            <Button size="sm" onClick={() => void runTest()}>
              <Icon name="shield" size={13} /> 测试连接
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={saving || changedKeys.length === 0}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : `保存${changedKeys.length ? `（${changedKeys.length} 项）` : ''}`}
          </Button>
        </div>
      }
    >
      {conflict && (
        <div className="banner warning" style={{ marginBottom: 12 }}>
          当前最新版本 v{conflict.currentVersion}
          {conflict.lastModifiedBy ? ` · 最后修改人 ${conflict.lastModifiedBy}` : ''}
          {conflict.lastModifiedAt ? ` · ${new Date(conflict.lastModifiedAt).toLocaleString('zh-CN')}` : ''}
          <div className="toolbar" style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => void load()}>以最新版本重新编辑</Button>
          </div>
        </div>
      )}
      {failure && <div className="banner warning" style={{ marginBottom: 12 }}>{failure}</div>}
      {feedback && <div className="banner info" style={{ marginBottom: 12 }}>{feedback}</div>}
      {testResult && (
        <div className={`banner ${testResult.result === 'success' ? 'info' : 'warning'}`} style={{ marginBottom: 12 }}>
          测试 {testResult.result === 'success' ? '通过' : '失败'}：{testResult.suggestion} · 目标 {testResult.maskedAddress} · 耗时 {testResult.durationMs}ms
          {testResult.evidence
            ? ` · 真实外发 ${testResult.evidence.realOutbound ? '是' : '否（受控驱动）'} · 出口 ${testResult.evidence.egressRoute}`
            : ''}
          {testResult.testedAt
            ? ` · 测试时间 ${new Date(testResult.testedAt).toLocaleString('zh-CN')}`
            : ''}
          {testResult.validUntil
            ? ` · 有效期至 ${new Date(testResult.validUntil).toLocaleString('zh-CN')}`
            : ''}
        </div>
      )}
      <div className="table-wrap">
        <table className="table settings-table">
          <thead>
            <tr>
              <th>配置项</th>
              <th>实际生效值</th>
              <th>来源 / 作用域</th>
              <th>生效方式</th>
              <th>编辑</th>
            </tr>
          </thead>
          <tbody>
            {view.items.map((item) => (
              <tr key={item.key}>
                <td>
                  <div className="setting-label">{item.label}</div>
                  <div className="mono setting-key">{item.key}</div>
                  <div className="setting-desc">{item.description}</div>
                  {item.allowedRange && <div className="setting-desc">允许范围：{item.allowedRange}</div>}
                </td>
                <td>
                  <div className={item.runtimeMismatch ? 'setting-value mismatch' : 'setting-value'}>{formatValue(item)}</div>
                  {item.runtimeMismatch && <Badge tone="warning">运行值不一致（待重启）</Badge>}
                  {item.lockedReason && <div className="setting-desc">{item.lockedReason}</div>}
                </td>
                <td>
                  <div className="toolbar">
                    <Badge tone={item.source === 'page_saved' ? 'accent' : 'neutral'}>{CONFIG_SOURCE_META[item.source]}</Badge>
                    <Badge tone={item.scope === 'locked' ? 'warning' : 'neutral'}>{SCOPE_LABEL[item.scope]}</Badge>
                  </div>
                  {item.scope === 'deployment' && item.teamValue !== null && (
                    <div className="setting-desc">团队级值：{String(item.teamValue)}</div>
                  )}
                  {item.scope === 'team' && item.deploymentValue !== null && (
                    <div className="setting-desc">部署级值：{String(item.deploymentValue)}（优先）</div>
                  )}
                </td>
                <td>
                  <div className="setting-desc">{CONFIG_APPLY_MODE_META[item.applyMode]}</div>
                  <Badge tone={toneOfApplyState(item.applyState)}>{CONFIG_APPLY_STATE_META[item.applyState]}</Badge>
                </td>
                <td>
                  {!item.editable ? (
                    <span className="setting-desc">只读</span>
                  ) : item.dataType === 'secret_ref' ? (
                    <div>
                      <input
                        className="input"
                        type="password"
                        placeholder="新增 / 替换密钥"
                        value={secrets[item.key] ?? ''}
                        onChange={(event) =>
                          setSecrets((current) => ({ ...current, [item.key]: event.target.value }))
                        }
                        autoComplete="new-password"
                      />
                      <div className="setting-desc">提交后清空，不回填末四位之外的内容。</div>
                    </div>
                  ) : (
                    <ItemInput
                      item={item}
                      value={edits[item.key] !== undefined ? edits[item.key] : toEditable(item)}
                      onChange={(value) => setEdits((current) => ({ ...current, [item.key]: value }))}
                    />
                  )}
                  {profile === 'prod' && item.key === 'auth.devIdentityEnabled' && (
                    <div className="setting-desc">生产环境不可开启。</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ItemInput({
  item,
  value,
  onChange,
}: {
  item: ConfigItemView;
  value: EditableValue;
  onChange: (value: EditableValue) => void;
}): JSX.Element {
  if (item.dataType === 'bool') {
    return (
      <select className="select" value={value === true ? 'true' : 'false'} onChange={(event) => onChange(event.target.value === 'true')}>
        <option value="true">开启</option>
        <option value="false">关闭</option>
      </select>
    );
  }
  if (item.dataType === 'enum') {
    return (
      <select className="select" value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)}>
        {(item.enumValues ?? []).map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    );
  }
  if (item.dataType === 'string_array') {
    return (
      <input
        className="input"
        value={Array.isArray(value) ? value.join(', ') : String(value ?? '')}
        onChange={(event) =>
          onChange(event.target.value.split(',').map((entry) => entry.trim()).filter(Boolean))
        }
      />
    );
  }
  if (item.dataType === 'int' || item.dataType === 'number') {
    return (
      <input
        className="input"
        type="number"
        value={typeof value === 'number' ? value : ''}
        onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
      />
    );
  }
  return (
    <input
      className="input"
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function coerceValue(item: ConfigItemView, value: EditableValue): EditableValue {
  if (item.dataType === 'int' || item.dataType === 'number') {
    return typeof value === 'number' ? value : value === null || value === '' ? null : Number(value);
  }
  return value;
}

function testAddressOf(view: ConfigGroupView, target: ConfigTestTarget): string | undefined {
  if (target === 'python_parser') return String(view.items.find((item) => item.key === 'parser.baseUrl')?.effectiveValue ?? '');
  if (target === 'model_service') return String(view.items.find((item) => item.key === 'model.baseUrl')?.effectiveValue ?? '');
  if (target === 'object_storage') return String(view.items.find((item) => item.key === 'storage.endpoint')?.effectiveValue ?? '');
  if (target === 'public_base_url') return String(view.items.find((item) => item.key === 'server.publicBaseUrl')?.effectiveValue ?? '');
  return undefined;
}

function VersionsPanel({ overview, onRollback }: { overview: ConfigOverview | null; onRollback: () => void }): JSX.Element {
  const [versions, setVersions] = useState<ConfigVersionSummary[]>([]);
  const [diff, setDiff] = useState<ConfigVersionDiff | null>(null);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const data = await api.get<ConfigVersionSummary[]>('/system-settings/versions?limit=20');
      setVersions(data);
      setState('ready');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '加载失败');
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const inspect = async (version: number) => {
    setSelected(version);
    setMessage('');
    try {
      const data = await api.get<ConfigVersionDiff>(
        `/system-settings/versions/${version}/diff${version > 1 ? `?against=${version - 1}` : ''}`,
      );
      setDiff(data);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '加载差异失败');
    }
  };

  const rollback = async (version: number) => {
    if (!overview) return;
    const confirmed = window.confirm(`确认回滚到 v${version}？将生成新版本，且不会级联修改业务数据。`);
    if (!confirmed) return;
    try {
      await api.post('/system-settings/rollback', {
        targetVersion: version,
        baseVersion: overview.version,
        confirmed: true,
      });
      setMessage(`已回滚到 v${version}，生成新版本。需重启项将标记待重启。`);
      await load();
      onRollback();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '回滚失败');
    }
  };

  return (
    <Card title="变更与回滚记录" subtitle="保留最近不少于 10 个可回滚版本，历史版本不可修改。">
      {message && <div className="banner info" style={{ marginBottom: 12 }}>{message}</div>}
      <AsyncState status={state === 'ready' ? 'ready' : state} message={message} onRetry={load}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>版本</th>
                <th>操作人</th>
                <th>时间</th>
                <th>变更项</th>
                <th>生效状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={version.version}>
                  <td className="mono">v{version.version}</td>
                  <td>{version.actorId}</td>
                  <td>{new Date(version.createdAt).toLocaleString('zh-CN')}</td>
                  <td>{version.changeCount}</td>
                  <td>
                    <Badge tone={toneOfApplyState(version.applyState)}>{CONFIG_APPLY_STATE_META[version.applyState]}</Badge>
                  </td>
                  <td>
                    <div className="toolbar">
                      <Button size="sm" onClick={() => void inspect(version.version)}>查看差异</Button>
                      <Button size="sm" variant="danger" disabled={!version.rollbackable} onClick={() => void rollback(version.version)}>
                        回滚
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {diff && (
          <div style={{ marginTop: 16 }}>
            <h4>v{diff.version} 相对 v{diff.against} 的差异</h4>
            <div className="setting-desc">
              新增 {diff.added.length} · 修改 {diff.modified.length} · 删除 {diff.removed.length}
              {diff.pendingRestartKeys.length ? ` · 需重启 ${diff.pendingRestartKeys.join('、')}` : ''}
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>配置项</th>
                    <th>变更</th>
                    <th>变更前</th>
                    <th>变更后</th>
                  </tr>
                </thead>
                <tbody>
                  {[...diff.added, ...diff.modified, ...diff.removed].map((entry, index) => (
                    <tr key={`${entry.key}-${index}`}>
                      <td className="mono">{entry.key}</td>
                      <td>{diff.added.includes(entry) ? '新增' : diff.removed.includes(entry) ? '删除' : '修改'}</td>
                      <td className="mono">{JSON.stringify(entry.beforeValue)}</td>
                      <td className="mono">{JSON.stringify(entry.afterValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </AsyncState>
    </Card>
  );
}
