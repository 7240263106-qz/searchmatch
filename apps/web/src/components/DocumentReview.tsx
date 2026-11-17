import { useEffect, useRef, useState } from 'react';
import { SIGNUP_METHOD_META, type ParsePreview } from '@competition/contracts';
import { ApiError } from '../lib/api';
import { Badge, Button, Card, Icon } from './ui';

const FIELDS = [
  { key: 'name', label: '竞赛名称', required: true },
  { key: 'organizer', label: '主办机构' },
  { key: 'startAt', label: '报名开始时间', placeholder: '如 2026-11-20 09:00' },
  { key: 'nearestDeadline', label: '报名截止时间', placeholder: '如 2026-12-15 18:00' },
  { key: 'signupMethod', label: '报名方式' },
  { key: 'signupUrl', label: '报名链接', placeholder: 'https://…' },
  { key: 'eligibility', label: '参赛对象' },
  { key: 'category', label: '学科分类' },
  { key: 'level', label: '竞赛级别' },
];

const SOURCE_LABEL = { rule: '规则提取', llm: '模型辅助提取', fallback: '文本直读与规则提取' };

function initialValues(preview: ParsePreview): Record<string, string> {
  if (preview.hasText === false) return { signupMethod: 'to_be_announced' };
  return Object.fromEntries(preview.fields.map((field) => [
    field.key,
    field.value == null ? '' : field.time?.rawText ?? String(field.value),
  ]));
}

interface Props {
  preview: ParsePreview;
  onBack: () => void;
  onDownload: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onConfirm: (fields: Record<string, string | null>) => Promise<void>;
}

export default function DocumentReview({ preview, onBack, onDownload, onRefresh, onConfirm }: Props): JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);
  const [original] = useState(() => initialValues(preview));
  const [values, setValues] = useState(original);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const setField = (key: string, value: string): void => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const submit = async (): Promise<void> => {
    if (saving || stale) return;
    setError('');
    if (!values.name?.trim()) {
      setError('请填写竞赛名称。');
      return;
    }
    const overrides: Record<string, string | null> = {};
    for (const { key } of FIELDS) {
      const value = values[key]?.trim() ?? '';
      if (value !== (original[key]?.trim() ?? '')) overrides[key] = value || null;
    }
    setSaving(true);
    try {
      await onConfirm(overrides);
    } catch (reason) {
      setError((reason as Error).message);
      setStale(reason instanceof ApiError && reason.code === 'STATE_TRANSITION_INVALID');
    } finally {
      setSaving(false);
    }
  };

  const download = async (): Promise<void> => {
    setError('');
    setDownloading(true);
    try {
      await onDownload();
    } catch (reason) {
      setError(`原文下载失败。 ${(reason as Error).message}`);
    } finally {
      setDownloading(false);
    }
  };

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await onRefresh();
      setError('');
      setStale(false);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const otherFields = preview.hasText === false ? [] : preview.fields.filter(
    (field) => !FIELDS.some(({ key }) => key === field.key) && field.value != null && field.value !== '',
  );
  return (
    <Card className="document-review">
      <div className="document-section-head">
        <div>
          <h2 ref={heading} tabIndex={-1}>核对竞赛信息</h2>
          <p className="document-review-file"><Icon name="file" size={14} /> {preview.documentName}</p>
        </div>
        <div className="toolbar">
          {preview.hasText !== false && preview.source && <Badge tone="info">{SOURCE_LABEL[preview.source]}</Badge>}
          <Button size="sm" disabled={downloading} onClick={() => void download()}>
            {downloading ? '下载中…' : '下载原文'}
          </Button>
        </div>
      </div>

      {preview.hasText === false ? (
        <div className="banner warning" role="status">
          <Icon name="alert" size={16} />
          <span>文件中没有可读取的文字。你可以对照原文手工填写，也可以返回上传有文字层的版本。</span>
        </div>
      ) : (
        <p className="document-help">对照原文检查字段。竞赛名称必填，其余字段可稍后补充。报名时间按北京时间填写。</p>
      )}

      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <fieldset className="document-review-fields" disabled={saving}>
          {FIELDS.map((item) => {
            const field = preview.fields.find(({ key }) => key === item.key);
            const conflict = preview.conflicts.find(({ field: key }) => key === item.key);
            const value = values[item.key] ?? '';
            const snippet = preview.hasText === false ? null : field?.evidence?.snippet;
            const page = field?.evidence?.location?.page;
            const needsAttention = !value && (conflict || preview.missing.includes(field?.label ?? item.label));
            return (
              <div className="document-review-field" key={item.key}>
                <label className="field-label" htmlFor={`document-field-${item.key}`}>
                  {item.label}
                  {item.required && <span className="document-field-note">必填</span>}
                  {needsAttention && !item.required && <span className="document-field-note">待补充</span>}
                </label>
                {item.key === 'signupMethod' ? (
                  <select id={`document-field-${item.key}`} className="input" value={value || 'to_be_announced'}
                    onChange={(event) => setField(item.key, event.target.value)}>
                    {Object.entries(SIGNUP_METHOD_META).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
                  </select>
                ) : (
                  <input id={`document-field-${item.key}`} className="input" value={value}
                    type={item.key === 'signupUrl' ? 'url' : 'text'} required={item.required}
                    placeholder={item.placeholder} onChange={(event) => setField(item.key, event.target.value)} />
                )}
                {conflict && (
                  <div className="document-field-conflicts">
                    <p>原文有多个候选值，请核对后选择或手工修改。</p>
                    {conflict.options.map((option) => (
                      <Button key={option.rawText + option.value} size="sm" onClick={() => setField(item.key, option.rawText)}>
                        {option.rawText}
                      </Button>
                    ))}
                  </div>
                )}
                {snippet && (
                  <details className="document-field-evidence">
                    <summary>{typeof page === 'number' ? `查看原文依据 · 第 ${page} 页` : '查看原文依据'}</summary>
                    <p>{snippet}</p>
                  </details>
                )}
              </div>
            );
          })}
        </fieldset>
        {otherFields.length > 0 && (
          <details className="document-field-evidence document-review-more">
            <summary>查看其他提取结果</summary>
            <dl>{otherFields.map((field) => (
              <div key={field.key}><dt>{field.label}</dt><dd>{String(field.value)}</dd></div>
            ))}</dl>
          </details>
        )}
        <div className="document-review-foot">
          {error && <p className="document-error" role="alert">{error}</p>}
          <p className="document-help">确认后，竞赛及所核对的字段将发布到竞赛库。</p>
          <div className="toolbar">
            <Button onClick={onBack} disabled={saving}>返回文档列表</Button>
            {stale ? (
              <Button variant="primary" onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? '正在加载…' : '查看最新解析结果'}
              </Button>
            ) : (
              <Button type="submit" variant="primary" disabled={saving}>{saving ? '正在发布…' : '确认并发布'}</Button>
            )}
          </div>
        </div>
      </form>
    </Card>
  );
}
