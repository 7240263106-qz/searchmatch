import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { DocumentModelConfiguration, DocumentRunsView } from '@competition/contracts';
import { AsyncState, Badge, Button, Card, Icon, PageHeader, ParseBadge } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, sizeText } from '../lib/format';

const STAGES: Record<string, string> = { queued: '等待处理', fetch: '读取原件', text: '提取文字', extract: '分析竞赛字段', validate: '保存结果', done: '识别完成', failed: '处理失败' };
const SOURCE = { llm: '模型辅助提取', rule: '规则提取', fallback: '文本直读与规则提取' };
const REASONS: Record<string, string> = { configuration_incomplete: '模型配置不完整', no_text: '没有可读取的文字，需要先进行 OCR',
  timeout: '模型请求超时', network_error: '无法连接模型服务', http_401: 'API Key 未获授权', http_402: '模型服务返回余额或付费限制',
  http_403: '模型服务拒绝访问', http_429: '模型服务限流或配额不足', invalid_json: '模型未返回有效 JSON', empty_response: '模型返回内容为空' };

function duration(value: number | null | undefined): string {
  return value == null ? '未记录' : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} 秒`;
}

function Configuration({ value }: { value: DocumentModelConfiguration }): JSX.Element {
  return <>
    <dl className="run-facts">
      <div><dt>模型开关</dt><dd>{value.enabled ? '已启用' : '未启用'}</dd></div>
      <div><dt>服务地址</dt><dd>{value.baseUrl || '未配置'}</dd></div>
      <div><dt>文档使用模型</dt><dd>{value.model || '未配置'}{value.model && <small>{value.modelSource === 'default' ? '沿用默认模型' : '使用文档专用模型'}</small>}</dd></div>
      <div><dt>API Key</dt><dd>{value.credentialReady ? '已配置且可读取' : '未配置或无法读取'}</dd></div>
      <div><dt>请求超时</dt><dd>{duration(value.timeoutMs)}</dd></div>
      <div><dt>单次正文上限</dt><dd>{value.textLimit.toLocaleString()} 字符</dd></div>
      <div><dt>配置版本</dt><dd>v{value.configVersion}</dd></div>
    </dl>
    {value.missing.length > 0 ? <div className="banner warning">缺少：{value.missing.join('、')}。<Link to="/settings">前往模型设置</Link></div>
      : <p className="run-note">配置项齐全。是否成功调用模型，以各次运行记录为准。</p>}
  </>;
}

export default function DocumentRunsPage(): JSX.Element {
  const { documentId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<DocumentRunsView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const load = useCallback(async () => {
    const sequence = ++request.current;
    try {
      const next = await api.get<DocumentRunsView>(`/documents/${documentId}/runs`);
      if (sequence !== request.current) return;
      setData(next); setError('');
    } catch (reason) { if (sequence === request.current) setError((reason as Error).message); }
  }, [documentId]);
  useEffect(() => { setData(null); setError(''); void load(); return () => { request.current += 1; }; }, [load]);
  const active = data?.runs.some(run => ['queued', 'processing'].includes(run.status)) ?? false;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), 1800);
    return () => window.clearInterval(timer);
  }, [active, load]);
  const selected = data?.runs.find(run => run.id === params.get('runId')) ?? data?.runs[0];
  const modelTrace = selected?.trace?.extraction;
  const logs = selected?.trace?.logs ?? [];
  const catalog = selected?.result?.catalog;
  const recognize = async () => {
    setBusy(true); setError('');
    try {
      const result = await api.post<{ taskId: string }>(`/documents/${documentId}/parse`, { trigger: 'reparse' });
      setParams({ runId: result.taskId }); await load();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="document-runs">
    <PageHeader title="文档运行详情" description={data?.document.fileName ?? '查看识别进度、模型调用和历史运行日志。'} actions={
      <><Link className="btn sm" to="/collection">返回文档列表</Link><Button size="sm" onClick={() => void load()}><Icon name="refresh" />刷新</Button></>
    } />
    {error && <p className="document-error" role="alert">{error}</p>}
    <AsyncState status={data ? 'ready' : error ? 'error' : 'loading'} message={error} onRetry={() => void load()}>
      {data && <>
        <Card title="当前运行情况" actions={<Button size="sm" variant="primary" disabled={busy || active || data.document.deletionPending} onClick={() => void recognize()}>
          {busy ? '正在提交…' : active ? '识别进行中' : '重新识别'}</Button>}>
          <div className="run-current">
            {data.runs[0] ? <><ParseBadge value={data.runs[0].status} /><strong>{STAGES[data.runs[0].stage ?? 'queued'] ?? data.runs[0].stage}</strong></> : <span>尚无识别任务</span>}
            <span>{data.document.detectedType.toUpperCase()} · {sizeText(data.document.size)}</span>
            {active && <span role="status">每 1.8 秒自动更新</span>}
          </div>
          {active && <progress className="run-progress" max={100} value={data.runs[0]?.progress ?? 0} aria-label="当前识别进度" />}
          {data.document.deletionPending && <p className="document-error">文档删除未完成，请返回列表重试删除。</p>}
          <p className="run-note">{data.workflow}</p>
        </Card>
        <details className="run-configuration" open={data.currentConfiguration.missing.length > 0}>
          <summary>当前模型配置 <span>{data.currentConfiguration.missing.length ? '存在缺项' : '配置齐全'} · 点击查看</span></summary>
          <Configuration value={data.currentConfiguration} />
        </details>
        <div className="run-layout">
          <section className="run-history" aria-labelledby="run-history-title">
            <h2 id="run-history-title">识别历史</h2><p className="run-note">最近 100 次，每次识别分别保存。</p>
            {data.runs.length === 0 ? <p>点击「重新识别」开始第一次运行。</p> : <ol>
              {data.runs.map(run => <li key={run.id}><button className="run-history-item" aria-current={selected?.id === run.id ? 'true' : undefined}
                onClick={() => setParams({ runId: run.id })}>
                <strong>{run.result ? `结果 v${run.result.versionNo}` : STAGES[run.stage ?? 'queued'] ?? run.status} {run.result?.adopted && <span>当前采用</span>}</strong>
                <span>{formatDateTime(run.createdAt)}</span><span><ParseBadge value={run.status} /> {duration(run.durationMs)}</span>
                <small>{run.result ? SOURCE[run.result.source] : run.trace?.logs.some(log => log.code === 'model.started') ? '模型分析已开始' : '等待结果'}</small>
              </button></li>)}
            </ol>}
          </section>
          <div className="run-detail">
            {selected && <>
              <Card title="本次识别" subtitle={selected.id}>
                <dl className="run-facts">
                  <div><dt>状态</dt><dd><ParseBadge value={selected.status} /></dd></div>
                  <div><dt>提取方式</dt><dd>{selected.result ? SOURCE[selected.result.source] : '尚无结果'}</dd></div>
                  <div><dt>开始时间</dt><dd>{formatDateTime(selected.startedAt)}</dd></div>
                  <div><dt>结束时间</dt><dd>{formatDateTime(selected.finishedAt)}</dd></div>
                  <div><dt>总耗时</dt><dd>{duration(selected.durationMs)}</dd></div>
                  <div><dt>触发方式</dt><dd>{selected.trace ? selected.trace.trigger === 'auto' ? '上传后自动识别' : '用户发起识别' : '旧任务未记录'}</dd></div>
                  {catalog ? <><div><dt>目录竞赛</dt><dd>{catalog.count} / {catalog.detectedRows} 项</dd></div>
                    <div><dt>学校认定等级</dt><dd>{Object.entries(catalog.gradeCounts).map(([grade, count]) => `${grade} ${count} 项`).join(' · ')}</dd></div></>
                    : selected.result && <div><dt>有值字段</dt><dd>{selected.result.filledFields} / {selected.result.fieldCount}</dd></div>}
                  {selected.trace?.parser && <><div><dt>读取文字</dt><dd>{selected.trace.parser.characters.toLocaleString()} 字符 · {duration(selected.trace.parser.durationMs)}</dd></div>
                    <div><dt>解析方式</dt><dd>{selected.trace.parser.source === 'python' ? '文档解析服务' : '文本直读回退'}</dd></div></>}
                </dl>
                {selected.errorMessage && <p className="document-error">{selected.errorCode} · {selected.errorMessage}</p>}
                {modelTrace && <div className={`banner ${modelTrace.status === 'used' ? 'info' : 'warning'}`}>
                  {modelTrace.status === 'used' ? `模型已参与：${modelTrace.configuration.model}` : `模型${modelTrace.status === 'failed' ? '调用失败，已回退规则' : '未调用'}`}。
                  {modelTrace.reason && ` ${REASONS[modelTrace.reason] ?? modelTrace.reason}。`}
                  <span>{modelTrace.catalog ? `分 ${modelTrace.catalog.batches} 批，模型返回 ${modelTrace.catalog.returnedRows} 项，逐项核验通过 ${modelTrace.catalog.validatedRows} / ${modelTrace.catalog.expectedRows} 项；` : `发送 ${modelTrace.sentCharacters.toLocaleString()} / ${modelTrace.inputCharacters.toLocaleString()} 字符；`}分析耗时 {duration(modelTrace.durationMs)}。</span>
                  {modelTrace.promptTokens !== undefined && <span>输入 Token {modelTrace.promptTokens}；输出 Token {modelTrace.completionTokens ?? '未返回'}。</span>}
                </div>}
                {catalog && <><p className="run-note">已逐项保留名称、原文序号与学校 A/B/C 认定等级。请核对后批量保存。</p>
                  {catalog.warnings.map(warning => <p key={warning} className="banner warning">{warning}</p>)}
                  {selected.result?.adopted && <Link className="btn primary" to={`/collection?taskId=${selected.id}`}>核对 {catalog.count} 项竞赛</Link>}</>}
                {!selected.trace && <p className="banner warning">这是增加日志功能前的任务。提取方式来自已保存的结果版本；当时的模型名、Token、请求错误和阶段日志未保存，无法补回。</p>}
                {selected.trace && <details><summary>本次运行使用的模型配置</summary><Configuration value={modelTrace?.configuration ?? selected.trace.configuration} /></details>}
              </Card>
              <Card title="阶段日志" subtitle="记录处理步骤和调用结果，不保存 API Key、文档正文或模型内部推理。">
                {logs.length ? <ol className="run-logs">{logs.map((log, index) => <li key={index} className={`run-log-${log.level}`}>
                  <time dateTime={log.at}>{new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
                  <div><strong>{STAGES[log.stage] ?? log.stage}</strong><p>{log.message}</p><small>{log.code}</small></div>
                </li>)}</ol> : <p className="run-note">该任务没有保存阶段日志。创建于 {formatDateTime(selected.createdAt)}，{selected.finishedAt ? `结束于 ${formatDateTime(selected.finishedAt)}。` : '尚未结束。'}</p>}
              </Card>
            </>}
          </div>
        </div>
      </>}
    </AsyncState>
  </div>;
}
