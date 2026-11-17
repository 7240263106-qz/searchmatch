import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CompetitionCard, CompetitionDetail, ReviewQueueItem } from '@competition/contracts';
import AgentDiscovery from '../components/AgentDiscovery';
import DiscoveryTracks from '../components/DiscoveryTracks';
import { AsyncState, Badge, Button, Card, CompletenessBadge, Icon, PageHeader } from '../components/ui';
import { api, getUser } from '../lib/api';
import { formatDate, formatDateTime } from '../lib/format';

interface DraftList {
  items: CompetitionCard[];
  total: number;
  pageSize: number;
}

type Entry = { id: string; name: string; draft: CompetitionCard } |
  { id: string; name: string; review: ReviewQueueItem };
type ReviewAction = 'submit-review' | 'publish' | 'reject';

const OUTCOME: Record<ReviewAction, string> = {
  'submit-review': '已提交审核，可在「待审核」中由审核人员处理。',
  publish: '审核通过，已发布到竞赛库。',
  reject: '已退回草稿，录入人可修改后重新提交。',
};

function EntryMeta({ entry }: { entry: Entry }): JSX.Element {
  if ('draft' in entry) {
    const item = entry.draft;
    return (
      <div className="comp-meta">
        {item.schoolRecognitionLevel && <span>学校认定 {item.schoolRecognitionLevel}</span>}
        {item.organizer && <span>{item.organizer}</span>}
        {item.category && <span>{item.category}</span>}
        {item.level && <span>{item.level}</span>}
        {item.nearestDeadline?.at && <span>报名截止 {formatDate(item.nearestDeadline.at)}</span>}
      </div>
    );
  }
  const item = entry.review;
  return (
    <div className="comp-meta">
      <CompletenessBadge value={item.completeness} />
      {item.conflictCount > 0 && <span>{item.conflictCount} 组冲突</span>}
      <span>优先级 {item.priority} · {item.priorityReason}</span>
      <span>提交于 {formatDateTime(item.submittedAt)} · 等待 {item.waitingHours} 小时</span>
    </div>
  );
}

export default function ReviewPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const canReview = getUser().roles.some(role => role === 'reviewer' || role === 'admin');
  const draftMode = !canReview || params.get('status') === 'draft';
  const documentId = draftMode ? params.get('documentId') : null;
  const requestedPage = Number(params.get('page') ?? 1);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const selectedId = params.get('competitionId');
  const query = new URLSearchParams({ page: String(page) });
  if (documentId) query.set('documentId', documentId);
  const endpoint = draftMode ? '/competitions/my-drafts?' + query.toString() : '/reviews/queue';

  const [data, setData] = useState<{ endpoint: string; items: Entry[]; total: number; pageSize?: number }>();
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<ReviewAction | null>(null);
  const [savingFields, setSavingFields] = useState(false);
  const [unsavedTracks, setUnsavedTracks] = useState(false);
  const [savedDetail, setSavedDetail] = useState<CompetitionDetail | null>(null);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState<{ action: ReviewAction; competitionId: string } | null>(null);
  const result = data?.endpoint === endpoint ? data : undefined;
  const selected = result?.items.find(item => item.id === selectedId);
  const locked = Boolean(busy || savingFields);
  const savedTracks = savedDetail?.id === selectedId ? savedDetail.discoveryTracks ?? [] : [];

  useEffect(() => {
    let active = true;
    setLoadError('');
    const load = async (): Promise<void> => {
      try {
        const response = draftMode ? await api.get<DraftList>(endpoint) : await api.get<ReviewQueueItem[]>(endpoint);
        if (!active) return;
        setData(Array.isArray(response)
          ? { endpoint, items: response.map(review => ({ id: review.competitionId, name: review.name, review })), total: response.length }
          : { endpoint, items: response.items.map(draft => ({ id: draft.id, name: draft.name, draft })), total: response.total, pageSize: response.pageSize });
      } catch (reason) {
        if (active) setLoadError((reason as Error).message);
      }
    };
    void load();
    return () => { active = false; };
  }, [draftMode, endpoint, reload]);

  useEffect(() => {
    setComment('');
    setActionError('');
    setUnsavedTracks(false);
    if (!selectedId) return;
    let active = true;
    void api.get<CompetitionDetail>('/competitions/' + selectedId).then(detail => {
      if (active) setSavedDetail(current => current?.id === detail.id && current.versionNo > detail.versionNo ? current : detail);
    }).catch(() => {});
    return () => { active = false; };
  }, [draftMode, selectedId]);

  const refresh = (): void => {
    setData(undefined);
    setLoadError('');
    setReload(value => value + 1);
  };

  const listParams = new URLSearchParams(params);
  listParams.delete('competitionId');

  const select = (competitionId: string | null): void => {
    const next = new URLSearchParams(listParams);
    if (competitionId) next.set('competitionId', competitionId);
    else refresh();
    setNotice(null);
    setParams(next);
  };

  const goToPage = (nextPage: number): void => {
    listParams.set('page', String(nextPage));
    setParams(listParams);
  };

  const act = async (action: ReviewAction): Promise<void> => {
    if (!selected || locked || (action === 'reject' && !comment.trim())) return;
    setBusy(action);
    setActionError('');
    try {
      await api.post('/competitions/' + selected.id + '/' + action, { comment: comment.trim() || undefined });
      setNotice({ action, competitionId: selected.id });
      if (result?.pageSize && result.items.length === 1 && page > 1) {
        listParams.set('page', String(page - 1));
      }
      setParams(listParams, { replace: true });
      refresh();
    } catch (reason) {
      setActionError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="竞赛审核"
        description="在草稿或待审核队列中选择竞赛，检索本年度官网和公告，核对后再提交审核或发布。"
      />
      {canReview && (
        <nav className="review-status-nav" aria-label="竞赛状态">
          <Button variant={draftMode ? 'primary' : undefined} aria-current={draftMode ? 'page' : undefined}
            disabled={locked} onClick={() => { setNotice(null); setParams({ status: 'draft' }); }}>我的草稿</Button>
          <Button variant={!draftMode ? 'primary' : undefined} aria-current={!draftMode ? 'page' : undefined}
            disabled={locked} onClick={() => { setNotice(null); setParams({ status: 'pending' }); }}>待审核</Button>
        </nav>
      )}
      {notice && (
        <div className="banner success">
          <span className="stretch" role="status">{OUTCOME[notice.action]}</span>
          {notice.action === 'publish' && (
            <Link className="btn sm" to={'/competitions/' + notice.competitionId}>查看已发布竞赛</Link>
          )}
        </div>
      )}

      {selected ? (
        <div className="review-workspace">
          <Card>
            <div className="review-selected">
              <div className="stretch draft-summary">
                <Badge tone="info">{draftMode ? '草稿' : '待审核'}</Badge>
                <h2>{selected.name}</h2>
                <EntryMeta entry={selected} />
              </div>
              <div className="toolbar">
                <Button size="sm" onClick={() => select(null)} disabled={locked}>返回列表</Button>
                <Link className="btn sm" to={'/competitions/' + selected.id}>查看竞赛详情</Link>
              </div>
            </div>
            <div className="review-action">
              {!draftMode && (
                <label className="review-comment">
                  <span className="field-label">审核意见（退回时必填）</span>
                  <input className="input" value={comment} disabled={locked} onChange={event => setComment(event.target.value)} />
                </label>
              )}
              <div className="toolbar">
                {draftMode ? (
                  <Button variant="primary" disabled={locked} onClick={() => void act('submit-review')}>
                    {busy === 'submit-review' ? '提交中…' : '提交审核'}
                  </Button>
                ) : (
                  <>
                    <Button variant="primary" disabled={locked} onClick={() => void act('publish')}>
                      {busy === 'publish' ? '发布中…' : '通过并发布'}
                    </Button>
                    <Button variant="danger" disabled={locked || !comment.trim()} onClick={() => void act('reject')}>
                      {busy === 'reject' ? '退回中…' : '退回草稿'}
                    </Button>
                  </>
                )}
              </div>
            </div>
            {unsavedTracks && <p className="discovery-hint" role="status">本次采集的赛道资料尚未保存。要随竞赛送审或发布，请先点击「保存赛道资料」。</p>}
            {actionError && <p className="discovery-error" role="alert">{actionError}</p>}
          </Card>
          <DiscoveryTracks tracks={savedTracks} saved />
          <AgentDiscovery key={selected.id} competition={selected} actionsDisabled={Boolean(busy)}
            onSavingChange={setSavingFields} onSave={setSavedDetail} onUnsavedTracksChange={setUnsavedTracks} />
        </div>
      ) : (
        <Card title={draftMode ? (documentId ? '此文档录入的草稿' : '我的草稿') : '待审核队列'}
          subtitle={result && `共 ${result.total} 项`}
          actions={
            <div className="toolbar">
              {documentId && <Link className="btn sm" to="?status=draft">查看全部草稿</Link>}
              <Button size="sm" onClick={refresh}><Icon name="refresh" size={14} /> 刷新</Button>
            </div>
          }>
          <AsyncState status={loadError ? 'error' : result ? 'ready' : 'loading'} message={loadError} onRetry={refresh}>
            {selectedId && <p className="muted">该竞赛已不在当前列表中。</p>}
            {result?.items.length === 0 && (
              <p className="muted">{draftMode
                ? (documentId ? '这份文档当前没有草稿。' : '还没有竞赛草稿。可在文档核对后保存。')
                : '目前没有待审核竞赛。'}</p>
            )}
            <ul className="list review-entries">
              {result?.items.map(item => (
                <li key={item.id} className="list-row">
                  <div className="stretch draft-summary">
                    <Link className="list-title" to={'/competitions/' + item.id}>{item.name}</Link>
                    <EntryMeta entry={item} />
                  </div>
                  <Button size="sm" onClick={() => select(item.id)}>
                    <Icon name="search" size={14} /> {draftMode ? '核对与智能体检索' : '审核与智能体检索'}
                  </Button>
                </li>
              ))}
            </ul>
            {result?.pageSize !== undefined && (page > 1 || result.total > result.pageSize) && (
              <div className="toolbar draft-pagination">
                <Button size="sm" disabled={page <= 1} onClick={() => goToPage(page - 1)}>上一页</Button>
                <span>第 {page} 页</span>
                <Button size="sm" disabled={page * result.pageSize >= result.total} onClick={() => goToPage(page + 1)}>下一页</Button>
              </div>
            )}
          </AsyncState>
        </Card>
      )}
    </>
  );
}
