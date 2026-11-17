import { useEffect, useRef, useState } from 'react';
import type { DiscoveryLog, DiscoveryRun } from '@competition/contracts';
import { Badge } from './ui';

const STAGE_LABEL: Record<DiscoveryLog['stage'], string> = {
  task: '任务', search: '搜索', matching: '筛选', page: '网页', attachment: 'PDF', extract: '提取',
};

const REASON_LABEL: Record<string, string> = {
  attachment_text_missing: 'PDF 无可提取文本，可能是扫描件',
  parser_unavailable: '文档解析服务不可用',
  javascript_required: '网页内容需要 JavaScript',
  browser_unavailable: '未能启动 Chrome、Edge 或 Chromium',
  browser_busy: '无头浏览器繁忙',
  browser_offsite: '浏览器页面已离开当前站点',
  notice_feed_invalid: '通知栏目的公开数据格式有变化',
  pagination_offsite: '下一页跳转到了其他网站',
  robots_disallowed: '站点规则禁止访问该路径',
  robots_denied: '站点拒绝自动访问',
  robots_unknown: '无法读取站点的自动访问规则',
  no_page_identity: '页面未找到与赛事匹配的证据',
  campus_notice: '校赛、校内选拔或高校组织参赛通知',
  year_mismatch: '资料属于其他年份',
  year_unconfirmed: '无法确认资料属于本年度',
  http_404: '页面不存在（HTTP 404）',
  http_410: '页面已移除（HTTP 410）',
  http_412: '站点未接受本次请求（HTTP 412）',
  http_429: '请求被限流（HTTP 429）',
  empty_or_challenge: '未返回可读取的搜索结果',
  non_html: '响应不是 HTML 网页',
  network_error: '网络请求失败',
  too_many_redirects: '跳转次数过多',
  attachment_not_pdf: '附件不是 PDF',
  attachment_identity_unconfirmed: 'PDF 中未确认赛事名称',
  unknown_error: '未取得详细错误信息',
};

function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? (/^http_\d{3}$/.test(reason) ? `HTTP ${reason.slice(5)}` : reason);
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

function formatTime(at: string): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
}

interface Operation {
  id: string;
  first: DiscoveryLog;
  latest: DiscoveryLog;
  end?: DiscoveryLog;
  logs: DiscoveryLog[];
}

function groupOperations(logs: DiscoveryLog[]): Operation[] {
  const operations = new Map<string, Operation>();
  logs.forEach((log, index) => {
    const id = log.operation?.id ?? `event-${index}`;
    const operation = operations.get(id) ?? { id, first: log, latest: log, logs: [] };
    operation.latest = log;
    operation.logs.push(log);
    if (!log.operation || log.operation.phase === 'end') operation.end = log;
    operations.set(id, operation);
  });
  return [...operations.values()];
}

function OperationRow({ operation, stopped, onInspect }: {
  operation: Operation;
  stopped: boolean;
  onInspect: () => void;
}): JSX.Element {
  const { first, latest, end, logs } = operation;
  const tone = end?.level === 'error' ? 'danger' : end?.level === 'warning' || (!end && stopped)
    ? 'warning' : end ? 'success' : 'info';
  const status = end?.level === 'error' ? '失败' : end?.level === 'warning'
    ? end.stage === 'page' && end.reason === 'javascript_required' ? '需关注' : '跳过'
    : end ? '完成' : stopped ? '中断' : '进行中';
  const urls = [...new Set(logs.flatMap(log => log.url ? [log.url] : []))];
  const address = urls.at(-1);
  const title = first.operation?.label ?? STAGE_LABEL[first.stage];
  const summary = end?.reason ? reasonLabel(end.reason) : latest.message;
  return (
    <li className="discovery-operation">
      <details>
        <summary onClick={onInspect}>
          <span className="discovery-operation-title">
            <strong>{title}</strong>
            <span className="muted">{STAGE_LABEL[first.stage]}{address ? ` · ${address.split('/')[2] ?? address}` : ''}</span>
          </span>
          <Badge tone={tone}>{status}</Badge>
          {end?.durationMs !== undefined && <span className="discovery-operation-duration muted">{formatDuration(end.durationMs)}</span>}
          <span className="discovery-operation-summary">{summary}</span>
        </summary>
        <div className="discovery-operation-details">
          {urls.map((url, index) => (
            <p key={url} className="muted">{urls.length > 1 ? (index === 0 ? '请求地址' : '实际地址') : '来源'} <code>{url}</code></p>
          ))}
          <ol>
            {logs.map((log, index) => (
              <li key={index}>
                <time className="mono muted" dateTime={log.at}>{formatTime(log.at)}</time>
                <span>{log.message}{log.reason ? ` ${reasonLabel(log.reason)}` : ''}</span>
              </li>
            ))}
          </ol>
        </div>
      </details>
    </li>
  );
}

export default function DiscoveryLogPanel({ id, mobileOpen, onToggleMobile, run, busy, error, logError }: {
  id: string;
  mobileOpen: boolean;
  onToggleMobile: () => void;
  run: DiscoveryRun | null;
  busy: boolean;
  error: string;
  logError: string;
}): JSX.Element {
  const list = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const logs = run?.logs ?? [];
  const operations = groupOperations(logs);
  const active = operations.filter(operation => !operation.end && operation.first.stage !== 'task');
  const settled = operations.filter(operation => operation.end && operation.first.stage !== 'task');
  const warnings = settled.filter(({ logs: entries }) => entries.some(log => log.level === 'warning' || log.level === 'error')).length;
  const status = busy ? '采集中' : run?.status === 'completed' ? '采集已完成'
    : error || logError || run?.status === 'failed' ? '采集未完成' : '待开始';
  const elapsed = run?.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;

  useEffect(() => {
    if (following && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [mobileOpen, following, logs.length]);

  return (
    <aside id={id} className="discovery-log-panel" data-mobile-open={mobileOpen} aria-labelledby={`${id}-title`}>
      <div className="discovery-log-header">
        <div className="stretch">
          <h3 id={`${id}-title`}>采集日志</h3>
          <p role="status">
            <Badge tone={busy ? 'info' : run?.status === 'completed' ? 'success' : error || logError ? 'warning' : 'neutral'}>{status}</Badge>
            {elapsed !== null && elapsed >= 0 && <span className="muted"> · 总耗时 {formatDuration(elapsed)}</span>}
          </p>
          {logError && <p className="muted">{logError}</p>}
        </div>
        <button type="button" className="btn sm ghost discovery-log-mobile" onClick={onToggleMobile}
          aria-controls={id} aria-expanded={mobileOpen}>收起</button>
      </div>
      {logs.length > 0 && (
        <div className="discovery-log-overview">
          <p>
            {busy && <span>进行中 {active.length} 项</span>}
            <span>已处理 {settled.length} 项</span>
            {warnings > 0 && <span>有提示 {warnings} 项</span>}
            {Boolean(run?.result || run?.livePages?.length) && <span>取得 {run?.result?.pages.length ?? run?.livePages?.length} 个相关页面</span>}
            {busy && !following && <button type="button" className="btn sm ghost"
              onClick={() => setFollowing(true)}>跟随最新日志</button>}
          </p>
          {busy && active.length > 0 && (
            <p className="discovery-log-current">
              <strong>正在处理</strong>
              {active.map(operation => operation.first.operation?.label ?? STAGE_LABEL[operation.first.stage]).join('、')}
            </p>
          )}
        </div>
      )}
      <div ref={list} className="discovery-log-scroll" tabIndex={logs.length ? 0 : undefined}
        role="region" aria-label="采集日志记录" onScroll={event => {
        const panel = event.currentTarget;
        if (panel.scrollHeight - panel.scrollTop - panel.clientHeight > 40) setFollowing(false);
      }}>
        {logs.length === 0 ? <p className="discovery-log-empty">{error || (busy ? '等待采集任务返回日志…' : '开始采集后，这里会显示搜索和网页访问进度。')}</p>
          : (
            <ol className="discovery-operations">
              {operations.map(operation => (
                <OperationRow key={operation.id} operation={operation} stopped={!busy} onInspect={() => setFollowing(false)} />
              ))}
            </ol>
          )}
      </div>
    </aside>
  );
}
