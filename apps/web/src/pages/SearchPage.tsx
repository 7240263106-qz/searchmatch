import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CompetitionCard, CompetitionDetail, SearchQuery, SearchResult } from '@competition/contracts';
import { api, getUser } from '../lib/api';
import { compactCompetitionDate, formatDate, timeLeft } from '../lib/format';
import { DiscoveryTrackList } from '../components/DiscoveryTracks';
import {
  AsyncState,
  Badge,
  Button,
  Card,
  CompletenessBadge,
  CredibilityBadge,
  Icon,
  PageHeader,
  PublishBadge,
  RegistrationBadge,
  SiteBadge,
} from '../components/ui';

const CATEGORIES = [
  '计算机与软件',
  '数学与统计',
  '电子信息',
  '物理与力学',
  '化学与生物',
  '机械与制造',
  '创新创业',
  '设计与艺术',
  '外语与人文',
];

const LEVELS = ['国家级', '省级', '市级', '校级', '国际级'];
const STATUSES: Array<{ key: string; label: string }> = [
  { key: 'open', label: '报名中' },
  { key: 'closing_soon', label: '即将截止' },
  { key: 'not_started', label: '未开始' },
  { key: 'undetermined', label: '时间待定' },
];

export default function SearchPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const canManage = getUser().roles.some(role => ['editor', 'reviewer', 'admin'].includes(role));
  const defaultScope = canManage ? 'workspace' : 'published';
  const [scope, setScope] = useState<NonNullable<SearchQuery['scope']>>(defaultScope);
  const documentId = params.get('documentId') ?? undefined;
  const [keyword, setKeyword] = useState(params.get('q') ?? '');
  const [categories, setCategories] = useState<string[]>([]);
  const [levels, setLevels] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [includeLow, setIncludeLow] = useState(true);
  const [includeExpired, setIncludeExpired] = useState(canManage);
  const [sort, setSort] = useState<NonNullable<SearchQuery['sort']>>('default');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'empty'>('loading');
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [childrenMap, setChildrenMap] = useState<Record<string, CompetitionDetail>>({});
  const [childrenLoading, setChildrenLoading] = useState<string | null>(null);
  const [trackLoadError, setTrackLoadError] = useState<string | null>(null);

  const query = useMemo<SearchQuery>(
    () => ({
      scope,
      keyword: keyword || undefined,
      documentId,
      categories: categories.length ? categories : undefined,
      levels: levels.length ? levels : undefined,
      registrationStatus: statuses.length ? (statuses as SearchQuery['registrationStatus']) : undefined,
      includeLowCredibility: includeLow || Boolean(documentId),
      includeExpired: includeExpired || Boolean(documentId),
      sort,
      limit: 20,
      cursor: cursor ?? undefined,
    }),
    [scope, keyword, documentId, categories, levels, statuses, includeLow, includeExpired, sort, cursor],
  );

  const search = (): void => {
    setState('loading');
    api
      .post<SearchResult>('/search/competitions', query)
      .then((data) => {
        setResult(data);
        setState(data.items.length === 0 ? 'empty' : 'ready');
      })
      .catch((reason: Error) => {
        setError(reason.message);
        setState('error');
      });
  };

  useEffect(() => {
    setKeyword(params.get('q') ?? '');
    setCursor(null);
    setPageIndex(0);
  }, [params]);

  useEffect(search, [query]);

  const loadTracks = async (id: string): Promise<void> => {
    setTrackLoadError(null);
    setChildrenLoading(id);
    try {
      const detail = await api.get<CompetitionDetail>(`/competitions/${id}`);
      setChildrenMap(current => ({ ...current, [id]: detail }));
    } catch {
      setTrackLoadError(id);
    } finally {
      setChildrenLoading(current => current === id ? null : current);
    }
  };

  const toggleExpand = (item: CompetitionCard): void => {
    const isOpen = expandedId === item.id;
    setExpandedId(isOpen ? null : item.id);
    if (!isOpen && !childrenMap[item.id]) void loadTracks(item.id);
  };

  const toggle = (list: string[], setList: (value: string[]) => void, key: string): void => {
    setCursor(null);
    setPageIndex(0);
    setList(list.includes(key) ? list.filter((item) => item !== key) : [...list, key]);
  };

  const activeCount =
    categories.length +
    levels.length +
    statuses.length +
    (!includeLow && !documentId ? 1 : 0) +
    (includeExpired !== canManage && !documentId ? 1 : 0) +
    (scope !== defaultScope ? 1 : 0) +
    (keyword ? 1 : 0);

  return (
    <>
      <PageHeader
        title="竞赛检索"
        description={scope === 'workspace'
          ? `${documentId ? '显示这份文档关联的可见竞赛' : '显示已发布竞赛、我的草稿及有权查看的待审核记录'}。审核状态会单独标注，默认包含已截止竞赛。`
          : documentId ? '显示这份文档关联的已发布竞赛。' : '搜索已发布的竞赛。低可信记录会标注，已截止记录可在筛选中显示。'}
        actions={
          <>
            {documentId && <Link to="/library" className="btn sm">查看全部竞赛</Link>}
            <Button
              onClick={() => {
                setKeyword('');
                setCategories([]);
                setLevels([]);
                setStatuses([]);
                setIncludeLow(true);
                setIncludeExpired(canManage);
                setScope(defaultScope);
                setCursor(null);
                setPageIndex(0);
                setParams(documentId ? { documentId } : {});
              }}
            >
              清空条件{activeCount > 0 ? `（${activeCount}）` : ''}
            </Button>
          </>
        }
      />

      <div className="grid-main">
        <div>
          <Card>
            <div className="toolbar">
              <div className="topbar-search library-search" style={{ width: '100%', maxWidth: 420 }}>
                <Icon name="search" size={14} />
                <input
                  placeholder="搜索竞赛名称、学科、主办方关键词…"
                  value={keyword}
                  onChange={(event) => {
                    setKeyword(event.target.value);
                    setCursor(null);
                    setPageIndex(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      const next = new URLSearchParams(params);
                      if (keyword) next.set('q', keyword);
                      else next.delete('q');
                      setParams(next);
                    }
                  }}
                />
              </div>
              <select
                className="select"
                style={{ width: 150 }}
                value={sort}
                onChange={(event) => setSort(event.target.value as NonNullable<SearchQuery['sort']>)}
              >
                <option value="default">默认排序</option>
                <option value="deadline_asc">截止时间升序</option>
                <option value="deadline_desc">截止时间降序</option>
                <option value="credibility_desc">可信度优先</option>
              </select>
              <div className="topbar-spacer" />
              <span className="muted mono">
                {result ? `共 ${result.page.total} 条` : '查询中'}
              </span>
            </div>
          </Card>

          <div style={{ marginTop: 14 }}>
            <AsyncState
              status={state === 'ready' ? 'ready' : state}
              message={error}
              onRetry={search}
            >
              {result && (
                <Card>
                  {result.items.map((item) => (
                    <CompetitionRow
                      key={item.id}
                      item={item}
                      expanded={expandedId === item.id}
                      loading={childrenLoading === item.id}
                      detail={childrenMap[item.id]}
                      failed={trackLoadError === item.id}
                      onRetry={() => void loadTracks(item.id)}
                      onToggle={() => toggleExpand(item)}
                    />
                  ))}
                  <div className="toolbar" style={{ paddingTop: 14, justifyContent: 'space-between' }}>
                    <span className="muted">
                      第 {pageIndex + 1} 页 · 每页 {result.page.limit} 条
                    </span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button
                        size="sm"
                        disabled={pageIndex === 0}
                        onClick={() => {
                          setCursor(null);
                          setPageIndex(0);
                        }}
                      >
                        上一页
                      </Button>
                      <Button
                        size="sm"
                        disabled={!result.page.hasMore}
                        onClick={() => {
                          setCursor(result.page.nextCursor ?? null);
                          setPageIndex((value) => value + 1);
                        }}
                      >
                        下一页 <Icon name="arrow" size={13} />
                      </Button>
                    </div>
                  </div>
                </Card>
              )}
            </AsyncState>
          </div>
        </div>

        <div>
          <Card title="筛选条件" subtitle="选择后即时生效">
            {canManage && <div className="filter-group">
              <label className="filter-label" htmlFor="competition-search-scope">竞赛范围</label>
              <select
                id="competition-search-scope"
                className="select"
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value as NonNullable<SearchQuery['scope']>);
                  setCursor(null);
                  setPageIndex(0);
                }}
              >
                <option value="workspace">全部可见竞赛</option>
                <option value="published">已发布竞赛</option>
              </select>
            </div>}
            <div className="filter-group">
              <div className="filter-label">学科分类</div>
              <div className="chips">
                {CATEGORIES.map((item) => (
                  <button
                    key={item}
                    className={`chip${categories.includes(item) ? ' active' : ''}`}
                    onClick={() => toggle(categories, setCategories, item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
            <div className="filter-group">
              <div className="filter-label">竞赛级别</div>
              <div className="chips">
                {LEVELS.map((item) => (
                  <button
                    key={item}
                    className={`chip${levels.includes(item) ? ' active' : ''}`}
                    onClick={() => toggle(levels, setLevels, item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
            <div className="filter-group">
              <div className="filter-label">报名状态</div>
              <div className="chips">
                {STATUSES.map((item) => (
                  <button
                    key={item.key}
                    className={`chip${statuses.includes(item.key) ? ' active' : ''}`}
                    onClick={() => toggle(statuses, setStatuses, item.key)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="filter-group">
              <label className="filter-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={includeLow || Boolean(documentId)} disabled={Boolean(documentId)} onChange={(event) => {
                  setIncludeLow(event.target.checked);
                  setCursor(null);
                  setPageIndex(0);
                }} />
                包含低可信信息及入口疑似失效的竞赛
              </label>
              <label className="filter-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={includeExpired || Boolean(documentId)}
                  disabled={Boolean(documentId)}
                  onChange={(event) => {
                    setIncludeExpired(event.target.checked);
                    setCursor(null);
                    setPageIndex(0);
                  }}
                />
                包含已截止竞赛
              </label>
            </div>

            {result?.excluded && result.excluded.count > 0 && (
              <div className="banner" style={{ marginTop: 12 }}>
                <Icon name="filter" size={14} />
                <div>
                  已隐藏 {result.excluded.count} 条：
                  {result.excluded.reasons.map(reason =>
                    `${reason.key === 'low_credibility' ? '低可信' : reason.label} ${reason.count}`).join('，')}
                </div>
              </div>
            )}
          </Card>

          {result && result.facets.category.length > 0 && (
            <Card title="结果分布" subtitle="基于本次查询结果统计" className="fade-in">
              <div className="list">
                {result.facets.category.slice(0, 6).map((bucket) => (
                  <div key={bucket.key} className="list-row">
                    <span className="stretch muted">{bucket.label}</span>
                    <span className="mono">{bucket.count}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function CompetitionRow({
  item,
  expanded,
  loading,
  detail,
  failed,
  onRetry,
  onToggle,
}: {
  item: CompetitionCard;
  expanded: boolean;
  loading: boolean;
  detail?: CompetitionDetail;
  failed: boolean;
  onRetry: () => void;
  onToggle: () => void;
}): JSX.Element {
  const tracks = detail?.discoveryTracks ?? [];
  const childrenItems = detail?.children ?? [];
  const hasTracks = Boolean(item.discoveryTrackCount || item.childCount);
  return (
    <div className="comp-card-wrap">
      <div className="comp-card">
        <div className="stretch">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Link to={`/competitions/${item.id}`} className="comp-title">
              {item.name}
            </Link>
            {item.favorited && <Badge tone="accent">已收藏</Badge>}
          </div>
          <div className="comp-meta">
            {item.seriesName && item.seriesName !== item.name && <span>{item.seriesName}</span>}
            {item.editionName && <span>· {item.editionName}</span>}
            {item.trackName && <span>· {item.trackName}</span>}
            {item.discoveryTrackCount ? <span>{item.discoveryTrackCount} 组赛道{item.discoverySubjectCount ? ` · ${item.discoverySubjectCount} 个科目` : ''}</span>
              : item.childCount ? <span>{item.childCount} 个赛道子项</span> : null}
            {item.organizer && <span>· {item.organizer}</span>}
          </div>
          <div className="comp-meta" style={{ marginTop: 8 }}>
            <PublishBadge value={item.publishStatus} />
            <RegistrationBadge value={item.registrationStatus} />
            <CredibilityBadge value={item.credibility} />
            {item.siteStatus === 'suspected_invalid' && <SiteBadge value={item.siteStatus} />}
            {item.category && <Badge tone="neutral">{item.category}</Badge>}
            {item.level && <Badge tone="neutral">{item.level}</Badge>}
            {item.schoolRecognitionLevel && <Badge tone="neutral">学校认定 {item.schoolRecognitionLevel}</Badge>}
          </div>
        </div>
        <div className="comp-actions competition-list-actions">
          {item.nearestDeadline?.at && (
            <div className="competition-deadline" data-closed={item.registrationStatus === 'closed' || undefined}>
              <small>
                {item.discoveryTrackCount ? '最近赛项截止' : '报名截止'} · {timeLeft(
                  Math.ceil(
                    (new Date(item.nearestDeadline.at).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
                  ),
                )}
              </small>
              <time dateTime={item.nearestDeadline.at}>{compactCompetitionDate(item.nearestDeadline.rawText ?? formatDate(item.nearestDeadline.at))}</time>
            </div>
          )}
          <div className="competition-list-buttons">
          {hasTracks && <button
            type="button"
            className="icon-button accordion-chevron"
            aria-expanded={expanded}
            aria-label={expanded ? '收起赛道' : '展开赛道'}
            style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
            onClick={onToggle}
          >
            <Icon name="arrow" size={14} />
          </button>}
          <Link to={`/competitions/${item.id}`} className="btn sm">
            详情
          </Link>
          <Link to={`/competitions/${item.id}?collect=1`} className="btn sm">智能体采集</Link>
          </div>
        </div>
      </div>

      {hasTracks && expanded && (
        <div className="comp-expand fade-in">
          {loading ? (
            <div>
              <div className="skeleton" style={{ height: 44, marginBottom: 8 }} />
              <div className="skeleton" style={{ height: 44 }} />
            </div>
          ) : failed ? (
            <div className="toolbar"><span>暂时无法加载赛道</span><Button size="sm" onClick={onRetry}>重试</Button></div>
          ) : (
            <>
            {tracks.length > 0 && <DiscoveryTrackList tracks={tracks} />}
            {childrenItems.length > 0 && (
            <div className="competition-track-layout">
              <div className="comp-expand-label">赛道子项</div>
              <div className="competition-subgrid">
              {childrenItems.map((child) => (
                <Link key={child.id} to={`/competitions/${child.id}`} className="comp-child-row competition-subcard">
                  <div className="stretch">
                    <div className="list-title">{child.trackName ?? child.name}</div>
                    <div className="comp-meta">
                      <RegistrationBadge value={child.registrationStatus} />
                      <CompletenessBadge value={child.completeness} />
                      <CredibilityBadge value={child.credibility} />
                    </div>
                  </div>
                  {child.nearestDeadline?.at ? (
                    <span className="competition-deadline" data-closed={child.registrationStatus === 'closed' || undefined}>
                      <small>报名截止</small>
                      <time dateTime={child.nearestDeadline.at}>{compactCompetitionDate(child.nearestDeadline.rawText ?? formatDate(child.nearestDeadline.at))}</time>
                    </span>
                  ) : <small className="muted">日期待核实</small>}
                  <Icon name="arrow" size={13} />
                </Link>
              ))}
              </div>
            </div>
            )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
