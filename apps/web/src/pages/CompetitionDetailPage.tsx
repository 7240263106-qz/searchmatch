import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { CompetitionDetail, EvidenceView } from '@competition/contracts';
import { api } from '../lib/api';
import { compactCompetitionDate, formatDate, formatDateTime, timeLeft } from '../lib/format';
import AgentDiscovery from '../components/AgentDiscovery';
import DiscoveryTracks from '../components/DiscoveryTracks';
import {
  AsyncState,
  Badge,
  Button,
  Card,
  CompletenessBadge,
  CredibilityBadge,
  FieldStateBadge,
  Icon,
  PageHeader,
  PublishBadge,
  RegistrationBadge,
  SiteBadge,
} from '../components/ui';

const FIELD_GROUPS: Array<{ title: string; fields: Array<{ key: keyof CompetitionDetail; label: string }> }> = [
  {
    title: '基础字段',
    fields: [
      { key: 'name', label: '竞赛名称' },
      { key: 'seriesName', label: '竞赛系列' },
      { key: 'editionName', label: '届次' },
      { key: 'trackName', label: '赛项' },
      { key: 'category', label: '学科分类' },
      { key: 'level', label: '竞赛级别' },
      { key: 'schoolRecognitionLevel', label: '学校认定等级' },
      { key: 'schoolRecognitionScope', label: '认定学校' },
      { key: 'organizer', label: '主办机构' },
    ],
  },
  {
    title: '报名字段',
    fields: [
      { key: 'registrationStatus', label: '报名状态' },
      { key: 'signupMethod', label: '报名方式' },
    ],
  },
  {
    title: '参赛条件',
    fields: [
      { key: 'description', label: '比赛内容' },
      { key: 'eligibility', label: '参赛对象' },
      { key: 'schedule', label: '比赛时间' },
      { key: 'awards', label: '奖项设置' },
    ],
  },
];

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).join('；') || '—';
  }
  return String(value);
}

export default function CompetitionDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const collecting = params.get('collect') === '1';
  const [detail, setDetail] = useState<CompetitionDetail | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState('');
  const [pendingJump, setPendingJump] = useState<{ url: string; reason: string } | null>(null);
  const [evidence, setEvidence] = useState<EvidenceView[]>([]);
  const [expandedChildId, setExpandedChildId] = useState<string | null>(null);

  const load = (): void => {
    if (!id) return;
    setStatus('loading');
    api
      .get<CompetitionDetail>(`/competitions/${id}`)
      .then((data) => {
        setDetail(data);
        setStatus('ready');
      })
      .catch((reason: Error) => {
        setError(reason.message);
        setStatus('error');
      });
  };

  useEffect(load, [id, collecting]);

  const action = async (path: string, body?: Record<string, unknown>): Promise<void> => {
    if (!id) return;
    setBusy(true);
    try {
      await api.post(`/competitions/${id}/${path}`, body ?? {});
      load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verifyEntry = async (entryId: string): Promise<void> => {
    setBusy(true);
    try {
      await api.post(`/signup-entries/${entryId}/verify`);
      load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openEntry = async (entryId: string, url: string | null | undefined, trusted: boolean): Promise<void> => {
    if (!url) return;
    if (trusted) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    try {
      const resolved = await api.get<{ targetUrl: string; requiresConfirmation: boolean; reason: string }>(
        `/signup-entries/${entryId}/resolve-redirect`,
      );
      if (!resolved.requiresConfirmation) {
        window.open(resolved.targetUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      setPendingJump({ url: resolved.targetUrl, reason: resolved.reason });
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        title={detail?.name ?? '竞赛详情'}
        description={collecting ? undefined : detail ? `${detail.seriesName ?? ''} ${detail.editionName ?? ''} ${detail.trackName ?? ''}`.trim() : undefined}
        actions={
          <>
            <Link to="/library" className="btn">
              返回检索
            </Link>
            {detail?.publishStatus === 'published' && (
              <Link to={collecting ? `/competitions/${detail.id}` : '?collect=1'} className="btn">
                {collecting ? '返回竞赛详情' : '智能体采集'}
              </Link>
            )}
            {detail?.parentId && (
              <Link to={`/competitions/${detail.parentId}`} className="btn">
                <Icon name="arrow" size={14} /> 返回所属竞赛
              </Link>
            )}
            {detail && (
              <Button
                onClick={() => {
                  void api.post(`/competitions/${detail.id}/favorite`, { favorite: !detail.favorited }).then(load);
                }}
              >
                <Icon name="spark" size={14} /> {detail.favorited ? '取消收藏' : '收藏'}
              </Button>
            )}
          </>
        }
      />

      <AsyncState status={status} message={error} onRetry={load}>
        {detail?.publishStatus === 'published' && collecting && <AgentDiscovery key={detail.id} competition={detail} onSave={setDetail} />}
        {detail && !collecting && (
          <>
            <Card title="赛事概况" className="competition-detail-overview">
              <div className="comp-meta">
                <PublishBadge value={detail.publishStatus} />
                <RegistrationBadge value={detail.registrationStatus} />
                <CredibilityBadge value={detail.credibility} />
                {detail.schoolRecognitionLevel && <Badge tone="neutral">学校认定 {detail.schoolRecognitionLevel}</Badge>}
              </div>
              {detail.nearestDeadline?.at && (
                <div className="competition-deadline detail-deadline" data-closed={detail.registrationStatus === 'closed' || undefined}>
                  <small>{detail.discoveryTrackCount ? '最近赛项截止' : '报名截止'}</small>
                  <time dateTime={detail.nearestDeadline.at}>{compactCompetitionDate(detail.nearestDeadline.rawText ?? formatDate(detail.nearestDeadline.at))}</time>
                </div>
              )}
              {detail.organizer && <p>主办机构 · {detail.organizer}</p>}
              <details className="competition-detail-section">
                <summary>可信度 {detail.credibilityScore} 分 · 评分依据</summary>
                {detail.credibilityBasis && <ul>{detail.credibilityBasis.split('；').map(basis => <li key={basis}>{basis}</li>)}</ul>}
                <div className="comp-meta">
                  <CompletenessBadge value={detail.completeness} />
                  <SiteBadge value={detail.siteStatus} />
                  <span>版本 v{detail.versionNo} · {formatDateTime(detail.updatedAt)}</span>
                </div>
              </details>
              <details className="competition-detail-section" open={detail.publishStatus !== 'published' || undefined}>
                <summary>审核与发布管理</summary>
              <div className="toolbar">
                {detail.publishStatus === 'draft' && (
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => void action('submit-review', { comment: comment || '提交审核' })}
                  >
                    提交审核
                  </Button>
                )}
                {detail.publishStatus === 'pending_review' && (
                  <>
                    <Button variant="primary" disabled={busy} onClick={() => void action('publish')}>
                      审核通过并发布
                    </Button>
                    <Button variant="danger" disabled={busy || !comment.trim()} onClick={() => void action('reject', { comment })}>
                      退回修改
                    </Button>
                    {!comment.trim() && <span className="muted">退回前需填写审核意见</span>}
                  </>
                )}
                {detail.publishStatus === 'published' && (
                  <Button variant="danger" disabled={busy || !comment.trim()} onClick={() => void action('unpublish', { comment })}>
                    下架
                  </Button>
                )}
                {detail.publishStatus === 'unpublished' && (
                  <Button disabled={busy} onClick={() => void action('restore')}>
                    重新提交审核
                  </Button>
                )}
                <input
                  className="input"
                  style={{ maxWidth: 320 }}
                  placeholder="审核意见（退回/下架必填）"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
              </div>
              </details>
            </Card>

            <DiscoveryTracks tracks={detail.discoveryTracks ?? []} saved />

            {detail.children && detail.children.length > 0 && (
              <Card
                title="赛道子项"
                subtitle={`同一比赛的 ${detail.children.length} 个赛道，点击展开查看信息`}
              >
                <div className="accordion">
                  {detail.children.map((child) => {
                    const expanded = expandedChildId === child.id;
                    return (
                      <div key={child.id} className="accordion-item">
                        <button
                          type="button"
                          className={`accordion-trigger${expanded ? ' open' : ''}`}
                          aria-expanded={expanded}
                          onClick={() => setExpandedChildId(expanded ? null : child.id)}
                        >
                          <span className="stretch">
                            <span className="list-title">{child.trackName ?? child.name}</span>
                            <span className="comp-meta" style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                              <RegistrationBadge value={child.registrationStatus} />
                              <CompletenessBadge value={child.completeness} />
                              <CredibilityBadge value={child.credibility} />
                            </span>
                          </span>
                          <span className="accordion-chevron">
                            <Icon name="arrow" size={14} />
                          </span>
                        </button>
                        {expanded && (
                          <div className="accordion-panel fade-in">
                            <div className="form-grid">
                              <div>
                                <div className="field-label">报名状态</div>
                                <RegistrationBadge value={child.registrationStatus} />
                              </div>
                              <div>
                                <div className="field-label">最近截止</div>
                                <div className="mono">{formatDate(child.nearestDeadline?.at)}</div>
                              </div>
                              <div>
                                <div className="field-label">报名方式</div>
                                <div>{child.signupMethod === 'web' ? '网页报名' : child.signupMethod}</div>
                              </div>
                              <div>
                                <div className="field-label">可信度</div>
                                <CredibilityBadge value={child.credibility} />
                              </div>
                              <div>
                                <div className="field-label">完整性</div>
                                <CompletenessBadge value={child.completeness} />
                              </div>
                              <div>
                                <div className="field-label">报名入口状态</div>
                                <SiteBadge value={child.siteStatus} />
                              </div>
                            </div>
                            <div className="toolbar" style={{ marginTop: 12 }}>
                              <Link to={`/competitions/${child.id}`} className="btn primary sm">
                                查看详情 <Icon name="arrow" size={12} />
                              </Link>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            <details className="competition-detail-section" open={!detail.discoveryTrackCount || undefined}>
              <summary>报名入口、参赛条件与来源</summary>
            <div className="grid-main">
              <div>
                {FIELD_GROUPS.map((group) => (
                  <Card key={group.title} title={group.title} subtitle="字段状态与原始依据可在右侧查看">
                    <div className="form-grid">
                      {group.fields.filter(field => {
                        const value = detail[field.key];
                        return typeof value === 'object' && value !== null ? Object.values(value).some(Boolean) : Boolean(value);
                      }).map((field) => {
                        const state = detail.fieldStates[field.key as string];
                        return (
                          <div key={field.key as string}>
                            <div className="field-label">
                              {field.label} {state && <FieldStateBadge value={state} />}
                            </div>
                            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                              {renderValue(detail[field.key])}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </Card>
                ))}

                {detail.stages.length > 0 && <Card title="报名阶段">
                  {detail.stages.length === 0 ? (
                    <AsyncState status="empty" message="尚未配置报名阶段" />
                  ) : (
                    <div className="timeline">
                      {detail.stages.map((stage) => (
                        <div key={stage.id} className="timeline-item">
                          <div className="timeline-title">
                            {stage.name} <RegistrationBadge value={stage.status} />
                          </div>
                          <div className="timeline-sub">
                            {formatDate(stage.startAt?.at)} — {formatDate(stage.endAt?.at)}
                            {stage.endAt?.rawText ? ` · ${stage.endAt.rawText}` : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>}

                <Card title="来源材料" subtitle="每条竞赛至少关联一个信息来源">
                  <div className="list">
                    {detail.sources.map((source) => (
                      <div key={source.id} className="list-row">
                        <Icon name="file" size={15} />
                        <div className="stretch">
                          <div className="list-title">{source.title}</div>
                          <div className="list-sub">
                            {source.type} · {formatDateTime(source.capturedAt)}
                          </div>
                        </div>
                        {source.url && (
                          <a className="btn sm" href={source.url} target="_blank" rel="noreferrer">
                            打开 <Icon name="external" size={12} />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>
              </div>

              <div>
                {detail.entries.length > 0 && <Card title="报名入口">
                  {detail.entries.length === 0 ? (
                    <AsyncState status="empty" message="尚未配置报名入口" />
                  ) : (
                    <div className="list">
                      {detail.entries.map((entry) => (
                        <div key={entry.id} className="comp-card" style={{ padding: '12px 0' }}>
                          <div className="stretch">
                            <div className="list-title">{entry.type === 'official' ? '官方报名入口' : entry.type}</div>
                            {entry.url && <div className="list-sub">{entry.url}</div>}
                            {entry.note && <div className="list-sub" style={{ whiteSpace: 'pre-wrap' }}>{entry.note}</div>}
                            {entry.contact && <div className="list-sub">联系方式：{entry.contact}</div>}
                            {!entry.url && !entry.note && !entry.contact && <div className="list-sub">待补充</div>}
                            <div className="comp-meta">
                              <SiteBadge value={entry.status} />
                              {entry.lastCheckedAt && (
                                <span>校验于 {formatDateTime(entry.lastCheckedAt)}</span>
                              )}
                            </div>
                          </div>
                          <div className="comp-actions" style={{ flexDirection: 'column', gap: 6 }}>
                            <Button size="sm" onClick={() => void verifyEntry(entry.id)} disabled={busy}>
                              校验
                            </Button>
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => void openEntry(entry.id, entry.url, entry.trustedDomain === true)}
                              disabled={!entry.url}
                            >
                              前往报名
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>}

                {detail.evidenceFields.length > 0 && <Card title="字段依据">
                  {detail.evidenceFields.length === 0 ? (
                    <AsyncState status="empty" message="暂无字段依据" />
                  ) : (
                    <div className="tag-list">
                      {detail.evidenceFields.map((field) => (
                        <span key={field} className="chip">
                          {field}
                        </span>
                      ))}
                    </div>
                  )}
                </Card>}

                {detail.changeEvents.length > 0 && <Card title="重要变更">
                  {detail.changeEvents.length === 0 ? (
                    <AsyncState status="empty" message="暂无重要变更" />
                  ) : (
                    <div className="list">
                      {detail.changeEvents.map((event) => (
                        <div key={event.id} className="list-row">
                          <div className="stretch">
                            <div className="list-title">{event.type}</div>
                            <div className="list-sub">
                              {event.before ?? '—'} → {event.after ?? '—'}
                            </div>
                          </div>
                          <span className="muted mono">{formatDate(event.detectedAt)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>}
              </div>
            </div>
            </details>

            {error && <div className="toast">{error}</div>}

            {pendingJump && (
              <>
                <div className="drawer-backdrop" onClick={() => setPendingJump(null)} />
                <div className="drawer" style={{ width: 'min(460px, 92vw)', height: 'auto', top: '22vh', borderRadius: 16 }}>
                  <header className="drawer-head">
                    <Icon name="shield" size={16} />
                    <div className="card-title">跳转确认</div>
                  </header>
                  <div className="drawer-body">
                    <p className="muted">{pendingJump.reason}</p>
                    <p className="mono" style={{ wordBreak: 'break-all' }}>{pendingJump.url}</p>
                  </div>
                  <footer className="drawer-foot">
                    <Button onClick={() => setPendingJump(null)}>取消</Button>
                    <Button
                      variant="primary"
                      onClick={() => {
                        window.open(pendingJump.url, '_blank', 'noopener,noreferrer');
                        setPendingJump(null);
                      }}
                    >
                      确认前往
                    </Button>
                  </footer>
                </div>
              </>
            )}
          </>
        )}
      </AsyncState>
    </>
  );
}
