export const PUBLISH_STATUS = ['draft', 'pending_review', 'published', 'unpublished'] as const;
export type PublishStatus = (typeof PUBLISH_STATUS)[number];

export const COMPLETENESS = ['complete', 'partial', 'conflict'] as const;
export type Completeness = (typeof COMPLETENESS)[number];

export const REGISTRATION_STATUS = [
  'not_started',
  'open',
  'closing_soon',
  'closed',
  'undetermined',
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUS)[number];

export const CREDIBILITY = ['high', 'medium', 'low', 'pending'] as const;
export type Credibility = (typeof CREDIBILITY)[number];

export const SITE_STATUS = [
  'unverified',
  'accessible',
  'login_required',
  'temporarily_unavailable',
  'suspected_invalid',
] as const;
export type SiteStatus = (typeof SITE_STATUS)[number];

export const FIELD_STATE = [
  'explicit',
  'unmentioned',
  'not_applicable',
  'to_confirm',
  'unrecognized',
] as const;
export type FieldState = (typeof FIELD_STATE)[number];

export const FIELD_CONFIDENCE = ['high', 'medium', 'low'] as const;
export type FieldConfidence = (typeof FIELD_CONFIDENCE)[number];

export const PARSE_TASK_STATUS = [
  'queued',
  'processing',
  'succeeded',
  'partial',
  'failed',
  'canceled',
] as const;
export type ParseTaskStatus = (typeof PARSE_TASK_STATUS)[number];

export const SIGNUP_METHOD = [
  'web',
  'email',
  'school_unified',
  'offline',
  'to_be_announced',
] as const;
export type SignupMethod = (typeof SIGNUP_METHOD)[number];

export const SIGNUP_ENTRY_TYPE = ['official', 'school', 'backup', 'instruction'] as const;
export type SignupEntryType = (typeof SIGNUP_ENTRY_TYPE)[number];

export const SOURCE_TYPE = ['official_site', 'rss', 'uploaded_document', 'manual', 'other'] as const;
export type SourceType = (typeof SOURCE_TYPE)[number];

export const REVIEW_ACTION = ['approve', 'reject', 'merge', 'split', 'unpublish'] as const;
export type ReviewAction = (typeof REVIEW_ACTION)[number];

export const CHANGE_EVENT_TYPE = [
  'deadline_changed',
  'schedule_changed',
  'eligibility_changed',
  'entry_changed',
  'competition_canceled',
  'other',
] as const;
export type ChangeEventType = (typeof CHANGE_EVENT_TYPE)[number];

export const DOCUMENT_TYPE = ['pdf', 'word', 'excel', 'csv', 'text', 'image', 'unknown'] as const;
export type DocumentType = (typeof DOCUMENT_TYPE)[number];

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export const PUBLISH_STATUS_META: Record<PublishStatus, { label: string; tone: Tone }> = {
  draft: { label: '草稿', tone: 'neutral' },
  pending_review: { label: '待审核', tone: 'info' },
  published: { label: '已发布', tone: 'success' },
  unpublished: { label: '已下架', tone: 'neutral' },
};

export const COMPLETENESS_META: Record<Completeness, { label: string; tone: Tone }> = {
  complete: { label: '完整', tone: 'success' },
  partial: { label: '部分缺失', tone: 'warning' },
  conflict: { label: '存在冲突', tone: 'danger' },
};

export const REGISTRATION_STATUS_META: Record<RegistrationStatus, { label: string; tone: Tone }> = {
  not_started: { label: '未开始', tone: 'info' },
  open: { label: '报名中', tone: 'success' },
  closing_soon: { label: '即将截止', tone: 'warning' },
  closed: { label: '已截止', tone: 'neutral' },
  undetermined: { label: '时间待定', tone: 'info' },
};

export const CREDIBILITY_META: Record<Credibility, { label: string; tone: Tone }> = {
  high: { label: '高可信', tone: 'success' },
  medium: { label: '中可信', tone: 'warning' },
  low: { label: '低可信', tone: 'danger' },
  pending: { label: '待评估', tone: 'neutral' },
};

export const SITE_STATUS_META: Record<SiteStatus, { label: string; tone: Tone }> = {
  unverified: { label: '未校验', tone: 'neutral' },
  accessible: { label: '可访问', tone: 'success' },
  login_required: { label: '需登录', tone: 'info' },
  temporarily_unavailable: { label: '暂不可访问', tone: 'warning' },
  suspected_invalid: { label: '疑似失效', tone: 'danger' },
};

export const FIELD_STATE_META: Record<FieldState, { label: string; tone: Tone }> = {
  explicit: { label: '已明确', tone: 'success' },
  unmentioned: { label: '未提及', tone: 'neutral' },
  not_applicable: { label: '不适用', tone: 'neutral' },
  to_confirm: { label: '待确认', tone: 'info' },
  unrecognized: { label: '未识别', tone: 'warning' },
};

export const FIELD_CONFIDENCE_META: Record<FieldConfidence, { label: string; tone: Tone }> = {
  high: { label: '置信度高', tone: 'success' },
  medium: { label: '置信度中', tone: 'warning' },
  low: { label: '置信度低', tone: 'danger' },
};

export const PARSE_TASK_STATUS_META: Record<ParseTaskStatus, { label: string; tone: Tone }> = {
  queued: { label: '排队中', tone: 'neutral' },
  processing: { label: '处理中', tone: 'info' },
  succeeded: { label: '成功', tone: 'success' },
  partial: { label: '部分成功', tone: 'warning' },
  failed: { label: '失败', tone: 'danger' },
  canceled: { label: '已取消', tone: 'neutral' },
};

export const SIGNUP_METHOD_META: Record<SignupMethod, { label: string }> = {
  web: { label: '网页报名' },
  email: { label: '邮件报名' },
  school_unified: { label: '校内统一报名' },
  offline: { label: '线下报名' },
  to_be_announced: { label: '待公布' },
};

export const SIGNUP_ENTRY_TYPE_META: Record<SignupEntryType, { label: string }> = {
  official: { label: '官方报名入口' },
  school: { label: '校内报名入口' },
  backup: { label: '备用入口' },
  instruction: { label: '报名说明页' },
};

export const SOURCE_TYPE_META: Record<SourceType, { label: string }> = {
  official_site: { label: '官方网站' },
  rss: { label: 'RSS 订阅' },
  uploaded_document: { label: '上传文档' },
  manual: { label: '人工录入' },
  other: { label: '其他来源' },
};

export const REVIEW_ACTION_META: Record<ReviewAction, { label: string }> = {
  approve: { label: '审核通过' },
  reject: { label: '退回修改' },
  merge: { label: '合并' },
  split: { label: '拆分' },
  unpublish: { label: '下架' },
};

export const CHANGE_EVENT_TYPE_META: Record<ChangeEventType, { label: string }> = {
  deadline_changed: { label: '报名截止时间变更' },
  schedule_changed: { label: '比赛时间变更' },
  eligibility_changed: { label: '参赛资格变更' },
  entry_changed: { label: '报名入口变更' },
  competition_canceled: { label: '竞赛取消' },
  other: { label: '其他变更' },
};

export const DOCUMENT_TYPE_META: Record<DocumentType, { label: string }> = {
  pdf: { label: 'PDF 文档' },
  word: { label: 'Word 文档' },
  excel: { label: '表格文档' },
  csv: { label: 'CSV 文件' },
  text: { label: '纯文本' },
  image: { label: '扫描图片' },
  unknown: { label: '未知格式' },
};

export const CREDIBILITY_THRESHOLDS = {
  high: 80,
  medium: 50,
} as const;