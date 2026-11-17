import {
  CREDIBILITY_THRESHOLDS,
  type Completeness,
  type Credibility,
  type FieldState,
} from '@competition/contracts';

export const KEY_FIELD_LABELS: Record<string, string> = {
  name: '竞赛名称',
  organizer: '主办机构',
  signupMethod: '报名方式',
  nearestDeadline: '最近阶段截止时间',
  eligibility: '参赛对象',
};

export const KEY_FIELDS = Object.keys(KEY_FIELD_LABELS);

export interface QualityFieldInput {
  key: string;
  state: FieldState;
  value?: unknown;
}

function hasFieldValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    return !/^(?:\s*|[-—–]+|to_be_announced|待公布|待补充|待确认|待定|另行通知|暂无|未公布|详见官网|以官方通知为准)$/i.test(value.trim());
  }
  if (Array.isArray(value)) return value.some(hasFieldValue);
  if (typeof value === 'object') {
    if ('at' in value) return hasFieldValue((value as { at?: unknown }).at);
    return Object.values(value).some(hasFieldValue);
  }
  return true;
}

export function computeCompleteness(fields: QualityFieldInput[], hasConflict: boolean): Completeness {
  if (hasConflict) return 'conflict';
  const keyFields = fields.filter((field) => KEY_FIELDS.includes(field.key));
  const missing = KEY_FIELDS.filter((key) => {
    const field = keyFields.find((item) => item.key === key);
    if (!field) return true;
    if (field.state === 'unrecognized' || field.state === 'to_confirm') return true;
    if (field.state === 'unmentioned') return true;
    return !hasFieldValue(field.value);
  });
  const optionalMissing = fields.some(
    (field) => field.state === 'unrecognized' || field.state === 'to_confirm',
  );
  return missing.length === 0 && !optionalMissing ? 'complete' : 'partial';
}

export interface CredibilityInput {
  sourceTypes: string[];
  completeness: Completeness;
  distinctSourceCount: number;
  reviewed: boolean;
}

export interface CredibilityResult {
  score: number;
  level: Credibility;
  basis: string[];
}

export function computeCredibility(input: CredibilityInput): CredibilityResult {
  const basis: string[] = [];
  let score = 0;

  const hasOfficial = input.sourceTypes.some(
    (type) => type === 'official_site' || type === 'rss',
  );
  if (hasOfficial) {
    score += 40;
    basis.push('官方或 RSS 来源 +40');
  } else if (input.sourceTypes.includes('uploaded_document') || input.sourceTypes.includes('manual')) {
    score += 20;
    basis.push('可核验的文档或人工来源 +20');
  } else {
    score += 10;
    basis.push('来源类型未明确 +10');
  }

  if (input.completeness === 'complete') {
    score += 20;
    basis.push('关键字段完整 +20');
  } else if (input.completeness === 'partial') {
    score += 10;
    basis.push('关键字段部分缺失 +10');
  } else {
    basis.push('存在未解决冲突 +0');
  }

  if (input.completeness === 'conflict') {
    basis.push('多源冲突不计一致性分 +0');
  } else if (input.distinctSourceCount >= 2) {
    score += 20;
    basis.push('多个独立来源相互一致 +20');
  } else {
    score += 10;
    basis.push('单一来源（转载不计独立来源）+10');
  }

  if (input.reviewed) {
    score += 20;
    basis.push('已人工审核 +20');
  } else {
    basis.push('尚未人工审核 +0');
  }

  if (input.completeness === 'conflict' && score > CREDIBILITY_THRESHOLDS.high - 1) {
    score = CREDIBILITY_THRESHOLDS.high - 1;
    basis.push('存在冲突时可信度上限为中');
  }

  const level: Credibility =
    score >= CREDIBILITY_THRESHOLDS.high
      ? 'high'
      : score >= CREDIBILITY_THRESHOLDS.medium
        ? 'medium'
        : 'low';

  return { score, level, basis };
}

export function completenessLabel(completeness: Completeness): string {
  return completeness === 'complete' ? '完整' : completeness === 'conflict' ? '存在冲突' : '部分缺失';
}

export function missingKeyFields(fields: QualityFieldInput[]): string[] {
  return KEY_FIELDS.filter((key) => {
    const field = fields.find((item) => item.key === key);
    return (
      !field ||
      field.state === 'unrecognized' ||
      field.state === 'to_confirm' ||
      field.state === 'unmentioned' ||
      !hasFieldValue(field.value)
    );
  }).map((key) => KEY_FIELD_LABELS[key] ?? key);
}
