import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  CompetitionDetail,
  DocumentIntakeRow,
  ParsePreview,
  UploadBatchResult,
  CatalogConfirmInput,
  CatalogConfirmResult,
} from '@competition/contracts';
import DocumentReview from '../components/DocumentReview';
import CatalogReview from '../components/CatalogReview';
import { AsyncState, Badge, Button, Card, Icon, PageHeader, PublishBadge } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, sizeText } from '../lib/format';

const STEPS = [
  ['上传文档', '选择竞赛通知或报名材料'],
  ['自动解析', '在文档列表查看进度'],
  ['核对发布', '检查字段并发布到竞赛库'],
];

const STAGE_LABEL: Record<string, string> = {
  fetch: '正在读取文件',
  text: '正在读取正文',
  extract: '正在提取竞赛字段',
  validate: '正在整理解析结果',
};

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_BATCH_BYTES = 50 * 1024 * 1024;

function isRunning(row: DocumentIntakeRow): boolean {
  const status = row.latestTask?.status;
  return status === 'queued' || status === 'processing';
}

export default function DocumentsPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const requestedTask = params.get('taskId');
  const [documents, setDocuments] = useState<DocumentIntakeRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [deleteMessage, setDeleteMessage] = useState('');
  const [uploadResults, setUploadResults] = useState<UploadBatchResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [preview, setPreview] = useState<ParsePreview | null>(null);
  const [saved, setSaved] = useState<Pick<CompetitionDetail, 'id' | 'name' | 'publishStatus'> | null>(null);
  const [savedCatalog, setSavedCatalog] = useState<{ count: number; documentId: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const uploadActive = useRef(false);
  const loadRequest = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const request = ++loadRequest.current;
    try {
      const rows = await api.get<DocumentIntakeRow[]>('/documents');
      if (request !== loadRequest.current) return;
      setDocuments(rows);
      setStatus('ready');
      setLoadError('');
    } catch (reason) {
      if (request !== loadRequest.current) return;
      setLoadError((reason as Error).message);
      setStatus((current) => current === 'ready' ? current : 'error');
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { loadRequest.current += 1; };
  }, [load]);

  const runningCount = documents.filter(isRunning).length;
  const reviewCount = documents.filter((row) => !row.deletionPending && !isRunning(row) && row.reviewTaskId && !row.linkedCompetition).length;
  const currentStep = preview || saved ? 3 : uploading || runningCount > 0 ? 2 : reviewCount > 0 ? 3 : 1;

  useEffect(() => {
    if (runningCount === 0) return;
    let stopped = false;
    let timer = window.setTimeout(() => void poll(), 1800);
    async function poll(): Promise<void> {
      await load();
      if (!stopped) timer = window.setTimeout(() => void poll(), 1800);
    }
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [load, runningCount]);

  const upload = async (files: FileList | File[]): Promise<void> => {
    const list = Array.from(files);
    if (list.length === 0 || uploadActive.current) return;
    setActionError('');
    setDeleteMessage('');
    setUploadResults(null);
    if (list.length > 10 || list.reduce((total, file) => total + file.size, 0) > MAX_BATCH_BYTES) {
      setActionError('一次最多上传 10 份文件，总大小最多 50 MB。请分批上传。');
      return;
    }
    const oversized = list.find((file) => file.size > MAX_FILE_BYTES);
    if (oversized) {
      setActionError(`「${oversized.name}」超过 20 MB，请压缩或拆分后上传。`);
      return;
    }

    uploadActive.current = true;
    setUploading(true);
    setSaved(null);
    const form = new FormData();
    for (const file of list) form.append('files', file);
    try {
      setUploadResults(await api.upload<UploadBatchResult>('/documents', form));
      await load();
    } catch (reason) {
      setActionError(`上传失败。 ${(reason as Error).message}`);
    } finally {
      setUploading(false);
      uploadActive.current = false;
    }
  };

  const openPreview = async (taskId: string): Promise<void> => {
    setActionError('');
    setOpening(taskId);
    try {
      setPreview(await api.get<ParsePreview>(`/parse-tasks/${taskId}/preview`));
      setSaved(null);
      setSavedCatalog(null);
    } catch (reason) {
      setActionError(`无法打开核对页。 ${(reason as Error).message}`);
    } finally {
      setOpening(null);
    }
  };

  useEffect(() => { if (requestedTask) void openPreview(requestedTask); }, [requestedTask]);

  const retry = async (row: DocumentIntakeRow): Promise<void> => {
    setActionError('');
    setDeleteMessage('');
    setRetrying(row.id);
    try {
      await api.post(`/documents/${row.id}/parse`, { trigger: 'reparse' });
      await load();
    } catch (reason) {
      setActionError(`无法重新识别「${row.fileName}」。 ${(reason as Error).message}`);
    } finally {
      setRetrying(null);
    }
  };

  const removeDocument = async (row: DocumentIntakeRow): Promise<void> => {
    const message = `删除「${row.fileName}」？原件和解析记录将永久删除。已录入的竞赛及字段依据会保留。`;
    if (!window.confirm(message)) return;

    setActionError('');
    setDeleteMessage('');
    setDeleting(row.id);
    try {
      await api.delete(`/documents/${row.id}`);
      setDocuments((current) => current.filter(({ id }) => id !== row.id));
      setUploadResults((current) => {
        if (!current) return null;
        const results = current.results.filter(({ documentId }) => documentId !== row.id);
        return results.length ? { ...current, results, accepted: results.length - current.rejected } : null;
      });
      setDeleteMessage(`已删除「${row.fileName}」。`);
      listHeading.current?.focus();
    } catch (reason) {
      setActionError(`无法删除「${row.fileName}」。 ${(reason as Error).message}`);
    } finally {
      await load();
      setDeleting(null);
    }
  };

  const download = async (documentId: string): Promise<void> => {
    const rows = await api.get<DocumentIntakeRow[]>('/documents');
    const row = rows.find(({ id }) => id === documentId);
    if (!row) throw new Error('找不到原文文件。');
    const blob = await api.download(row.fileUrl.replace(/^\/api\/v1(?=\/)/, ''));
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = row.fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const back = (): void => {
    setPreview(null);
    setParams({});
    window.requestAnimationFrame(() => listHeading.current?.focus());
  };

  const confirm = async (fields: Record<string, string | null>): Promise<void> => {
    if (!preview) return;
    const competition = await api.post<CompetitionDetail>(`/parse-tasks/${preview.taskId}/confirm`, {
      fields,
      resultVersionId: preview.resultVersionId,
      publish: true,
    });
    setSaved(competition);
    back();
    void load();
  };

  const confirmCatalog = async (items: CatalogConfirmInput['items']): Promise<void> => {
    if (!preview) return;
    const result = await api.post<CatalogConfirmResult>(`/parse-tasks/${preview.taskId}/catalog/confirm`, {
      resultVersionId: preview.resultVersionId, items, publish: true,
    });
    setSavedCatalog({ count: result.count, documentId: preview.documentId });
    back();
    void load();
  };

  const recent = new Map(uploadResults?.results.filter((item) => item.accepted).map((item) => [item.documentId, item]));
  const rows = [...documents].sort((left, right) => Number(recent.has(right.id)) - Number(recent.has(left.id)));
  const rejected = uploadResults?.results.filter((item) => !item.accepted) ?? [];

  return (
    <div className="document-intake">
      <PageHeader title="文档录入" description="从竞赛通知中提取报名信息，核对确认后发布到竞赛库。" />

      <ol className="document-steps" aria-label="文档录入步骤">
        {STEPS.map(([label, description], index) => (
          <li key={label} aria-current={currentStep === index + 1 ? 'step' : undefined}>
            <span className="document-step-number" aria-hidden="true">{index + 1}</span>
            <span><strong>{label}</strong><small>{description}</small></span>
          </li>
        ))}
      </ol>

      {preview?.catalog ? (
        <CatalogReview key={preview.resultVersionId} preview={preview} onBack={back} onConfirm={confirmCatalog}
          onDownload={() => download(preview.documentId)} onRefresh={async () => setPreview(await api.get<ParsePreview>(`/parse-tasks/${preview.taskId}/preview`))} />
      ) : preview ? (
        <DocumentReview key={preview.resultVersionId} preview={preview} onBack={back}
          onConfirm={confirm} onDownload={() => download(preview.documentId)}
          onRefresh={async () => setPreview(await api.get<ParsePreview>(`/parse-tasks/${preview.taskId}/preview`))} />
      ) : (
        <>
          {savedCatalog && (
            <div className="banner info" role="status">
              <span className="stretch">已发布 {savedCatalog.count} 项竞赛。</span>
              <Link className="btn sm" to={`/library?documentId=${encodeURIComponent(savedCatalog.documentId)}`}>查看已发布竞赛</Link>
            </div>
          )}
          {saved && (
            <div className="banner document-saved" role="status">
              <Icon name="check" size={18} />
              <div className="stretch">
                <strong>已发布「{saved.name}」</strong> <PublishBadge value={saved.publishStatus} />
              </div>
              <Link className="btn sm" to={`/competitions/${saved.id}`}>查看竞赛详情</Link>
            </div>
          )}
          <Card className="document-upload-card">
            <div className={`upload-zone document-upload${dragging ? ' dragging' : ''}`}
              onDragOver={(event) => { event.preventDefault(); if (!uploading) setDragging(true); }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                void upload(event.dataTransfer.files);
              }}>
              <span className="upload-icon"><Icon name="upload" size={20} /></span>
              <div className="stretch">
                <h2>上传竞赛通知</h2>
                <p>支持 PDF、DOCX、XLSX、CSV 和文本。每份最多 20 MB，一次最多 10 份。</p>
                <p>可直接拖入文件并使用规则提取。PDF 请选有可复制文字的版本。</p>
              </div>
              <Button variant="primary" disabled={uploading} onClick={() => fileInput.current?.click()}>
                {uploading ? '正在上传…' : '选择文件'}
              </Button>
              <input ref={fileInput} type="file" multiple hidden accept=".pdf,.docx,.xlsx,.csv,.txt,.md"
                onChange={(event) => {
                  if (event.target.files) void upload(event.target.files);
                  event.target.value = '';
                }} />
            </div>
            <p className="document-alternative">只有赛事名称？ <Link to="/collection/web">前往联网采集</Link></p>
          </Card>
        </>
      )}

      {!preview && (
        <Card className="document-queue">
          <div className="document-section-head">
            <div>
              <h2 ref={listHeading} tabIndex={-1}>我的文档</h2>
              <p role="status">
                {runningCount > 0 || reviewCount > 0
                  ? [runningCount > 0 ? `${runningCount} 份解析中` : '', reviewCount > 0 ? `${reviewCount} 份待核对` : ''].filter(Boolean).join(' · ')
                  : '上传的文件和下一步操作会显示在这里。'}
              </p>
            </div>
            <Button size="sm" onClick={() => void load()}><Icon name="refresh" size={14} /> 刷新列表</Button>
          </div>

          {actionError && <p className="document-error" role="alert">{actionError}</p>}
          {deleteMessage && <div className="banner info" role="status">{deleteMessage}</div>}
          {status === 'ready' && loadError && (
            <p className="document-error" role="status">未能更新进度。{loadError} 可点击「刷新列表」重试。</p>
          )}
          {uploadResults && (
            <div className={`banner ${rejected.length ? 'warning' : 'info'}`} role="status">
              <Icon name={rejected.length ? 'alert' : 'check'} size={16} />
              <div>
                {uploadResults.accepted > 0 && <strong>{uploadResults.accepted} 份文件已接收。 </strong>}
                {rejected.length > 0 ? (
                  <>
                    <strong>{rejected.length} 份未能上传</strong>
                    <ul className="document-rejections">{rejected.map((item, index) => (
                      <li key={`${item.fileName}-${index}`}>{item.fileName} · {item.reason ?? '请检查文件后重试'}</li>
                    ))}</ul>
                  </>
                ) : '请在下方查看进度和下一步操作。'}
              </div>
            </div>
          )}

          <AsyncState status={status} message={loadError} onRetry={() => void load()}>
            {rows.length === 0 ? (
              <p className="document-empty">选择一份竞赛通知开始录入。系统会自动解析文件，并在这里提供核对入口。</p>
            ) : (
              <ul className="document-rows">
                {rows.map((row) => {
                  const task = row.latestTask;
                  const running = isRunning(row);
                  const failure = ['failed', 'canceled'].includes(task?.status ?? row.parseStatus);
                  const resultId = row.reviewTaskId;
                  const linked = row.linkedCompetition;
                  const canRetry = !row.deletionPending && !running;
                  const statusBadge = row.deletionPending ? <Badge tone="danger">删除未完成</Badge>
                    : running ? <Badge tone="info">解析中</Badge>
                    : failure ? <Badge tone="danger">解析未完成</Badge>
                      : linked ? <Badge tone="success">已录入</Badge>
                        : resultId ? <Badge tone="accent">待核对</Badge> : <Badge>待解析</Badge>;
                  return (
                    <li key={row.id} className="document-row">
                      <span className="document-row-icon"><Icon name="file" size={17} /></span>
                      <div className="document-row-info">
                        <strong><Link to={`/collection/documents/${row.id}/runs`}>{row.fileName}</Link></strong>
                        <p>{row.detectedType.toUpperCase()} · {sizeText(row.size)} · {formatDateTime(row.createdAt)}
                          {recent.get(row.id)?.deduplicated && ' · 已复用上传记录'}
                        </p>
                        {running && (
                          <div className="document-progress">
                            <progress value={task?.progress ?? 0} max={100} aria-label={`${row.fileName}的解析进度`} />
                            <span>{task?.status === 'queued' || !task ? '等待解析' : STAGE_LABEL[task.stage ?? ''] ?? '正在解析'}</span>
                          </div>
                        )}
                        {failure && <p className="document-row-error">{task?.errorMessage ?? '可以重新解析这份文件。'}</p>}
                        {row.deletionPending && <p className="document-row-error">请重试删除以完成清理。</p>}
                        {!running && linked && <p>{(row.linkedCompetitionCount ?? 0) > 1 ? `已关联 ${row.linkedCompetitionCount} 项竞赛` : `已关联「${linked.name}」`}</p>}
                      </div>
                      <div className="document-row-actions">
                        {statusBadge}
                        <Link className="btn sm" to={`/collection/documents/${row.id}/runs`}>运行详情</Link>
                        {canRetry && (
                          <Button size="sm" disabled={retrying !== null || deleting === row.id || (opening !== null && opening === resultId)}
                            onClick={() => void retry(row)}>
                            {retrying === row.id ? '正在提交…' : failure || resultId ? '重新识别' : '开始解析'}
                          </Button>
                        )}
                        {!row.deletionPending && !running && resultId && (
                          <Button size="sm" variant={linked || failure ? 'default' : 'primary'}
                            disabled={opening !== null || deleting === row.id || retrying === row.id} onClick={() => void openPreview(resultId)}>
                            {opening === resultId ? '正在加载…' : failure ? '查看上次结果' : linked ? '重新核对' : '核对并录入'}
                          </Button>
                        )}
                        {!running && linked && (row.linkedCompetitionCount ?? 0) > 1 && !row.deletionPending && (
                          <Link className="btn sm" to={linked.publishStatus === 'draft'
                            ? `/library/review?status=draft&documentId=${encodeURIComponent(row.id)}`
                            : `/library?documentId=${encodeURIComponent(row.id)}`}>
                            {linked.publishStatus === 'draft' ? '查看该文档的草稿' : '查看已发布竞赛'}
                          </Link>
                        )}
                        {!running && linked && <Link className="btn sm" to={`/competitions/${linked.id}`}>查看竞赛</Link>}
                        {!running && (
                          <Button size="sm" variant="ghost"
                            disabled={deleting !== null || retrying === row.id || (opening !== null && opening === resultId)}
                            onClick={() => void removeDocument(row)}>
                            {deleting === row.id ? '正在删除…' : row.deletionPending ? '重试删除' : '删除'}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </AsyncState>
        </Card>
      )}
    </div>
  );
}
