import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { canSaveDiscoveryField, hasDiscoveryTrackDetails, type CompetitionDetail, type DiscoveryLink, type DiscoveryPage, type DiscoveryRun, type DiscoverySelection } from '@competition/contracts';
import { ApiError, api, getUser } from '../lib/api';
import { Badge, Button, Card, Icon } from './ui';
import DiscoveryLogPanel from './DiscoveryLogPanel';
import DiscoveryTracks from './DiscoveryTracks';

const SCOPE_LABEL = {
  general: '赛事公告',
  regional: '校内或赛区公告',
  track: '专题或赛道公告',
};
function SourceLink({ source }: { source: DiscoveryLink }): JSX.Element {
  return <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>;
}

function sourceType(page: DiscoveryPage): string {
  if (page.kind === 'attachment') return 'PDF 附件';
  if (page.kind === 'site') return '站点';
  if (page.kind === 'listing') return '目录';
  return page.scope ? SCOPE_LABEL[page.scope] : '赛事资料';
}

function sourceMetadata(page: DiscoveryPage): string {
  return [
    sourceType(page),
    page.kind === 'attachment' && page.scope && SCOPE_LABEL[page.scope],
    page.year && `${page.year} 年`,
    page.edition,
    page.url.split('/')[2],
  ].filter(Boolean).join(' · ');
}

function fieldValue(page: DiscoveryPage, key: string): string | undefined {
  return page.fields.find(field => field.key === key)?.value;
}

export default function AgentDiscovery({ competition, actionsDisabled = false, onSavingChange, onSave, onUnsavedTracksChange }: {
  competition?: { id: string; name: string };
  actionsDisabled?: boolean;
  onSavingChange?: (saving: boolean) => void;
  onSave?: (detail: CompetitionDetail) => void;
  onUnsavedTracksChange?: (unsaved: boolean) => void;
}): JSX.Element {
  const [name, setName] = useState(competition?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<DiscoveryRun | null>(null);
  const [mobileLogOpen, setMobileLogOpen] = useState(false);
  const [logRevision, setLogRevision] = useState(0);
  const [logError, setLogError] = useState('');
  const fieldHeading = useRef<HTMLHeadingElement>(null);
  const logId = useId();
  const sourceGroup = useId();
  const fieldPanelId = useId();
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [tracksSaved, setTracksSaved] = useState(false);
  const [trackSaveError, setTrackSaveError] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const canSave = Boolean(competition && getUser().roles.some(role => ['admin', 'editor', 'reviewer'].includes(role)));
  const result = run?.result;
  const completed = run?.status === 'completed';
  const materials = [...new Map((result?.pages ?? run?.livePages ?? []).map(page => [page.url, page])).values()];
  const tracks = [...new Map(materials.flatMap(page => page.tracks ?? []).map(track => [track.url, track])).values()];
  const trackSource = materials.find(page => page.kind === 'site' && page.tracks?.some(hasDiscoveryTrackDetails));
  const edition = trackSource?.tracks?.find(hasDiscoveryTrackDetails)?.edition;
  const unsavedTracks = Boolean(canSave && result?.runId && trackSource && !tracksSaved);
  const directories = materials.filter(page => page.kind === 'listing');
  const evidencePages = materials.filter(page => page.kind !== 'listing' && page.kind !== 'site'
    && (!edition || !page.edition || page.edition === edition));
  const sources = evidencePages.filter(page => page.fields.length > 0);
  const otherPages = evidencePages.filter(page => page.fields.length === 0);
  const generalNotices = sources.filter(page => page.kind === 'notice' && page.scope === 'general');
  const preferredSources = generalNotices.length ? generalNotices : sources;
  const activeSource = evidencePages.find(page => page.url === sourceUrl)
    ?? preferredSources.find(page => fieldValue(page, 'nearestDeadline') && fieldValue(page, 'competitionContent'))
    ?? preferredSources.find(page => fieldValue(page, 'nearestDeadline'))
    ?? preferredSources.find(page => fieldValue(page, 'competitionContent'))
    ?? preferredSources[0] ?? otherPages.find(page => page.kind === 'notice' && page.scope === 'general') ?? otherPages[0];
  const canSaveSource = Boolean(completed && canSave && result?.runId && activeSource?.fields.some(canSaveDiscoveryField));
  const deadline = activeSource && fieldValue(activeSource, 'nearestDeadline');
  const competitionContent = activeSource && fieldValue(activeSource, 'competitionContent');
  const schedule = activeSource && fieldValue(activeSource, 'scheduleNote');
  const signup = activeSource && fieldValue(activeSource, 'signupUrl');
  const excerpt = activeSource?.excerpt.split('\n').filter(line => line.trim() !== activeSource.title.trim()).join('\n').trim();

  useEffect(() => {
    if (reviewing) fieldHeading.current?.focus();
  }, [reviewing]);

  useEffect(() => {
    onUnsavedTracksChange?.(unsavedTracks);
  }, [onUnsavedTracksChange, unsavedTracks]);

  useEffect(() => {
    if (!runId) return;
    let active = true;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const snapshot = await api.get<DiscoveryRun>(`/agent/discovery-runs/${runId}`);
        if (!active) return;
        setRun(snapshot);
        setLogError('');
        if (snapshot.status === 'running') {
          timer = window.setTimeout(() => void poll(), 1000);
        } else {
          setBusy(false);
          if (snapshot.status === 'failed') setError(snapshot.error ?? '采集未完成，请重试。');
        }
      } catch (reason) {
        if (!active) return;
        if (reason instanceof ApiError && reason.code === 'RESOURCE_NOT_FOUND') {
          setLogError('本次采集记录已过期，请重新采集。');
          setBusy(false);
        } else {
          setLogError('暂时无法读取日志，正在重试连接。');
          timer = window.setTimeout(() => void poll(), 2500);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [runId]);

  const discover = async (): Promise<void> => {
    if (actionsDisabled || busy || saving) return;
    setError('');
    setBusy(true);
    setSaved(false);
    setTracksSaved(false);
    setTrackSaveError('');
    setReviewing(false);
    setSelectedKeys([]);
    setSourceUrl(null);
    setRunId(null);
    setRun(null);
    setLogError('');
    setLogRevision(current => current + 1);
    try {
      const started = await api.post<{ id: string }>('/agent/discovery-runs', competition
        ? { competitionId: competition.id }
        : { name: name.trim() });
      setRunId(started.id);
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  };

  const selectSource = (url: string): void => {
    if (url === sourceUrl) return;
    setSourceUrl(url);
    setSelectedKeys([]);
    setError('');
  };

  const toggleField = (key: string): void => {
    setSelectedKeys(keys => keys.includes(key) ? keys.filter(value => value !== key) : [...keys, key]);
  };

  const save = async (saveTracks = false): Promise<void> => {
    const source = saveTracks ? trackSource : activeSource;
    if (actionsDisabled || !competition || !result?.runId || !source || saving
      || (saveTracks ? !unsavedTracks : !canSaveSource || !selectedKeys.length)) return;
    const setSaveError = saveTracks ? setTrackSaveError : setError;
    setSaveError('');
    setSaving(true);
    onSavingChange?.(true);
    try {
      const detail = await api.post<CompetitionDetail>(`/competitions/${competition.id}/discovery-fields`, {
        pageUrl: source.url, keys: saveTracks ? ['discoveryTracks'] : selectedKeys, runId: result.runId,
      } satisfies DiscoverySelection);
      if (saveTracks) setTracksSaved(true);
      else {
        setSaved(true);
        setSelectedKeys([]);
      }
      onSave?.(detail);
    } catch (reason) {
      setSaveError((reason as Error).message);
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  };

  const renderSource = (page: DiscoveryPage): JSX.Element => (
    <li key={page.url}>
      <label className="discovery-source-option" data-selected={activeSource?.url === page.url}>
        <input type="radio" name={sourceGroup} checked={activeSource?.url === page.url} disabled={saving}
          onChange={() => selectSource(page.url)} aria-controls={fieldPanelId} />
        <span>
          <strong>{page.title}</strong>
          <small>{sourceMetadata(page)}</small>
          {fieldValue(page, 'nearestDeadline') && <small>报名截止 · {fieldValue(page, 'nearestDeadline')}</small>}
        </span>
        {page.fields.length > 0 && <Badge>{page.fields.length} 项字段</Badge>}
      </label>
    </li>
  );

  return (
    <div className="discovery-workspace">
      <Card title={competition ? '采集官网与公告' : '搜索竞赛官网'} className="discovery-start">
        <form className="discovery-form" onSubmit={event => { event.preventDefault(); void discover(); }}>
          {!competition && (
            <label className="discovery-input">
              <span className="field-label">竞赛名称</span>
              <input className="input" placeholder="例如，全国大学生数学建模竞赛"
                value={name} disabled={busy || saving} maxLength={120}
                onChange={event => setName(event.target.value)} />
            </label>
          )}
          <Button type="submit" variant="primary" disabled={actionsDisabled || busy || saving || name.trim().length < 2}>
            <Icon name="search" size={14} />
            {busy ? '采集中…' : result ? '重新采集' : '开始采集'}
          </Button>
          {(busy || runId) && (
            <button type="button" className="btn sm discovery-log-mobile" id={logId + '-toggle'} aria-controls={logId}
              aria-expanded={mobileLogOpen} onClick={() => setMobileLogOpen(value => !value)}>
              {mobileLogOpen ? '收起日志' : '查看日志'}
            </button>
          )}
        </form>
        {error && !result && <p role="alert" className="discovery-error">{error}</p>}
        {logError && !busy && <p role="alert" className="discovery-error">{logError}</p>}
      </Card>

      <DiscoveryLogPanel key={logRevision} id={logId} mobileOpen={mobileLogOpen} run={run}
        busy={busy} error={result ? '' : error} logError={logError}
        onToggleMobile={() => {
          setMobileLogOpen(false);
          document.getElementById(logId + '-toggle')?.focus();
        }} />

      {(busy || run) && (
        <div className="discovery-results">
          {saved && competition && (
            <div className="banner success" role="status">
              <Icon name="check" size={16} />
              <span className="stretch">已保存所选字段。</span>
              <Link className="btn sm" to={'/competitions/' + competition.id}>查看竞赛详情</Link>
            </div>
          )}
          {!tracks.length && <Card title="采集到的竞赛信息" className="discovery-live-card"
            actions={busy && <Badge tone="info">实时更新</Badge>}>
            <p className="discovery-live-status" role="status">
              {busy && !activeSource ? '正在查找本年度公告，核验后会显示在这里。'
                : activeSource ? `已核验 ${sources.length + otherPages.length} 个资料来源`
                  : completed ? '本次未找到可确认属于目标年份的赛事资料。' : '本次暂无已核验的赛事资料。'}
            </p>
            {activeSource && (
              <>
                <div className="discovery-live-source">
                  <div>
                    <h4>{activeSource.title}</h4>
                    <p>{sourceMetadata(activeSource)}</p>
                  </div>
                  <a className="btn sm" href={activeSource.url} target="_blank" rel="noreferrer">打开原文 <Icon name="external" size={14} /></a>
                </div>
                <dl className="discovery-key-facts">
                  <div className="discovery-deadline">
                    <dt>报名截止时间</dt>
                    <dd className={deadline ? 'discovery-deadline-value' : 'muted'}>{deadline ?? '该来源暂未提取到'}</dd>
                  </div>
                  <div className="discovery-contest-content">
                    <dt>{competitionContent ? '比赛内容' : '公告摘要'}</dt>
                    <dd>{competitionContent || excerpt || '该来源暂未提取到内容'}</dd>
                  </div>
                </dl>
                {(schedule || signup) && (
                  <dl className="discovery-key-facts discovery-extra-facts">
                    {schedule && <div><dt>比赛时间</dt><dd>{schedule}</dd></div>}
                    {signup && <div><dt>报名入口</dt><dd><SourceLink source={{ url: signup, title: '打开报名入口' }} /></dd></div>}
                  </dl>
                )}
              </>
            )}
            {busy && canSave && activeSource && <p className="discovery-hint">采集结束后可勾选字段并保存。</p>}
          </Card>}

          <DiscoveryTracks tracks={tracks} actions={unsavedTracks ? (
            <Button size="sm" variant="primary" disabled={actionsDisabled || saving} onClick={() => void save(true)}>
              {saving ? '正在保存…' : '保存赛道资料'}
            </Button>
          ) : busy ? <Badge tone="info">实时更新</Badge> : undefined}>
            {unsavedTracks && <p className="discovery-hint">核对届次和日期后保存，审核和竞赛详情会显示这些赛道资料。</p>}
            {tracksSaved && competition && (
              <p role="status" className="discovery-hint">赛道资料已保存。<Link to={'/competitions/' + competition.id}>查看竞赛详情</Link></p>
            )}
            {trackSaveError && <p role="alert" className="discovery-error">{trackSaveError}</p>}
          </DiscoveryTracks>

          {(evidencePages.length > 0 || directories.length > 0 || Boolean(result?.sites.length)) && (
          <details className="competition-detail-section" open={!tracks.length || undefined}>
            <summary>公告与资料来源{sources.length ? ` · ${sources.length} 个来源含提取字段` : ''}</summary>
          <Card className="discovery-source-card">
            {directories.length > 0 && (
              <ul className="discovery-directory-links">
                {directories.map(page => <li key={page.url}>官方通知栏目 · <SourceLink source={page} /></li>)}
              </ul>
            )}
            {sources.length > 0 || otherPages.length > 0 ? (
              <>
                <fieldset className="discovery-source-list">
                  <legend className="discovery-hint">含已提取字段（{sources.length}）</legend>
                  {sources.length > 0 ? <ul>{sources.map(renderSource)}</ul>
                    : <p className="discovery-hint">这些公告未提取到可保存的字段。</p>}
                  {otherPages.length > 0 && (
                    <details className="discovery-related" open={sources.length ? undefined : true}>
                      <summary>其他相关网页（{otherPages.length}）</summary>
                      <ul>{otherPages.map(renderSource)}</ul>
                    </details>
                  )}
                </fieldset>
                {activeSource && (
                  <Button size="sm" onClick={() => {
                    setSourceUrl(activeSource.url);
                    if (reviewing) fieldHeading.current?.focus();
                    else setReviewing(true);
                  }}>
                    {canSaveSource && !saved ? '去核对字段' : '查看字段与依据'}
                    <Icon name="arrow" size={14} />
                  </Button>
                )}
              </>
            ) : null}

            {result && result.sites.length > 0 && (
              <details className="discovery-related discovery-official">
                <summary>官网候选（{result.sites.length}）</summary>
                <ul>
                  {result.sites.map(site => (
                    <li key={site.url}>
                      <SourceLink source={site} />
                      {site.scope !== 'general' && <> <Badge tone="info">{SCOPE_LABEL[site.scope]}</Badge></>}
                      {site.evidence.length > 0 && (
                        <details>
                          <summary>查看判断依据</summary>
                          <ul>{site.evidence.map(proof => (
                            <li key={proof.reason + proof.url}>
                              {proof.reason === 'site_identity' ? '站点标题匹配' : '公告指向该站点'} · <SourceLink source={proof} />
                            </li>
                          ))}</ul>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>
          </details>
          )}

          {activeSource && reviewing && (
            <Card className="discovery-fields-card">
              <section id={fieldPanelId} aria-labelledby={fieldPanelId + '-heading'}>
                <div className="discovery-fields-header">
                  <div className="stretch">
                    <h3 ref={fieldHeading} tabIndex={-1} id={fieldPanelId + '-heading'}>核对字段</h3>
                    <p><strong>{activeSource.title}</strong></p>
                    <p className="discovery-hint">{sourceMetadata(activeSource)}</p>
                  </div>
                  <a className="btn sm" href={activeSource.url} target="_blank" rel="noreferrer">
                    <Icon name="external" size={14} /> 打开原文
                  </a>
                </div>
                {canSaveSource && !saved && <p className="discovery-hint">确认届次和适用范围后，勾选需要更新的字段。</p>}
                {activeSource.fields.length ? (
                  <ul className="discovery-fields">
                    {activeSource.fields.map(field => (
                      <li key={field.key}>
                        <div className="discovery-field">
                          {canSaveSource && !saved && canSaveDiscoveryField(field) ? (
                            <label className="discovery-field-label">
                              <input type="checkbox" aria-label={'选用' + field.label} checked={selectedKeys.includes(field.key)}
                                disabled={saving} onChange={() => toggleField(field.key)} />
                              <strong>{field.label}</strong>
                            </label>
                          ) : <strong>{field.label}</strong>}
                          {field.key === 'signupUrl' ? <SourceLink source={{ url: field.value, title: field.value }} /> : <span>{field.value}</span>}
                        </div>
                        {field.quote && <blockquote>{field.quote}</blockquote>}
                      </li>
                    ))}
                  </ul>
                ) : <p className="discovery-hint">{activeSource.excerpt || '该页面没有可核对的字段。'}</p>}
                {activeSource.attachments.length > 0 && (
                  <details className="discovery-related">
                    <summary>公告附件（{activeSource.attachments.length}）</summary>
                    <ul>{activeSource.attachments.map(attachment => <li key={attachment.url}><SourceLink source={attachment} /></li>)}</ul>
                  </details>
                )}
                {canSaveSource && !saved && (
                  <div className="discovery-save">
                    <span className="discovery-hint" role="status">{selectedKeys.length ? '已选 ' + selectedKeys.length + ' 项字段' : '请先勾选字段'}</span>
                    <Button variant="primary" disabled={actionsDisabled || saving || selectedKeys.length === 0} onClick={() => void save()}>
                      {saving ? '正在保存…' : '保存到竞赛'}
                    </Button>
                  </div>
                )}
                {error && result && <p role="alert" className="discovery-error">{error}</p>}
              </section>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
