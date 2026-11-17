import type {
  ConflictGroup,
  ConflictOption,
  FieldConfidence,
  FieldState,
  TimeValue,
} from '@competition/contracts';
import { KEY_FIELD_LABELS, missingKeyFields, type QualityFieldInput } from './quality';
import { detectCandidateDates, parseDateTime } from './time';

export interface TextBlock {
  text: string;
  location: Record<string, unknown>;
}

export interface FieldEvidenceDraft {
  snippet: string;
  location: Record<string, unknown> | null;
  extractMethod: string;
  confidence: FieldConfidence;
}

export interface ExtractedField {
  key: string;
  label: string;
  value: string | null;
  state: FieldState;
  confidence: FieldConfidence;
  evidence: FieldEvidenceDraft | null;
  alternatives?: ConflictOption[];
  time?: TimeValue | null;
}

export interface ExtractionResult {
  catalog?: import('@competition/contracts').DocumentCatalog;
  fields: ExtractedField[];
  conflicts: ConflictGroup[];
  missing: string[];
  competitionName: string | null;
  summary: string;
  textPreview: string;
  truncatedFrom: string | null;
}

const DEADLINE_ANCHOR = /(报名截止|截止日期|截止时间|报名时间|报名期间|报名日期)/;
const SCHEDULE_ANCHOR = /(比赛时间|竞赛时间|比赛日期|决赛时间|举行时间|赛事时间|初赛时间)/;
const ORGANIZER_ANCHOR = /(主办单位|主办方|主办机构|承办单位|组织单位|指导单位)/;
const VALID_ORGANIZER = /(?:政府|委员会|组委会|教育部|教育厅|协会|学会|联合会|研究会|科学院|工程院|大学|高校|学校|中心|公司|集团|联盟|基金会|研究院|研究所|共青团|统战部|网信办|工信部|知识产权局|农业农村部)$/;
const ELIGIBILITY_ANCHOR = /(参赛对象|参赛资格|参赛条件|参赛要求|面向|报名条件)/;
const FEE_ANCHOR = /(报名费|参赛费|费用|收费标准)/;
const INJECTION_PATTERN =
  /(忽略(以上|之前|上述).*(规则|指令)|ignore (all|previous|above).*(instructions|rules)|system prompt|删除所有数据|导出全部数据)/i;

const URL_PATTERN = /https?:\/\/[^\s"'<>，。；）)]+/i;
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const CATEGORY_RULES: Array<{ key: string; pattern: RegExp }> = [
  { key: '计算机与软件', pattern: /(算法|程序设计|软件|编程|计算机|人工智能|大数据|信息安全|网络安全|蓝桥杯|ACM|ICPC)/i },
  { key: '电子信息', pattern: /(电子设计|嵌入式|集成电路|通信|芯片|机器人|无人机)/i },
  { key: '数学与统计', pattern: /(数学建模|数学竞赛|统计建模|概率|数理)/i },
  { key: '物理与力学', pattern: /(物理|力学|天文)/i },
  { key: '化学与生物', pattern: /(化学|生物|医学|药学)/i },
  { key: '机械与制造', pattern: /(机械|制造|工业设计|工程训练|cad)/i },
  { key: '创新创业', pattern: /(创新创业|创业计划|互联网\+|挑战杯|商业计划)/i },
  { key: '设计与艺术', pattern: /(设计大赛|广告|摄影|视觉|艺术|创意)/i },
  { key: '外语与人文', pattern: /(英语|外语|翻译|写作|辩论|演讲)/i },
];

const LEVEL_RULES: Array<{ key: string; pattern: RegExp }> = [
  { key: '国际级', pattern: /(国际|全球|世界|亚太)/ },
  { key: '国家级', pattern: /(国家级|全国|中国|国家)/ },
  { key: '省级', pattern: /(省级|省|赛区|地区)/ },
  { key: '市级', pattern: /(市级|市)/ },
  { key: '校级', pattern: /(校级|校内|学院)/ },
];

export function detectPromptInjection(text: string): boolean {
  return INJECTION_PATTERN.test(text);
}

function blockFor(text: string, blocks: TextBlock[]): TextBlock {
  return (
    blocks.find((block) => block.text.includes(text)) ?? {
      text,
      location: { kind: 'text', line: 0 },
    }
  );
}

function evidenceOf(
  snippet: string,
  blocks: TextBlock[],
  confidence: FieldConfidence,
  method = 'rule',
): FieldEvidenceDraft {
  return {
    snippet: snippet.trim().slice(0, 800),
    location: blockFor(snippet, blocks).location,
    extractMethod: method,
    confidence,
  };
}

function confidenceFor(hasAnchor: boolean, hasDate: boolean): FieldConfidence {
  if (hasAnchor && hasDate) return 'high';
  if (hasAnchor) return 'medium';
  return 'low';
}

export function extractFields(
  text: string,
  blocks: TextBlock[],
  fileName: string,
): ExtractionResult {
  const sourceBlocks = blocks.length > 0 ? blocks : [{ text, location: { kind: 'text' } }];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\u3000/g, ' ').trim())
    .filter((line) => line.length > 0);

  const fields: ExtractedField[] = [];
  const conflicts: ConflictGroup[] = [];
  const injectionDetected = detectPromptInjection(text);

  const nameLine =
    lines.find(
      (line) =>
        line.length >= 4 &&
        line.length <= 80 &&
        /(大赛|竞赛|比赛|挑战赛|锦标赛|联赛|赛)$/.test(line.replace(/[：:].*$/, '')),
    ) ??
    lines.find((line) => /(大赛|竞赛|比赛|挑战赛|锦标赛|联赛)/.test(line) && line.length <= 100) ??
    lines[0] ??
    fileName.replace(/\.[^.]+$/, '');

  const competitionName = nameLine.replace(/^[#\s]*/, '').replace(/[：:]\s*$/, '').slice(0, 120);
  fields.push({
    key: 'name',
    label: KEY_FIELD_LABELS.name ?? '竞赛名称',
    value: competitionName,
    state: competitionName ? 'explicit' : 'unrecognized',
    confidence: competitionName ? 'high' : 'low',
    evidence: evidenceOf(competitionName, sourceBlocks, competitionName ? 'high' : 'low'),
  });

  const deadlineOptions: Array<{ time: TimeValue; line: string }> = [];
  let startTime: TimeValue | null = null;
  let scheduleTime: TimeValue | null = null;
  const organizerLines: string[] = [];
  let eligibility: string | null = null;
  let fee: string | null = null;
  let signupUrl: string | null = null;
  let email: string | null = null;
  let signupMethod: string | null = null;

  for (const line of lines) {
    const dates = detectCandidateDates(line);

    if (DEADLINE_ANCHOR.test(line)) {
      const isRange = /(报名时间|报名期间|报名日期)/.test(line) && dates.length >= 2;
      if (isRange) {
        const first = dates[0];
        const last = dates[dates.length - 1];
        if (first) startTime = first;
        if (last) deadlineOptions.push({ time: last, line });
      } else if (dates.length > 0) {
        const last = dates[dates.length - 1];
        if (last) deadlineOptions.push({ time: last, line });
      } else {
        deadlineOptions.push({ time: parseDateTime(line), line });
      }
    }

    if (SCHEDULE_ANCHOR.test(line) && dates.length > 0) {
      const first = dates[0];
      if (first) scheduleTime = first;
    }

    if (ORGANIZER_ANCHOR.test(line) && !/第一届|历届|往届|上届/.test(line) &&
      (/(?:^|[（(][一二三四五六七八九十\d]+[）)])\s*(?:联合)?主办单位?\s*[:：]\s*\S/.test(line) || /由.{2,100}主办/.test(line))) {
      organizerLines.push(line);
    }

    if (!eligibility && /^(?:[（(][一二三四五六七八九十\d]+[）)]|[一二三四五六七八九十\d]+[、.])?\s*(?:参赛对象|参赛资格|参赛条件|报名条件|参加人员|参加对象)\s*[:：]/.test(line)) {
      eligibility = line.slice(0, 500);
    }

    if (!fee && FEE_ANCHOR.test(line)) {
      fee = line.slice(0, 200);
    }

    const urlMatch = URL_PATTERN.exec(line);
    if (!signupUrl && urlMatch) signupUrl = urlMatch[0];
    const emailMatch = EMAIL_PATTERN.exec(line);
    if (!emailMatch) {
      // continue scanning for method signals below
    } else {
      email = email ?? emailMatch[0];
    }
  }

  if (email) signupMethod = 'email';
  else if (signupUrl) signupMethod = 'web';
  else if (/(校内|学院统一|学校统一)/.test(text)) signupMethod = 'school_unified';
  else if (/(线下|现场报名)/.test(text)) signupMethod = 'offline';
  else signupMethod = 'to_be_announced';

  const uniqueDeadlines = new Map<string, { time: TimeValue; line: string }>();
  for (const option of deadlineOptions) {
    const key = option.time.at ?? option.time.rawText ?? '';
    if (key && !uniqueDeadlines.has(key)) uniqueDeadlines.set(key, option);
  }

  let deadlineValue: ExtractedField;
  if (uniqueDeadlines.size > 1) {
    const options = [...uniqueDeadlines.values()];
    conflicts.push({
      field: 'nearestDeadline',
      label: KEY_FIELD_LABELS.nearestDeadline ?? '报名截止时间',
      requiresManual: true,
      options: options.map((option) => ({
        value: option.time.at ?? 'unknown',
        rawText: option.time.rawText ?? option.line,
        sourceTitle: null,
      })),
    });
    deadlineValue = {
      key: 'nearestDeadline',
      label: KEY_FIELD_LABELS.nearestDeadline ?? '报名截止时间',
      value: null,
      state: 'to_confirm',
      confidence: 'low',
      evidence: evidenceOf(options[0]?.line ?? '', sourceBlocks, 'low'),
      alternatives: options.map((option) => ({
        value: option.time.at ?? 'unknown',
        rawText: option.time.rawText ?? option.line,
      })),
      time: options[0]?.time ?? null,
    };
  } else {
    const option = uniqueDeadlines.values().next().value as { time: TimeValue; line: string } | undefined;
    deadlineValue = {
      key: 'nearestDeadline',
      label: KEY_FIELD_LABELS.nearestDeadline ?? '报名截止时间',
      value: option?.time.at ?? null,
      state: option ? (option.time.at ? 'explicit' : 'unrecognized') : 'unmentioned',
      confidence: option ? confidenceFor(true, Boolean(option.time.at)) : 'low',
      evidence: option ? evidenceOf(option.line, sourceBlocks, confidenceFor(true, Boolean(option.time.at))) : null,
      time: option?.time ?? null,
    };
  }
  fields.push(deadlineValue);

  fields.push({
    key: 'organizer',
    label: KEY_FIELD_LABELS.organizer ?? '主办机构',
    value: organizerLines[0]?.replace(/^.*?[：:]/, '').trim().slice(0, 200) ?? null,
    state: organizerLines.length > 0 ? 'explicit' : 'unmentioned',
    confidence: organizerLines.length > 0 ? 'medium' : 'low',
    evidence: organizerLines[0] ? evidenceOf(organizerLines[0], sourceBlocks, 'medium') : null,
  });

  fields.push({
    key: 'signupMethod',
    label: KEY_FIELD_LABELS.signupMethod ?? '报名方式',
    value: signupMethod,
    state: signupMethod === 'to_be_announced' ? 'unmentioned' : 'explicit',
    confidence: signupMethod === 'to_be_announced' ? 'low' : 'medium',
    evidence:
      signupMethod === 'to_be_announced'
        ? null
        : evidenceOf(email ?? signupUrl ?? signupMethod, sourceBlocks, 'medium'),
  });

  fields.push({
    key: 'signupUrl',
    label: '报名官网',
    value: signupUrl,
    state: signupUrl ? 'explicit' : signupMethod === 'web' ? 'unrecognized' : 'not_applicable',
    confidence: signupUrl ? 'medium' : 'low',
    evidence: signupUrl ? evidenceOf(signupUrl, sourceBlocks, 'medium') : null,
  });

  fields.push({
    key: 'startAt',
    label: '报名开始时间',
    value: startTime?.at ?? null,
    state: startTime ? (startTime.at ? 'explicit' : 'unrecognized') : 'unmentioned',
    confidence: startTime?.at ? 'high' : 'low',
    evidence: startTime ? evidenceOf(startTime.rawText ?? '', sourceBlocks, 'medium') : null,
    time: startTime,
  });

  fields.push({
    key: 'scheduleNote',
    label: '比赛时间',
    value: scheduleTime?.at ?? scheduleTime?.rawText ?? null,
    state: scheduleTime ? (scheduleTime.at ? 'explicit' : 'unrecognized') : 'unmentioned',
    confidence: scheduleTime?.at ? 'medium' : 'low',
    evidence: scheduleTime?.rawText ? evidenceOf(scheduleTime.rawText, sourceBlocks, 'medium') : null,
    time: scheduleTime,
  });

  fields.push({
    key: 'eligibility',
    label: KEY_FIELD_LABELS.eligibility ?? '参赛对象',
    value: eligibility,
    state: eligibility ? 'explicit' : 'unmentioned',
    confidence: eligibility ? 'medium' : 'low',
    evidence: eligibility ? evidenceOf(eligibility, sourceBlocks, 'medium') : null,
  });

  fields.push({
    key: 'fee',
    label: '报名费用',
    value: fee,
    state: fee ? 'explicit' : 'unmentioned',
    confidence: fee ? 'medium' : 'low',
    evidence: fee ? evidenceOf(fee, sourceBlocks, 'medium') : null,
  });

  const category = CATEGORY_RULES.find((rule) => rule.pattern.test(text))?.key ?? '未分类';
  fields.push({
    key: 'category',
    label: '学科分类',
    value: category,
    state: category === '未分类' ? 'unmentioned' : 'explicit',
    confidence: category === '未分类' ? 'low' : 'medium',
    evidence: evidenceOf(nameLine, sourceBlocks, 'low'),
  });

  const level = LEVEL_RULES.find((rule) => rule.pattern.test(`${competitionName} ${text.slice(0, 500)}`))?.key ?? null;
  fields.push({
    key: 'level',
    label: '竞赛级别',
    value: level,
    state: level ? 'explicit' : 'unrecognized',
    confidence: level ? 'medium' : 'low',
    evidence: level ? evidenceOf(nameLine, sourceBlocks, 'low') : null,
  });

  fields.push({
    key: 'description',
    label: '竞赛简介',
    value:
      lines.find((line) => line.length > 40 && !DEADLINE_ANCHOR.test(line))?.slice(0, 500) ??
      text.slice(0, 300),
    state: 'explicit',
    confidence: 'low',
    evidence: null,
  });

  const qualityInputs: QualityFieldInput[] = fields.map((field) => ({
    key: field.key,
    state: field.state,
    value: field.value,
  }));
  const missing = missingKeyFields(qualityInputs);

  const deadlineText = deadlineValue.value ? '报名截止时间已识别' : '报名截止时间待确认';
  const summary = `${competitionName || '未识别竞赛名称'}；${deadlineText}${
    signupUrl ? '；已识别报名官网' : ''
  }${injectionDetected ? '；内容包含疑似指令注入，仅作原文保留' : ''}`;

  return {
    fields: fields.map((field) => ({ ...field })),
    conflicts,
    missing,
    competitionName: competitionName || null,
    summary,
    textPreview: text.slice(0, 4000),
    truncatedFrom: text.length > 4000 ? `已截断，原文共 ${text.length} 字符` : null,
  };
}

export function buildPreviewField(
  field: ExtractedField,
): { key: string; label: string; value: unknown; state: FieldState; confidence: FieldConfidence } {
  return {
    key: field.key,
    label: field.label,
    value: field.value,
    state: field.state,
    confidence: field.confidence,
  };
}
