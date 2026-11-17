import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { EChartsOption } from 'echarts';
import type { DashboardOverview, DeadlineItem } from '@competition/contracts';
import { api } from '../lib/api';
import { formatDate, timeLeft } from '../lib/format';
import {
  AsyncState,
  Badge,
  Button,
  Card,
  Icon,
  MetricCard,
  PageHeader,
  RegistrationBadge,
  SiteBadge,
} from '../components/ui';
import Chart from '../components/Chart';

type Range = '7d' | '30d' | '90d';
type Basis = 'discovered' | 'ingested' | 'published';

interface EmptyStateInfo {
  empty: boolean;
  reason: string;
  guidance: string;
  counts: { published: number; formalDrafts: number; sources: number; activeBatches: number; crawlTasks: number };
  crawlEnabled: boolean;
}

export default function DashboardPage(): JSX.Element {
  const [range, setRange] = useState<Range>('7d');
  const [basis, setBasis] = useState<Basis>('published');
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [deadlines, setDeadlines] = useState<DeadlineItem[]>([]);
  const [emptyState, setEmptyState] = useState<EmptyStateInfo | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState('');

  const load = (): void => {
    setStatus('loading');
    Promise.all([
      api.get<DashboardOverview>(`/dashboard/overview?range=${range}&metricBasis=${basis}`),
      api.get<DeadlineItem[]>('/dashboard/deadlines?days=7'),
      api.get<EmptyStateInfo>('/system/empty-state'),
    ])
      .then(([overviewData, deadlineData, emptyData]) => {
        setOverview(overviewData);
        setDeadlines(deadlineData);
        setEmptyState(emptyData);
        setStatus('ready');
      })
      .catch((reason: Error) => {
        setError(reason.message);
        setStatus('error');
      });
  };

  useEffect(load, [range, basis]);

  const trendOption = useMemo<EChartsOption>(() => {
    const points = overview?.trend.points ?? [];
    return {
      grid: { left: 8, right: 12, top: 18, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: points.map((point) => point.date.slice(5)),
        axisLine: { lineStyle: { color: '#e4e7ec' } },
        axisLabel: { color: '#98a2b3', fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: 'rgba(152,162,179,0.16)' } },
        axisLabel: { color: '#98a2b3', fontSize: 10 },
      },
      series: [
        {
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          data: points.map((point) => point.count),
          lineStyle: { width: 2.5, color: '#4f6ef7' },
          itemStyle: { color: '#4f6ef7' },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(79,110,247,0.26)' },
                { offset: 1, color: 'rgba(79,110,247,0.02)' },
              ],
            },
          },
        },
      ],
    };
  }, [overview]);

  const categoryOption = useMemo<EChartsOption>(() => {
    const data = overview?.distributions.category ?? [];
    return {
      tooltip: { trigger: 'item' },
      legend: {
        bottom: 0,
        icon: 'circle',
        itemWidth: 7,
        itemHeight: 7,
        textStyle: { color: '#667085', fontSize: 11 },
      },
      series: [
        {
          type: 'pie',
          radius: ['52%', '74%'],
          center: ['50%', '44%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 4 },
          label: { show: false },
          data: data.map((bucket) => ({ name: bucket.label, value: bucket.count })),
          color: ['#4f6ef7', '#7c5cff', '#12b76a', '#2e90fa', '#f79009', '#f04438', '#98a2b3'],
        },
      ],
    };
  }, [overview]);

  return (
    <>
      <PageHeader
        title="竞赛总览"
        description="汇总已发布竞赛、报名窗口与审核积压，所有指标附带口径。"
        actions={
          <>
            <div className="segmented">
              {(['7d', '30d', '90d'] as Range[]).map((item) => (
                <button key={item} className={range === item ? 'active' : ''} onClick={() => setRange(item)}>
                  近 {item.replace('d', '')} 天
                </button>
              ))}
            </div>
            <Button onClick={load}>
              <Icon name="refresh" size={14} /> 刷新
            </Button>
          </>
        }
      />

      {emptyState?.empty && (
        <Card className="fade-in" title="当前为空白库" subtitle="系统未内置任何演示竞赛数据，所有信息需通过真实采集或上传获得">
          <div className="banner info">
            <Icon name="spark" size={16} />
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>开始收集真实竞赛信息</div>
              <div className="muted">{emptyState.guidance}</div>
            </div>
          </div>
          <div className="toolbar" style={{ marginTop: 12 }}>
            <Link to="/collection/web" className="btn primary">
              <Icon name="bot" size={14} /> 从官网采集
            </Link>
            <Link to="/collection/sources" className="btn">
              <Icon name="source" size={14} /> 配置信息源
            </Link>
            <Link to="/collection" className="btn">
              <Icon name="upload" size={14} /> 上传竞赛文档
            </Link>
          </div>
        </Card>
      )}

      <AsyncState status={status} message={error} onRetry={load}>
        {overview && (
          <>
            <div className="grid-kpi">
              <MetricCard
                label="已发布竞赛"
                value={overview.totals.published}
                hint={`${overview.definitions.published?.scope ?? ''}`}
                icon="dashboard"
              />
              <MetricCard
                label="报名中 · 7 天内截止"
                value={overview.totals.closingSoon}
                hint="优先关注即将截止的报名窗口"
                icon="clock"
                accent
              />
              <MetricCard
                label="待审核"
                value={overview.totals.pendingReview}
                hint={`最久等待 ${overview.quality.pendingReviewOldestHours} 小时`}
                icon="review"
              />
              <MetricCard
                label="字段完整率"
                value={`${overview.quality.completenessRate}%`}
                hint="关键字段完整且无冲突的占比"
                icon="shield"
              />
            </div>

            <div className="grid-main">
              <Card
                title="新增趋势"
                subtitle={`口径：${overview.definitions.trend?.definition ?? ''} · 统计范围 ${overview.definitions.trend?.scope ?? ''}`}
                actions={
                  <div className="segmented">
                    {([
                      ['discovered', '首次发现'],
                      ['ingested', '入库'],
                      ['published', '发布'],
                    ] as Array<[Basis, string]>).map(([key, label]) => (
                      <button key={key} className={basis === key ? 'active' : ''} onClick={() => setBasis(key)}>
                        {label}
                      </button>
                    ))}
                  </div>
                }
              >
                <Chart option={trendOption} />
              </Card>

              <Card title="学科分布" subtitle="已发布竞赛按学科分类计数">
                {overview.distributions.category.length > 0 ? (
                  <Chart option={categoryOption} height={250} />
                ) : (
                  <AsyncState status="empty" message="暂无已发布竞赛的学科数据" />
                )}
              </Card>
            </div>

            <div className="grid-main">
              <Card
                title="临近截止"
                subtitle="未来 7 天内仍未截止的报名阶段，按截止时间升序"
                actions={
                  <Link to="/library" className="btn ghost sm">
                    查看全部 <Icon name="arrow" size={13} />
                  </Link>
                }
              >
                {deadlines.length === 0 ? (
                  <AsyncState status="empty" message="未来 7 天没有临近截止的竞赛" />
                ) : (
                  <div className="list">
                    {deadlines.map((item) => (
                      <div key={item.competitionId} className="list-row">
                        <div className="stretch">
                          <Link to={`/competitions/${item.competitionId}`} className="list-title">
                            {item.name}
                          </Link>
                          <div className="comp-meta">
                            <RegistrationBadge value={item.registrationStatus} />
                            <SiteBadge value={item.siteStatus} />
                            {item.missingFields.map((field) => (
                              <span key={field} className="muted">
                                · {field}缺失
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="deadline-pill">
                          {formatDate(item.deadline.at)}
                          <small>{timeLeft(item.remainingDays)}</small>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card title="质量概览" subtitle="口径与公式见质量报告">
                <div className="list">
                  <div className="list-row">
                    <span className="stretch muted">高可信占比</span>
                    <span className="mono">{overview.quality.credibilityHighRate}%</span>
                  </div>
                  <div className="list-row">
                    <span className="stretch muted">报名入口可访问率</span>
                    <span className="mono">{overview.quality.siteAvailabilityRate}%</span>
                  </div>
                  <div className="list-row">
                    <span className="stretch muted">待审核最久等待</span>
                    <span className="mono">{overview.quality.pendingReviewOldestHours} h</span>
                  </div>
                  <div className="list-row">
                    <span className="stretch muted">草稿数量</span>
                    <span className="mono">{overview.totals.draft}</span>
                  </div>
                </div>
                <div className="banner info" style={{ marginTop: 12 }}>
                  <Icon name="spark" size={15} />
                  <div>
                    <Badge tone="info">口径</Badge>{' '}
                    {overview.definitions.completenessRate?.definition}（{overview.definitions.completenessRate?.scope}）
                  </div>
                </div>
              </Card>
            </div>

            <div style={{ marginTop: 14 }} className="muted mono">
              数据时间 {new Date(overview.asOf).toLocaleString('zh-CN')}
            </div>
          </>
        )}
      </AsyncState>
    </>
  );
}
