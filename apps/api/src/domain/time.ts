import type { RegistrationStatus, TimePrecision, TimeValue } from '@competition/contracts';

const TZ_OFFSET_MINUTES: Record<string, number> = {
  'Asia/Shanghai': 8 * 60,
  'Asia/Hong_Kong': 8 * 60,
  'UTC': 0,
};

const DATE_PATTERN =
  /(\d{4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?(?:\s*(\d{1,2})\s*[:：时]\s*(\d{1,2})(?:\s*[:：分]\s*(\d{1,2}))?)?/;

export const FALLBACK_TIMEZONE = 'Asia/Shanghai';

export function parseDateTime(raw: string, timezone: string = FALLBACK_TIMEZONE): TimeValue {
  const text = raw.trim();
  if (!text) {
    return { at: null, precision: 'unknown', timezone, rawText: raw };
  }
  if (/(另行通知|待定|暂无|未确定|以.*通知为准)/.test(text)) {
    return { at: null, precision: 'unknown', timezone, rawText: raw };
  }
  if (/(即日起|本月底|下月|近期|另行公布)/.test(text) && !DATE_PATTERN.test(text)) {
    return { at: null, precision: 'unknown', timezone, rawText: raw };
  }

  const match = DATE_PATTERN.exec(text);
  if (!match) {
    if (/(即日|月底|下月)/.test(text)) {
      return { at: null, precision: 'unknown', timezone, rawText: raw };
    }
    return { at: null, precision: 'unknown', timezone, rawText: raw };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] ? Number(match[4]) : null;
  const minute = match[5] ? Number(match[5]) : null;
  const second = match[6] ? Number(match[6]) : 0;

  if (!month || !day) {
    return { at: null, precision: 'unknown', timezone, rawText: raw };
  }

  const offset = TZ_OFFSET_MINUTES[timezone] ?? 0;
  const hasTime = hour !== null;
  const precision: TimePrecision = hasTime ? 'second' : 'day';
  const utcMs =
    Date.UTC(year, month - 1, day, hour ?? 0, minute ?? 0, second) - offset * 60 * 1000;

  return {
    at: new Date(utcMs).toISOString(),
    precision,
    timezone,
    rawText: raw,
  };
}

export function endOfDayIfNeeded(value: TimeValue): Date | null {
  if (!value.at) return null;
  if (value.precision === 'day') {
    return new Date(new Date(value.at).getTime() + 23 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000);
  }
  return new Date(value.at);
}

export interface StageTiming {
  startAt?: TimeValue | null;
  endAt?: TimeValue | null;
}

export function deriveRegistrationStatus(
  stage: StageTiming | null | undefined,
  now: Date = new Date(),
): RegistrationStatus {
  if (!stage || !stage.endAt || !stage.endAt.at) return 'undetermined';
  const deadline = endOfDayIfNeeded(stage.endAt);
  if (!deadline) return 'undetermined';
  const diffMs = deadline.getTime() - now.getTime();
  if (diffMs < 0) return 'closed';
  if (diffMs <= 7 * 24 * 60 * 60 * 1000) return 'closing_soon';
  if (stage.startAt && stage.startAt.at && new Date(stage.startAt.at) > now) return 'not_started';
  return 'open';
}

export function nearestOpenStage<T extends StageTiming & { sortOrder?: number }>(
  stages: T[],
  now: Date = new Date(),
): T | null {
  const withDeadline = stages
    .filter((stage) => stage.endAt?.at)
    .sort((a, b) => {
      const left = new Date(a.endAt?.at ?? 0).getTime();
      const right = new Date(b.endAt?.at ?? 0).getTime();
      return left - right || (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    });
  const open = withDeadline.find((stage) => {
    const deadline = endOfDayIfNeeded(stage.endAt as TimeValue);
    return deadline !== null && deadline.getTime() >= now.getTime();
  });
  return open ?? withDeadline[0] ?? null;
}

export function remainingDays(value: TimeValue | null | undefined, now: Date = new Date()): number {
  const deadline = value ? endOfDayIfNeeded(value) : null;
  if (!deadline) return -1;
  return Math.ceil((deadline.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

export function formatTimeValue(value: TimeValue | null | undefined): string {
  if (!value || !value.at) return '时间待定';
  const date = new Date(value.at);
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: value.timezone ?? FALLBACK_TIMEZONE,
  });
  if (value.precision === 'second') {
    return `${formatter.format(date)} ${new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: value.timezone ?? FALLBACK_TIMEZONE,
    }).format(date)}`;
  }
  return `${formatter.format(date)}（日期精度）`;
}

export function detectCandidateDates(text: string): TimeValue[] {
  const candidates: TimeValue[] = [];
  const global = new RegExp(DATE_PATTERN.source, 'g');
  let match = global.exec(text);
  while (match) {
    candidates.push(parseDateTime(match[0]));
    match = global.exec(text);
  }
  return candidates;
}