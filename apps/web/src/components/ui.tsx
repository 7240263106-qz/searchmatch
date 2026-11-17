import { createContext, useContext, type ReactNode } from 'react';
import type { Tone } from '@competition/contracts';
import {
  COMPLETENESS_META,
  CREDIBILITY_META,
  FIELD_CONFIDENCE_META,
  FIELD_STATE_META,
  PARSE_TASK_STATUS_META,
  PUBLISH_STATUS_META,
  REGISTRATION_STATUS_META,
  SITE_STATUS_META,
} from '@competition/contracts';

export type IconName =
  | 'dashboard'
  | 'upload'
  | 'search'
  | 'review'
  | 'source'
  | 'bell'
  | 'bot'
  | 'chart'
  | 'settings'
  | 'plus'
  | 'refresh'
  | 'external'
  | 'spark'
  | 'clock'
  | 'file'
  | 'download'
  | 'check'
  | 'close'
  | 'shield'
  | 'filter'
  | 'sun'
  | 'moon'
  | 'arrow'
  | 'alert';

const PATHS: Record<IconName, string> = {
  dashboard: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  upload: 'M12 16V4m0 0L7 9m5-5 5 5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2',
  search: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm10 2-4.35-4.35',
  review: 'M9 11l3 3 8-8M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9',
  source: 'M4 6h16M4 12h16M4 18h16M7 6v12M17 6v12',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M10 21h4',
  bot: 'M12 3v3M6 8h12v11H6zM9 12h.01M15 12h.01M9 16h6',
  chart: 'M4 19V5m0 14h16M8 15l3-4 3 2 4-6',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  spark: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  file: 'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4ZM14 3v4h4M9 13h6M9 17h6',
  download: 'M12 4v10m0 0 4-4m-4 4-4-4M5 20h14',
  check: 'M5 12l5 5L20 7',
  close: 'M6 6l12 12M18 6L6 18',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z',
  filter: 'M4 6h16M7 12h10M10 18h4',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  arrow: 'M5 12h14m0 0-6-6m6 6-6 6',
  alert: 'M12 9v4m0 4h.01M10.3 4.3 2.6 18a1.5 1.5 0 0 0 1.3 2.2h16.2a1.5 1.5 0 0 0 1.3-2.2L13.7 4.3a1.5 1.5 0 0 0-2.6 0Z',
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }): ReactNode {
  return (
    <span className={`badge tone-${tone}`}>
      <span className="badge-dot" />
      {children}
    </span>
  );
}

export function PublishBadge({ value }: { value: string }): ReactNode {
  const meta = PUBLISH_STATUS_META[value as keyof typeof PUBLISH_STATUS_META];
  return meta ? <Badge tone={meta.tone}>{meta.label}</Badge> : <Badge>{value}</Badge>;
}

export function RegistrationBadge({ value }: { value: string }): ReactNode {
  const meta = REGISTRATION_STATUS_META[value as keyof typeof REGISTRATION_STATUS_META];
  return meta ? <Badge tone={meta.tone}>{meta.label}</Badge> : <Badge>{value}</Badge>;
}

export function CredibilityBadge({ value }: { value: string }): ReactNode {
  const meta = CREDIBILITY_META[value as keyof typeof CREDIBILITY_META];
  return meta ? <Badge tone={meta.tone}>{meta.label}</Badge> : <Badge>{value}</Badge>;
}

export function CompletenessBadge({ value }: { value: string }): ReactNode {
  const meta = COMPLETENESS_META[value as keyof typeof COMPLETENESS_META];
  return meta ? <Badge tone={meta.tone}>{meta.label}</Badge> : <Badge>{value}</Badge>;
}

export function SiteBadge({ value }: { value: string }): ReactNode {
  const meta = SITE_STATUS_META[value as keyof typeof SITE_STATUS_META];
  return meta ? <Badge tone={meta.tone}>{meta.label}</Badge> : <Badge>{value}</Badge>;
}

export function ParseBadge({ value }: { value: string }): ReactNode {
  const meta = PARSE_TASK_STATUS_META[value as keyof typeof PARSE_TASK_STATUS_META];
  return meta ? <Badge tone={meta.tone}>{meta.label}</Badge> : <Badge>{value}</Badge>;
}

export function FieldStateBadge({ value }: { value: string }): ReactNode {
  const meta = FIELD_STATE_META[value as keyof typeof FIELD_STATE_META];
  return meta ? <Badge tone={meta.tone}>{meta.label}</Badge> : <Badge>{value}</Badge>;
}

export function ConfidenceBadge({ value }: { value: string }): ReactNode {
  const meta = FIELD_CONFIDENCE_META[value as keyof typeof FIELD_CONFIDENCE_META];
  return meta ? <Badge tone={meta.tone}>{meta.label}</Badge> : <Badge>{value}</Badge>;
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h3 className="card-title">{title}</h3>}
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Button({
  children,
  variant = 'default',
  size,
  onClick,
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm';
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
}): ReactNode {
  const variantClass = variant === 'default' ? '' : ` ${variant}`;
  return (
    <button
      type={type}
      className={`btn${variantClass}${size ? ` ${size}` : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  icon,
  accent = false,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: IconName;
  accent?: boolean;
}): ReactNode {
  return (
    <div className="card metric">
      <div className="metric-top">
        <span className="metric-icon" style={accent ? { background: 'var(--success-soft)', color: 'var(--success)' } : undefined}>
          <Icon name={icon} size={15} />
        </span>
        {label}
      </div>
      <div className="metric-value">{value}</div>
      {hint && <div className="metric-foot">{hint}</div>}
    </div>
  );
}

export function AsyncState({
  status,
  message,
  onRetry,
  asOf,
  children,
}: {
  status: 'loading' | 'error' | 'empty' | 'partial' | 'forbidden' | 'stale' | 'ready';
  message?: string;
  onRetry?: () => void;
  asOf?: string;
  children?: ReactNode;
}): ReactNode {
  if (status === 'ready') return <>{children}</>;
  if (status === 'loading') {
    return (
      <div className="list" aria-busy="true">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="skeleton" style={{ height: 54, marginBottom: 10 }} />
        ))}
      </div>
    );
  }
  const titles: Record<string, string> = {
    error: '加载失败',
    empty: '暂无数据',
    partial: '部分数据可用',
    forbidden: '无权访问',
    stale: '数据已过期',
  };
  const descs: Record<string, string> = {
    error: message ?? '请稍后重试，或检查服务是否已启动。',
    empty: message ?? '当前筛选条件下没有匹配结果，可尝试放宽条件。',
    partial: message ?? '部分阶段未完成，仍可继续查看已有结果。',
    forbidden: message ?? '你没有访问该对象的权限。',
    stale: message ?? '展示的是上次成功加载的数据。',
  };
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={status === 'forbidden' ? 'shield' : status === 'error' ? 'alert' : 'file'} size={20} />
      </div>
      <div className="empty-title">{titles[status]}</div>
      <div className="empty-desc">{descs[status]}</div>
      {asOf && <div className="empty-desc mono">数据时间：{asOf}</div>}
      {onRetry && status !== 'forbidden' && (
        <Button variant="primary" size="sm" onClick={onRetry}>
          <Icon name="refresh" size={13} /> 重新加载
        </Button>
      )}
    </div>
  );
}

export const PageHeaderLevel = createContext<1 | 2>(1);

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}): ReactNode {
  const Heading = useContext(PageHeaderLevel) === 2 ? 'h2' : 'h1';
  return (
    <div className={`page-head${Heading === 'h2' ? ' section-head' : ''}`}>
      <div>
        <Heading className="page-title">{title}</Heading>
        {description && <div className="page-desc">{description}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
