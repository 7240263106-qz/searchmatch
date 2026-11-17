import type {
  ChangeEventType,
  Completeness,
  Credibility,
  DocumentType,
  FieldConfidence,
  FieldState,
  ParseTaskStatus,
  PublishStatus,
  RegistrationStatus,
  ReviewAction,
  SignupEntryType,
  SignupMethod,
  SiteStatus,
  SourceType,
} from './enums';

export interface ApiMeta {
  requestId?: string;
  replayed?: boolean;
  asOf?: string;
  appliedLimit?: number;
  featurePhase?: number;
  [key: string]: unknown;
}

export interface ApiSuccess<T> {
  data: T;
  meta?: ApiMeta;
}

export interface ApiFailure {
  error: {
    code: string;
    message: string;
    details?: unknown;
    traceId?: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface PageMeta {
  total: number;
  limit: number;
  nextCursor?: string | null;
  hasMore: boolean;
}

export interface PageQuery {
  cursor?: string;
  limit?: number;
}

export type TimePrecision = 'day' | 'second' | 'unknown';

export interface TimeValue {
  at: string | null;
  precision: TimePrecision;
  timezone: string | null;
  rawText?: string | null;
}

export interface Bucket {
  key: string;
  label: string;
  count: number;
}

export interface MatchReason {
  field: string;
  label: string;
  value: string;
  reason: string;
}

export interface EvidenceView {
  sourceId?: string | null;
  sourceTitle?: string | null;
  snippet: string;
  location?: Record<string, unknown> | null;
  extractMethod: string;
  confidence: FieldConfidence;
  manuallyCorrected: boolean;
  locatable: boolean;
}

export interface PreviewField {
  key: string;
  label: string;
  value: unknown;
  state: FieldState;
  confidence: FieldConfidence;
  evidence?: EvidenceView | null;
  time?: TimeValue | null;
  manuallyCorrected?: boolean;
}

export interface ConflictOption {
  value: string;
  rawText: string;
  sourceTitle?: string | null;
}

export interface ConflictGroup {
  field: string;
  label: string;
  requiresManual: boolean;
  options: ConflictOption[];
}

export interface DuplicateHint {
  competitionId: string;
  name: string;
  similarity: number;
  reason: string;
}

export interface ParsePreview {
  catalog?: import('./document-catalog').DocumentCatalog;
  taskId: string;
  documentId: string;
  resultVersionId: string;
  documentName: string;
  documentType: DocumentType;
  status: ParseTaskStatus;
  source?: 'rule' | 'llm' | 'fallback';
  hasText?: boolean;
  competitionId?: string | null;
  competitionName?: string | null;
  fields: PreviewField[];
  conflicts: ConflictGroup[];
  missing: string[];
  duplicates: DuplicateHint[];
  truncatedFrom?: string | null;
  summary: string;
}

export interface CompetitionCard {
  schoolRecognitionLevel?: string | null;
  id: string;
  name: string;
  seriesName?: string | null;
  editionName?: string | null;
  trackName?: string | null;
  category?: string | null;
  level?: string | null;
  organizer?: string | null;
  publishStatus: PublishStatus;
  completeness: Completeness;
  registrationStatus: RegistrationStatus;
  credibility: Credibility;
  credibilityScore: number;
  siteStatus: SiteStatus;
  signupMethod: SignupMethod;
  nearestDeadline?: TimeValue | null;
  tags: string[];
  matchedBy?: MatchReason[];
  favorited?: boolean;
  childCount?: number;
  discoveryTrackCount?: number;
  discoverySubjectCount?: number;
}

export interface RegistrationStageView {
  id: string;
  name: string;
  stageType: string;
  startAt?: TimeValue | null;
  endAt?: TimeValue | null;
  status: RegistrationStatus;
  applicableTo?: string | null;
}

export interface SignupEntryView {
  id: string;
  type: SignupEntryType;
  url?: string | null;
  method: SignupMethod;
  status: SiteStatus;
  note?: string | null;
  contact?: string | null;
  lastCheckedAt?: string | null;
  trustedDomain?: boolean;
}

export interface SourceMaterialView {
  id: string;
  type: SourceType;
  title: string;
  url?: string | null;
  documentId?: string | null;
  capturedAt: string;
}

export interface CompetitionDetail extends CompetitionCard {
  credibilityBasis?: string | null;
  discoveryTracks?: import('./discovery').DiscoveryTrack[];
  schoolRecognitionScope?: string | null;
  description?: string | null;
  eligibility?: Record<string, string>;
  schedule?: string | null;
  awards?: string | null;
  stages: RegistrationStageView[];
  entries: SignupEntryView[];
  sources: SourceMaterialView[];
  fieldStates: Record<string, FieldState>;
  evidenceFields: string[];
  versionNo: number;
  updatedAt: string;
  publishedAt?: string | null;
  changeEvents: ChangeEventSummary[];
  parentId?: string | null;
  children?: CompetitionCard[];
}

export interface ChangeEventSummary {
  id: string;
  type: ChangeEventType;
  field?: string | null;
  before?: string | null;
  after?: string | null;
  detectedAt: string;
}

export interface SearchQuery {
  scope?: 'published' | 'workspace';
  documentId?: string;
  keyword?: string;
  categories?: string[];
  levels?: string[];
  registrationStatus?: RegistrationStatus[];
  credibility?: Credibility[];
  deadlineFrom?: string;
  deadlineTo?: string;
  organizers?: string[];
  includeLowCredibility?: boolean;
  includeExpired?: boolean;
  eligibility?: {
    degree?: string;
    grade?: string;
    major?: string;
    region?: string;
    teamMode?: string;
    crossSchool?: boolean;
  };
  sort?: 'default' | 'deadline_asc' | 'deadline_desc' | 'updated_desc' | 'credibility_desc';
  cursor?: string;
  limit?: number;
}

export interface SearchResult {
  items: CompetitionCard[];
  page: PageMeta;
  facets: Record<string, Bucket[]>;
  excluded?: {
    count: number;
    reasons: Bucket[];
  };
  relaxSuggestions?: string[];
  asOf: string;
}

export interface DashboardOverview {
  asOf: string;
  totals: {
    published: number;
    pendingReview: number;
    draft: number;
    closingSoon: number;
  };
  distributions: {
    category: Bucket[];
    level: Bucket[];
    credibility: Bucket[];
  };
  trend: {
    basis: 'discovered' | 'ingested' | 'published';
    points: Array<{ date: string; count: number }>;
  };
  quality: {
    completenessRate: number;
    credibilityHighRate: number;
    siteAvailabilityRate: number;
    pendingReviewOldestHours: number;
  };
  definitions: Record<string, { definition: string; scope: string }>;
}

export interface DeadlineItem {
  competitionId: string;
  name: string;
  stageName: string;
  deadline: TimeValue;
  remainingDays: number;
  registrationStatus: RegistrationStatus;
  siteStatus: SiteStatus;
  missingFields: string[];
}

export interface ReviewQueueItem {
  competitionId: string;
  name: string;
  priority: number;
  priorityReason: string;
  completeness: Completeness;
  conflictCount: number;
  missingFields: string[];
  submittedAt: string;
  waitingHours: number;
}

export interface UploadFileResult {
  fileName: string;
  accepted: boolean;
  documentId?: string;
  deduplicated?: boolean;
  detectedType?: DocumentType;
  size?: number;
  reasonCode?: string;
  reason?: string;
}

export interface UploadBatchResult {
  results: UploadFileResult[];
  accepted: number;
  rejected: number;
}

export interface ParseTaskView {
  id: string;
  documentId: string;
  documentName?: string;
  status: ParseTaskStatus;
  stage?: string | null;
  progress: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  partialFields?: number;
}

export interface DocumentIntakeRow {
  id: string;
  fileName: string;
  detectedType: string;
  size: number;
  parseStatus: ParseTaskStatus;
  createdAt: string;
  expiresAt: string;
  fileUrl: string;
  deletionPending?: boolean;
  latestTask: Pick<ParseTaskView, 'id' | 'status' | 'stage' | 'progress' | 'errorCode' | 'errorMessage'> | null;
  reviewTaskId: string | null;
  linkedCompetition: { id: string; name: string; publishStatus: PublishStatus } | null;
  linkedCompetitionCount?: number;
}

export interface DraftView {
  id: string;
  ownerId: string;
  title?: string | null;
  payload: Record<string, unknown>;
  version: number;
  expiresAt: string;
  updatedAt: string;
  documentIds: string[];
}

export interface AgentQueryInput {
  sessionId?: string;
  message: string;
}

export interface AgentActionView {
  actionId: string;
  type: 'create_competition' | 'update_field' | 'delete' | 'merge' | 'publish' | 'subscribe';
  label: string;
  requiresConfirmation: boolean;
  payload: Record<string, unknown>;
}

export interface AgentAnswer {
  sessionId: string;
  turnId: string;
  conclusionType: 'result' | 'explanation' | 'clarification' | 'degraded';
  text: string;
  conditions?: SearchQuery | null;
  conditionsSummary?: string[];
  citations?: EvidenceView[];
  actions: AgentActionView[];
  degraded?: boolean;
}

export interface AuthContext {
  userId: string;
  displayName: string;
  roles: string[];
  teamId?: string | null;
}

export interface AuditEntryView {
  id: string;
  actorId: string;
  action: string;
  objectType: string;
  objectId: string;
  detail?: Record<string, unknown> | null;
  createdAt: string;
  hash: string;
}

export interface SourceView {
  id: string;
  name: string;
  address: string;
  normalizedAddress: string;
  type: SourceType;
  ownerKind: 'personal' | 'team';
  ownerId: string;
  intervalSeconds: number;
  enabled: boolean;
  verified: boolean;
  lastSuccessAt?: string | null;
  consecutiveFailures: number;
  structureSuspect: boolean;
}

export interface ReviewRecordView {
  id: string;
  competitionId: string;
  action: ReviewAction;
  reviewer: string;
  comment?: string | null;
  createdAt: string;
}

export const UI_TEXT = {
  appName: '竞赛雷达',
  appTagline: '竞赛信息收集智能体',
  disclaimer: '系统不代报名、不认定高校评优等级，参赛资格结论仅供参考。',
} as const;
