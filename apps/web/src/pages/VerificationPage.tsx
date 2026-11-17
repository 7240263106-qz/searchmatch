import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import {
  AsyncState,
  Badge,
  Button,
  Card,
  CompletenessBadge,
  CredibilityBadge,
  Icon,
  PageHeader,
  RegistrationBadge,
} from '../components/ui';

interface BatchCompetition {
  id: string;
  name: string;
  category: string | null;
  level: string | null;
  publishStatus: string;
  completeness: string;
  credibility: string;
  registrationStatus: string;
  nearestDeadline: string | null;
  dataOrigin: string;
  trackId: string | null;
}

interface BatchDetail {
  id: string;
  name: string;
  subject: string;
  status: string;
  sourceId: string | null;
  entryLimit: number;
  report: { message?: string; counters?: Record<string, number> };
  counts: {
    competitions: number;
    candidates: number;
    snapshots: number;
    attachments: number;
    promoted: number;
  };
  competitions: BatchCompetition[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface BatchSummary {
  id: string;
  name: string;
  status: string;
  counts: { competitions: number; candidates: number; snapshots: number; attachments: number };
  createdAt: string;
}

interface SourceOption {
  id: string;
  name: string;
  address: string;
}

const STATUS_META: Record<string, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  created: { label: '待采集', tone: 'neutral' },
  collecting: { label: '采集中', tone: 'info' },
  verifying: { label: '待验证', tone: 'warning' },
  promoted: { label: '已转正式', tone: 'success' },
  cleared: { label: '已清除', tone: 'neutral' },
  failed: { label: '采集失败', tone: 'danger' },
};

export default function VerificationPage(): JSX.Element {
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [selected, setSelected] = useState<BatchDetail | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = async (): Promise<void> => {
    setStatus('loading');
    try {
      const [batchData, sourceData] = await Promise.all([
        api.get<BatchSummary[]>('/verification-batches'),
        api.get<SourceOption[]>('/sources'),
      ]);
      setBatches(batchData);
      setSources(sourceData);
      if (!sourceId && sourceData.length > 0) {
        const lanqiao = sourceData.find((item) => /lanqiao/i.test(item.address + item.name));
        setSourceId((lanqiao ?? sourceData[0])?.id ?? '');
      }
      setStatus('ready');
    } catch (reason) {
      setError((reason as Error).message);
      setStatus('error');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openDetail = async (batchId: string): Promise<void> => {
    try {
      const detail = await api.get<BatchDetail>(`/verification-batches/${batchId}`);
      setSelected(detail);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const createBatch = async (): Promise<void> => {
    if (!sourceId) return;
    setBusy(true);
    setMessage('');
    try {
      const detail = await api.post<BatchDetail>('/verification-batches', {
        name: '蓝桥杯真实采集验证',
        sourceId,
        entryLimit: 6,
      });
      setSelected(detail);
      setMessage('批次已创建。点击「启动真实采集」开始从蓝桥杯官网抓取真实公告。');
      await load();
    } catch (reason) {
      setMessage((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const collect = async (batchId: string): Promise<void> => {
    setBusy(true);
    setMessage('正在真实抓取蓝桥杯官网公告，包含列表、详情与附件下载，可能需要几分钟…');
    try {
      const detail = await api.post<BatchDetail>(`/verification-batches/${batchId}/collect`);
      setSelected(detail);
      setMessage(detail.report.message ?? '采集完成');
      await load();
    } catch (reason) {
      setMessage((reason as Error).message);
      await openDetail(batchId);
    } finally {
      setBusy(false);
    }
  };

  const promote = async (batchId: string): Promise<void> => {
    if (!window.confirm('确认将该验证批次全部竞赛转为正式数据？转正式后需提交审核并发布才会公开。')) return;
    setBusy(true);
    try {
      const detail = await api.post<BatchDetail>(`/verification-batches/${batchId}/promote`);
      setSelected(detail);
      setMessage('已转正式。请前往「竞赛库 → 审核发布」提交审核并发布。');
      await load();
    } catch (reason) {
      setMessage((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clear = async (batchId: string): Promise<void> => {
    if (!window.confirm('确认清除该验证批次及其全部竞赛、快照与附件？此操作不可恢复。')) return;
    setBusy(true);
    try {
      await api.post(`/verification-batches/${batchId}/clear`);
      setSelected(null);
      setMessage('批次已清除');
      await load();
    } catch (reason) {
      setMessage((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="采集测试"
        description="以蓝桥杯官网为验证源，执行真实联网抓取。验证批次默认隔离，转正式并发布后才进入公共视图。"
        actions={
          <Button onClick={() => void load()}>
            <Icon name="refresh" size={14} /> 刷新
          </Button>
        }
      />

      <div className="banner info" style={{ marginBottom: 16 }}>
        <Icon name="shield" size={16} />
        <div>
          真实抓取路径：公告列表 API → 详情 API → 快照留存 → 字段抽取 → 赛道拆分 → 附件下载。全程 robots / SSRF / 限流保护。
        </div>
      </div>

      <div className="grid-main">
        <div>
          <Card title="验证批次" subtitle="同一时刻仅允许一个进行中的蓝桥杯验证批次">
            <div className="toolbar" style={{ marginBottom: 12 }}>
              <select className="select" style={{ maxWidth: 320 }} value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
              <Button variant="primary" disabled={busy || !sourceId} onClick={() => void createBatch()}>
                <Icon name="plus" size={14} /> 创建验证批次
              </Button>
            </div>

            <AsyncState status={status} message={error} onRetry={() => void load()}>
              {batches.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">
                    <Icon name="shield" size={20} />
                  </div>
                  <div className="empty-title">暂无验证批次</div>
                  <div className="empty-desc">选择蓝桥杯官方源并创建批次，即可执行真实采集。</div>
                </div>
              ) : (
                <div className="list">
                  {batches.map((batch) => {
                    const meta = STATUS_META[batch.status] ?? STATUS_META.created;
                    return (
                      <div key={batch.id} className="list-row">
                        <div className="stretch">
                          <button className="list-title" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' }} onClick={() => void openDetail(batch.id)}>
                            {batch.name}
                          </button>
                          <div className="list-sub">
                            竞赛 {batch.counts.competitions} · 快照 {batch.counts.snapshots} · 附件 {batch.counts.attachments} · {formatDateTime(batch.createdAt)}
                          </div>
                        </div>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </div>
                    );
                  })}
                </div>
              )}
            </AsyncState>
          </Card>

          {selected && (
            <Card title="批次竞赛子项" subtitle={`共 ${selected.counts.competitions} 个，多赛道已拆分`}>
              {selected.competitions.length === 0 ? (
                <AsyncState status="empty" message="批次内暂无竞赛，请先启动真实采集" />
              ) : (
                <div className="list">
                  {selected.competitions.map((item) => (
                    <div key={item.id} className="list-row">
                      <div className="stretch">
                        <Link to={`/competitions/${item.id}`} className="list-title">
                          {item.name}
                        </Link>
                        <div className="comp-meta">
                          <RegistrationBadge value={item.registrationStatus} />
                          <CompletenessBadge value={item.completeness} />
                          <CredibilityBadge value={item.credibility} />
                          <Badge tone={item.dataOrigin === 'verification' ? 'info' : 'success'}>
                            {item.dataOrigin === 'verification' ? '验证数据' : '正式数据'}
                          </Badge>
                          {item.level && <Badge tone="neutral">{item.level}</Badge>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}
        </div>

        <div>
          <Card title="批次操作" subtitle={selected ? selected.name : '选择左侧批次查看'}>
            {!selected ? (
              <div className="empty-state">
                <div className="empty-icon">
                  <Icon name="dashboard" size={20} />
                </div>
                <div className="empty-title">未选择批次</div>
                <div className="empty-desc">创建或选择一个验证批次后，可启动真实采集、转正式或清除。</div>
              </div>
            ) : (
              <>
                <div className="list">
                  <div className="list-row">
                    <span className="stretch muted">状态</span>
                    <Badge tone={(STATUS_META[selected.status] ?? STATUS_META.created).tone}>
                      {(STATUS_META[selected.status] ?? STATUS_META.created).label}
                    </Badge>
                  </div>
                  <div className="list-row">
                    <span className="stretch muted">竞赛 / 候选</span>
                    <span className="mono">{selected.counts.competitions} / {selected.counts.candidates}</span>
                  </div>
                  <div className="list-row">
                    <span className="stretch muted">快照 / 附件</span>
                    <span className="mono">{selected.counts.snapshots} / {selected.counts.attachments}</span>
                  </div>
                  <div className="list-row">
                    <span className="stretch muted">采集上限</span>
                    <span className="mono">{selected.entryLimit} 条</span>
                  </div>
                </div>

                <div className="divider" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Button
                    variant="primary"
                    disabled={busy || !['created', 'failed'].includes(selected.status)}
                    onClick={() => void collect(selected.id)}
                  >
                    <Icon name="download" size={14} /> {busy ? '正在采集…' : '启动真实采集'}
                  </Button>
                  <Button
                    disabled={busy || selected.status !== 'verifying'}
                    onClick={() => void promote(selected.id)}
                  >
                    <Icon name="check" size={14} /> 转正式数据
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy || selected.status === 'cleared'}
                    onClick={() => void clear(selected.id)}
                  >
                    清除批次
                  </Button>
                </div>

                {selected.report.message && (
                  <div className="banner" style={{ marginTop: 12 }}>
                    <Icon name="file" size={14} />
                    <div>{selected.report.message}</div>
                  </div>
                )}
              </>
            )}
          </Card>

          {message && (
            <div className="banner info" style={{ marginTop: 12 }}>
              <Icon name="spark" size={14} />
              <div>{message}</div>
            </div>
          )}

          <Card title="验证流程" subtitle="真实采集的完整证据链">
            <div className="timeline">
              {['创建批次并绑定官方源', '真实请求公告列表 API', '保存列表快照', '逐条抓取详情并保存快照', '抽取字段并拆分赛道', '下载附件并安全校验', '验证后转正式并发布'].map((step) => (
                <div key={step} className="timeline-item">
                  <div className="timeline-title">{step}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}