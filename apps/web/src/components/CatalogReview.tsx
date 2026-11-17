import { useEffect, useRef, useState } from 'react';
import type { CatalogConfirmInput, ParsePreview, SchoolRecognitionLevel } from '@competition/contracts';
import { ApiError } from '../lib/api';
import { Badge, Button, Card } from './ui';

interface Props {
  preview: ParsePreview;
  onBack: () => void;
  onDownload: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onConfirm: (items: CatalogConfirmInput['items']) => Promise<void>;
}

export default function CatalogReview({ preview, onBack, onDownload, onRefresh, onConfirm }: Props): JSX.Element {
  const catalog = preview.catalog!;
  const heading = useRef<HTMLHeadingElement>(null);
  const [rows, setRows] = useState(() => catalog.competitions.map(row => ({ ...row, selected: true })));
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const selected = rows.filter(row => row.selected);
  useEffect(() => { heading.current?.focus(); }, []);
  const save = async () => {
    if (busy || stale) return;
    if (!selected.length || selected.some(row => !row.name.trim() || !row.schoolRecognitionLevel)) {
      setError('请选择竞赛，并补齐名称和 A/B/C 认定等级。'); return;
    }
    setBusy(true); setError('');
    try { await onConfirm(selected.map(row => ({ sequence: row.sequence, name: row.name.trim(), schoolRecognitionLevel: row.schoolRecognitionLevel! }))); }
    catch (reason) { setError((reason as Error).message); setStale(reason instanceof ApiError && reason.code === 'STATE_TRANSITION_INVALID'); }
    finally { setBusy(false); }
  };
  return <Card className="catalog-review">
    <div className="document-section-head">
      <div><h2 ref={heading} tabIndex={-1}>核对竞赛目录 · {rows.length} 项</h2><p>{preview.documentName}</p></div>
      <div className="toolbar"><Badge tone="info">{preview.source === 'llm' ? '模型逐项核验通过' : '原文逐行提取'}</Badge>
        <Button size="sm" disabled={downloading} onClick={async () => { setDownloading(true); try { await onDownload(); } catch (reason) { setError((reason as Error).message); } finally { setDownloading(false); } }}>下载原文</Button></div>
    </div>
    <p className="document-help">认定范围：{catalog.recognitionScope}。A/B/C 为该校目录中的认定等级；组合赛事按原序号保留。原文未载明的主办方、报名时间及网址保持为空。</p>
    {catalog.warnings.map(warning => <p key={warning} className="banner warning">{warning}</p>)}
    <div className="catalog-selection"><label><input type="checkbox" checked={selected.length === rows.length}
      disabled={busy} onChange={event => setRows(current => current.map(row => ({ ...row, selected: event.target.checked })))} /> 全选</label>
      <span role="status">已选 {selected.length} / {rows.length} 项</span>
      <span>{['A类', 'B类', 'C类'].map(grade => `${grade} ${rows.filter(row => row.schoolRecognitionLevel === grade).length} 项`).join(' · ')}</span>
      <Button size="sm" variant="primary" disabled={busy || stale || !selected.length} onClick={() => void save()}>{busy ? '正在保存…' : `保存所选 ${selected.length} 项到竞赛库`}</Button></div>
    <div className="catalog-table-wrap"><table className="catalog-table">
      <thead><tr><th>选择</th><th>序号</th><th>竞赛名称</th><th>学校认定等级</th><th>原文依据</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={row.sequence}>
        <td><input type="checkbox" aria-label={`选择第 ${row.sequence} 项`} checked={row.selected} disabled={busy}
          onChange={event => setRows(current => current.map((item, i) => i === index ? { ...item, selected: event.target.checked } : item))} /></td>
        <td>{row.sequence}</td>
        <td><textarea className="input" rows={2} aria-label={`第 ${row.sequence} 项竞赛名称`} value={row.name} disabled={busy}
          onChange={event => setRows(current => current.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} /></td>
        <td><select className="input" aria-label={`第 ${row.sequence} 项学校认定等级`} value={row.schoolRecognitionLevel ?? ''} disabled={busy}
          onChange={event => setRows(current => current.map((item, i) => i === index ? { ...item, schoolRecognitionLevel: (event.target.value || null) as SchoolRecognitionLevel | null } : item))}>
          <option value="">待核对</option>{['A类', 'B类', 'C类'].map(grade => <option key={grade}>{grade}</option>)}</select></td>
        <td><details><summary>{row.evidence.location?.page ? `第 ${row.evidence.location.page} 页` : '查看依据'}</summary><p>{row.evidence.snippet}</p></details></td>
      </tr>)}</tbody>
    </table></div>
    <div className="document-review-foot">
      {error && <p className="document-error" role="alert">{error}</p>}
      <p className="document-help">确认后将所选竞赛发布到竞赛库。暂不发布的项目可以取消勾选。</p>
      <div className="toolbar"><Button disabled={busy} onClick={onBack}>返回文档列表</Button>
        {stale ? <Button disabled={busy} onClick={async () => { setBusy(true); try { await onRefresh(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } }}>查看最新解析结果</Button>
          : <Button variant="primary" disabled={busy || !selected.length} onClick={() => void save()}>{busy ? '正在发布…' : `确认并发布 ${selected.length} 项`}</Button>}</div>
    </div>
  </Card>;
}
