import { useEffect, useState } from 'react';
import type { SourceView } from '@competition/contracts';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import {
  AsyncState,
  Badge,
  Button,
  Card,
  Icon,
  PageHeader,
} from '../components/ui';

export default function SourcesPage(): JSX.Element {
  const [rows, setRows] = useState<SourceView[]>([]);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready' | 'empty'>('loading');
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', address: '', type: 'official_site', intervalSeconds: 86400 });
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');

  const load = (): void => {
    setStatus('loading');
    api
      .get<SourceView[]>('/sources')
      .then((data) => {
        setRows(data);
        setStatus(data.length === 0 ? 'empty' : 'ready');
      })
      .catch((reason: Error) => {
        setError(reason.message);
        setStatus('error');
      });
  };

  useEffect(load, []);

  const create = async (): Promise<void> => {
    setCreating(true);
    setMessage('');
    try {
      await api.post('/sources', form);
      setForm({ name: '', address: '', type: 'official_site', intervalSeconds: 86400 });
      setMessage('信息源已创建，处于待验证状态。请点击“探测”确认可达后启用。');
      load();
    } catch (reason) {
      setMessage((reason as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const probe = async (id: string): Promise<void> => {
    try {
      const result = await api.post<{ verified: boolean; reason?: string }>(`/sources/${id}/probe`);
      setMessage(result.verified ? '探测成功，信息源已启用。' : `探测失败：${result.reason ?? '不可达'}，已保存为停用状态。`);
      load();
    } catch (reason) {
      setMessage((reason as Error).message);
    }
  };

  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    try {
      await api.post(`/sources/${id}/${enabled ? 'enable' : 'disable'}`);
      load();
    } catch (reason) {
      setMessage((reason as Error).message);
    }
  };

  const crawl = async (id: string): Promise<void> => {
    setMessage('正在真实抓取该信息源，包含 robots、快照与附件处理，可能需要几分钟…');
    try {
      const result = await api.post<{ message: string }>(`/sources/${id}/crawl`, {});
      setMessage(result.message ?? '采集完成');
      load();
    } catch (reason) {
      setMessage((reason as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        title="信息源管理"
        description="配置官网或 RSS 来源，探测可达后启用。内网、回环与元数据地址会被拒绝。"
        actions={
          <Button onClick={load}>
            <Icon name="refresh" size={14} /> 刷新
          </Button>
        }
      />

      <div className="grid-main">
        <Card title="信息源列表" subtitle="停用只停止后续采集，不影响历史数据">
          <AsyncState status={status} message={error} onRetry={load}>
            {rows.length > 0 && (
              <div className="list">
                {rows.map((source) => (
                  <div key={source.id} className="list-row">
                    <span
                      className="metric-icon"
                      style={{
                        background: source.enabled ? 'var(--success-soft)' : 'var(--surface-3)',
                        color: source.enabled ? 'var(--success)' : 'var(--text-3)',
                      }}
                    >
                      <Icon name="source" size={15} />
                    </span>
                    <div className="stretch">
                      <div className="list-title">{source.name}</div>
                      <div className="list-sub truncate">{source.normalizedAddress}</div>
                      <div className="comp-meta">
                        <Badge tone={source.enabled ? 'success' : 'neutral'}>
                          {source.enabled ? '已启用' : '已停用'}
                        </Badge>
                        <Badge tone={source.verified ? 'info' : 'warning'}>
                          {source.verified ? '已验证' : '待验证'}
                        </Badge>
                        <span>间隔 {Math.round(source.intervalSeconds / 60)} 分钟</span>
                        {source.lastSuccessAt && <span>最近成功 {formatDateTime(source.lastSuccessAt)}</span>}
                        {source.consecutiveFailures > 0 && (
                          <span style={{ color: 'var(--danger)' }}>连续失败 {source.consecutiveFailures} 次</span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Button size="sm" onClick={() => void probe(source.id)}>
                        探测
                      </Button>
                      <Button size="sm" onClick={() => void crawl(source.id)}>
                        采集
                      </Button>
                      <Button
                        size="sm"
                        variant={source.enabled ? 'default' : 'primary'}
                        onClick={() => void toggle(source.id, !source.enabled)}
                      >
                        {source.enabled ? '停用' : '启用'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </AsyncState>
        </Card>

        <Card title="新增信息源" subtitle="自动采集间隔 10 分钟 – 7 天">
          <div className="form-grid">
            <div style={{ gridColumn: '1 / -1' }}>
              <label className="field-label" htmlFor="source-name">名称</label>
              <input
                id="source-name"
                className="input"
                placeholder="如 蓝桥杯官网"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label className="field-label" htmlFor="source-address">地址</label>
              <input
                id="source-address"
                className="input"
                placeholder="https://example.edu.cn/notices"
                value={form.address}
                onChange={(event) => setForm({ ...form, address: event.target.value })}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="source-type">类型</label>
              <select
                id="source-type"
                className="select"
                value={form.type}
                onChange={(event) => setForm({ ...form, type: event.target.value })}
              >
                <option value="official_site">官方网站</option>
                <option value="rss">RSS 订阅</option>
                <option value="other">其他</option>
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="source-interval">采集间隔（秒）</label>
              <input
                id="source-interval"
                className="input mono"
                type="number"
                value={form.intervalSeconds}
                onChange={(event) => setForm({ ...form, intervalSeconds: Number(event.target.value) })}
              />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <Button variant="primary" onClick={() => void create()} disabled={creating || !form.name || !form.address}>
              <Icon name="plus" size={14} /> {creating ? '创建中…' : '创建信息源'}
            </Button>
          </div>

          {message && (
            <div className="banner info" style={{ marginTop: 12 }}>
              <Icon name="alert" size={14} />
              <div>{message}</div>
            </div>
          )}

          <div className="divider" />
          <div className="banner">
            <Icon name="shield" size={14} />
            <div>
              地址会经过规范化与 SSRF 校验：协议仅允许 http/https，拒绝回环、内网、链路本地与云元数据地址。
              探测失败不影响保存，但不会启动采集。
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}