export interface DiscoveryField {
  key: string;
  label: string;
  value: string;
  quote: string;
}

export interface DiscoveryLink {
  url: string;
  title: string;
}

export interface DiscoveryTrack extends DiscoveryLink {
  edition?: string;
  subjects?: string[];
  registration?: Array<{ subject?: string; start: string; end: string; includesSubmission: boolean }>;
  schedule?: Array<{ subject: string; time: string; label?: string; source?: DiscoveryLink }>;
  guide?: DiscoveryLink;
  scheduleNotice?: DiscoveryLink;
}

export function hasDiscoveryTrackDetails(track: DiscoveryTrack): boolean {
  return Boolean(track.edition && ((track.guide && (track.registration?.length || track.subjects?.length))
    || (track.scheduleNotice && track.schedule?.length)));
}

export interface DiscoveryPage extends DiscoveryLink {
  kind: 'site' | 'listing' | 'notice' | 'attachment';
  scope: 'general' | 'regional' | 'track' | null;
  year: number | null;
  edition: string | null;
  excerpt: string;
  fields: DiscoveryField[];
  attachments: DiscoveryLink[];
  tracks?: DiscoveryTrack[];
}

export interface DiscoverySite extends DiscoveryLink {
  scope: NonNullable<DiscoveryPage['scope']>;
  evidence: Array<DiscoveryLink & { reason: 'site_identity' | 'official_link' }>;
}

export interface DiscoveryResult {
  runId?: string;
  name: string;
  targetYear?: number;
  searchedAt: string;
  matching: 'rules' | 'model_assisted';
  searches: Array<{
    provider: string;
    query: string;
    found: number;
    relevant: number;
    error?: string;
  }>;
  sites: DiscoverySite[];
  pages: DiscoveryPage[];
  issues: Array<{ url: string; reason: string }>;
}

export interface DiscoverySelection {
  runId: string;
  pageUrl: string;
  keys: string[];
}

export interface DiscoveryLog {
  at: string;
  stage: 'task' | 'search' | 'matching' | 'page' | 'attachment' | 'extract';
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  url?: string;
  reason?: string;
  durationMs?: number;
  operation?: {
    id: string;
    label: string;
    phase: 'start' | 'detail' | 'end';
  };
}

export interface DiscoveryRun {
  id: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  logs: DiscoveryLog[];
  /** Year-verified pages that arrived before the run completed. */
  livePages?: DiscoveryPage[];
  result?: DiscoveryResult;
  error?: string;
}

export function canSaveDiscoveryField(field: DiscoveryField): boolean {
  return ['organizer', 'eligibility', 'competitionContent', 'scheduleNote', 'signupUrl'].includes(field.key)
    || (field.key === 'nearestDeadline' && /(?:^|[^\d])20\d{2}\s*[年./-]/.test(field.value));
}
