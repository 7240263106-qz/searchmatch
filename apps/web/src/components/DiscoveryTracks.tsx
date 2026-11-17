import type { ReactNode } from 'react';
import type { DiscoveryTrack, DiscoveryLink } from '@competition/contracts';
import { compactCompetitionDate } from '../lib/format';
import { Card } from './ui';

function SourceLink({ source }: { source: DiscoveryLink }): JSX.Element {
  return <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>;
}

function registrationLabel(window: NonNullable<DiscoveryTrack['registration']>[number]): string {
  return window.includesSubmission ? '报名及交稿截止' : '报名截止';
}

function subjectKey(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, '');
}

function TrackDetails({ track }: { track: DiscoveryTrack }): JSX.Element {
  const windows = track.registration ?? [];
  const schedule = track.schedule ?? [];
  const commonWindows = windows.filter(window => !window.subject);
  const subjects = new Map<string, string>();
  for (const name of [...(track.subjects ?? []), ...windows.map(window => window.subject), ...schedule.map(row => row.subject)]) {
    if (name && !subjects.has(subjectKey(name))) subjects.set(subjectKey(name), name);
  }
  const hasDetails = Boolean(windows.length || subjects.size);
  return (
    <li className="discovery-track">
      {hasDetails ? (
        <details>
          <summary className="discovery-track-summary">
            <span className="discovery-track-name">
              <strong>{track.title}</strong>
              {subjects.size > 0 && <small>{subjects.size} 个科目</small>}
            </span>
            {windows.length === 1 && (
              <span className="competition-deadline">
                <small>{windows[0].subject ? `${windows[0].subject} · ` : ''}{registrationLabel(windows[0])}</small>
                <strong>{compactCompetitionDate(windows[0].end)}</strong>
              </span>
            )}
            {windows.length > 1 && (
              <span className="competition-deadline"><small>{windows.length} 个分项截止</small></span>
            )}
          </summary>
          <div className="discovery-track-body">
            {subjects.size > 0 && (
              <ul className="discovery-track-subjects competition-subgrid" aria-label="比赛科目">
                {[...subjects].map(([key, subject]) => {
                  const specificWindows = windows.filter(window => window.subject && subjectKey(window.subject) === key);
                  const dates = specificWindows.length ? specificWindows : commonWindows;
                  const rounds = schedule.filter(row => subjectKey(row.subject) === key);
                  const stages = rounds.map(row => (
                    <div className={row.label?.includes('截止') ? 'competition-deadline' : 'discovery-subject-round'}
                      key={(row.label ?? '') + row.time}>
                      <dt>{row.label ?? '省赛／选拔赛'}</dt>
                      <dd>{row.source ? (
                        <a href={row.source.url} target="_blank" rel="noreferrer" title={row.source.title}
                          aria-label={`${compactCompetitionDate(row.time)}，查看赛程原文`}>
                          {compactCompetitionDate(row.time)}
                        </a>
                      ) : compactCompetitionDate(row.time)}</dd>
                    </div>
                  ));
                  return (
                    <li className="competition-subcard" key={key}>
                      <strong>{subject}</strong>
                      {(dates.length > 0 || rounds.length > 0) ? (
                        <dl className="discovery-subject-dates">
                          {dates.map(window => (
                            <div className="competition-deadline" key={window.start + window.end}>
                              <dt>{registrationLabel(window)}</dt><dd><strong>{compactCompetitionDate(window.end)}</strong></dd>
                            </div>
                          ))}
                          {stages.length > 2 ? stages.slice(0, 1) : stages}
                        </dl>
                      ) : <small className="muted">日期待核实</small>}
                      {stages.length > 2 && (
                        <details className="discovery-track-registration">
                          <summary>其余赛程（{stages.length - 1} 项）</summary>
                          <dl className="discovery-subject-dates">{stages.slice(1)}</dl>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {windows.length > 0 && (
              <details className="discovery-track-registration">
                <summary>{subjects.size ? '报名开放时间' : '报名时段'}</summary>
                <ul>
                  {windows.map(window => (
                    <li key={(window.subject ?? '') + window.start + window.end}>
                      {window.subject && `${window.subject} · `}{compactCompetitionDate(window.start)}
                      {!subjects.size && ` 至 ${compactCompetitionDate(window.end)}`}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="discovery-track-links">
              <SourceLink source={{ url: track.url, title: track.guide?.url === track.url ? '官方赛题目录' : '打开官方入口' }} />
              {track.guide && track.guide.url !== track.url && (
                <SourceLink source={{ ...track.guide, title: /\.pdf(?:[?#]|$)/i.test(track.guide.url) ? '报名说明（PDF）' : track.guide.title }} />
              )}
              {track.scheduleNotice && <SourceLink source={{ ...track.scheduleNotice, title: '省赛时间公告' }} />}
            </div>
          </div>
        </details>
      ) : <SourceLink source={track} />}
    </li>
  );
}

export function DiscoveryTrackList({ tracks }: { tracks: DiscoveryTrack[] }): JSX.Element {
  return (
    <div className="competition-track-layout">
      <ul className="discovery-track-list">{tracks.map(track => <TrackDetails key={track.url} track={track} />)}</ul>
    </div>
  );
}

export default function DiscoveryTracks({ tracks, actions, children, saved = false }: {
  tracks: DiscoveryTrack[];
  actions?: ReactNode;
  children?: ReactNode;
  saved?: boolean;
}): JSX.Element | null {
  if (!tracks.length) return null;
  const edition = tracks.find(track => track.edition)?.edition;
  return (
    <Card title={`${saved ? '已保存的' : ''}${edition ?? '官方'}赛道（${tracks.length}）`} actions={actions}>
      {children}
      <DiscoveryTrackList tracks={tracks} />
    </Card>
  );
}
