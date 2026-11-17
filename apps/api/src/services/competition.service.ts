import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  Bucket,
  CompetitionCard,
  CompetitionDetail,
  Completeness,
  Credibility,
  EvidenceView,
  FieldState,
  PublishStatus,
  RegistrationStatus,
  SearchQuery,
  SearchResult,
  CatalogConfirmInput,
  CatalogConfirmResult,
  DiscoveryLink,
  DiscoveryPage,
  DiscoveryTrack,
  TimePrecision,
} from '@competition/contracts';
import {
  CREDIBILITY_META,
  REGISTRATION_STATUS_META,
} from '@competition/contracts';
import { PrismaService } from '../platform/prisma.module';
import { AuditService } from '../platform/audit.module';
import { AppException } from '../platform/app-exception';
import { normalizeCompetitionName } from '../domain/normalize';
import {
  computeCompleteness,
  computeCredibility,
  missingKeyFields,
} from '../domain/quality';
import { deriveRegistrationStatus, endOfDayIfNeeded, parseDateTime } from '../domain/time';
import { assertTransition, canAutoPublish, nextStatus } from '../domain/publish-state-machine';
import type { ExtractionResult } from '../domain/rule-extractor';
import { ParseService } from './parse.service';
import { discoveryUrl } from '../domain/competition-discovery';
import { competitionDiscoveryScope } from '../domain/competition-discovery-access';

interface ConfirmPayload {
  publish?: boolean;
  resultVersionId?: string;
  name?: string | null;
  fields?: Record<string, string | null>;
  signupMethod?: string;
  signupUrl?: string | null;
  organizer?: string | null;
  category?: string | null;
  level?: string | null;
  deadline?: string | null;
  startAt?: string | null;
  reason?: string | null;
}

function readSavedTracks(value?: string | null): DiscoveryTrack[] {
  if (!value) return [];
  try {
    const tracks = JSON.parse(value);
    return Array.isArray(tracks) ? tracks : [];
  } catch {
    return [];
  }
}

const trackSummaryInclude = {
  stages: { select: { endAt: true, endPrecision: true, endTimezone: true, endRawText: true }, orderBy: { sortOrder: 'asc' } },
  fieldEvidence: { where: { fieldName: 'discoveryTracks' }, select: { fieldValue: true }, take: 1 },
  sources: { where: { type: { in: ['official_site', 'rss'] } }, select: { url: true } },
  reviews: { where: { action: 'approve' }, select: { id: true }, take: 1 },
} satisfies Prisma.CompetitionInclude;

function summarizeSavedTracks(
  row: { completeness: string; sources: Array<{ url: string | null }>; reviews: unknown[] },
  tracks: DiscoveryTrack[], now: Date,
) {
  const officialUrls = new Set(row.sources.map(source => source.url));
  // The homepage, guide and timetable from one organizer count as one source.
  const official = tracks.some(track => officialUrls.has(track.guide?.url ?? '') ||
    officialUrls.has(track.scheduleNotice?.url ?? ''));
  const quality = official ? computeCredibility({
    sourceTypes: ['official_site'], completeness: row.completeness as Completeness,
    distinctSourceCount: 1, reviewed: row.reviews.length > 0,
  }) : null;
  const windows = tracks.flatMap(track => track.registration ?? []).flatMap(window => {
    const startAt = parseDateTime(window.start);
    const endAt = parseDateTime(window.end);
    const deadline = endOfDayIfNeeded(endAt);
    if (!startAt.at || !deadline || Date.parse(startAt.at) > deadline.getTime()) return [];
    const status = Date.parse(startAt.at) > now.getTime() ? 'not_started' as const
      : deriveRegistrationStatus({ startAt, endAt }, now);
    return [{ endAt, deadline, status }];
  }).sort((left, right) => left.deadline.getTime() - right.deadline.getTime());
  const next = windows.find(window => window.status === 'open' || window.status === 'closing_soon')
    ?? windows.find(window => window.status === 'not_started') ?? windows.at(-1);
  return {
    quality,
    next,
    discoveryTrackCount: tracks.length,
    discoverySubjectCount: tracks.reduce((total, track) => total + (track.subjects?.length ?? 0), 0),
  };
}

@Injectable()
export class CompetitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly parseService: ParseService,
  ) {}

  async confirmFromParse(
    taskId: string,
    payload: ConfirmPayload,
    actorId: string,
  ): Promise<CompetitionDetail> {
    const result = await this.parseService.getResultVersion(taskId, actorId);
    if (!result) throw new AppException('PARSE_TASK_NOT_FOUND');
    if (payload.resultVersionId && payload.resultVersionId !== result.versionId) {
      throw new AppException('STATE_TRANSITION_INVALID', { reason: 'parse_result_changed' }, '解析结果已更新，请重新打开核对页。');
    }
    const extraction = result.stored.extraction;
    if (extraction.catalog) throw new AppException('VALIDATION_FAILED', null, '这是多竞赛目录，请使用目录批量核对入口。');

    const overrides = payload.fields ?? {};
    const valueOf = (key: string): string | null => {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        return overrides[key] ?? null;
      }
      const field = extraction.fields.find((item) => item.key === key);
      return field?.value ?? null;
    };

    const name = payload.name?.trim() || valueOf('name')?.trim() || extraction.competitionName;
    if (!name) throw new AppException('VALIDATION_FAILED', { field: 'name' }, '竞赛名称不能为空');

    const deadlineRaw = payload.deadline ?? valueOf('nearestDeadline');
    const startRaw = payload.startAt ?? valueOf('startAt');
    const parseConfirmedTime = (key: string, value: string | null) => {
      if (!value) return null;
      const field = extraction.fields.find((item) => item.key === key);
      return field?.value === value && field.time?.at ? field.time : parseDateTime(value);
    };
    const deadlineTime = parseConfirmedTime('nearestDeadline', deadlineRaw);
    const startTime = parseConfirmedTime('startAt', startRaw);
    const signupMethod = payload.signupMethod ?? valueOf('signupMethod') ?? 'to_be_announced';
    const signupUrl = payload.signupUrl ?? valueOf('signupUrl');
    const category = payload.category ?? valueOf('category');
    const level = payload.level ?? valueOf('level');
    const organizer = payload.organizer ?? valueOf('organizer');
    const eligibility = valueOf('eligibility');

    const qualityFields = [
      { key: 'name', state: 'explicit' as FieldState, value: name },
      { key: 'organizer', state: organizer ? ('explicit' as const) : ('unmentioned' as const), value: organizer },
      { key: 'signupMethod', state: signupMethod ? ('explicit' as const) : ('unmentioned' as const), value: signupMethod },
      {
        key: 'nearestDeadline',
        state: deadlineTime?.at ? ('explicit' as const) : ('to_confirm' as const),
        value: deadlineTime?.at ?? null,
      },
      {
        key: 'eligibility',
        state: eligibility ? ('explicit' as const) : ('unmentioned' as const),
        value: eligibility,
      },
    ];

    const hasConflict = extraction.conflicts.some((group) => group.requiresManual);
    const completeness = computeCompleteness(qualityFields, hasConflict);
    const credibility = computeCredibility({
      sourceTypes: ['uploaded_document'],
      completeness,
      distinctSourceCount: 1,
      reviewed: payload.publish === true,
    });
    const nearestDeadline = deadlineTime?.at ? endOfDayIfNeeded(deadlineTime) : null;
    const registrationStatus = deriveRegistrationStatus({
      startAt: startTime,
      endAt: deadlineTime,
    });

    const normalizedName = normalizeCompetitionName(name);
    const publish = payload.publish === true;

    const sites = {
      siteStatus: signupUrl ? 'unverified' : 'unverified',
    };

    const competition = await this.prisma.$transaction(async (tx) => {
      const reserved = await tx.competitionDocument.updateMany({
        where: {
          ownerId: actorId,
          status: 'stored',
          parseTasks: { some: { id: taskId }, none: { status: { in: ['queued', 'processing'] } } },
          resultVersions: { some: { id: result.versionId, adopted: true } },
        },
        data: { status: 'stored' },
      });
      if (!reserved.count) {
        throw new AppException('STATE_TRANSITION_INVALID', null, '文档已删除或解析结果已更新，请返回文档列表。');
      }

      const task = await tx.parseTask.findUniqueOrThrow({ where: { id: taskId } });
      const existing = await tx.competition.findFirst({
        where: {
          normalizedName, deletedAt: null,
          ...(publish ? {
            createdBy: actorId, dataOrigin: 'formal', demoFlag: false,
            OR: [{ publishStatus: 'draft' }, { documentLinks: { some: { documentId: task.documentId } } }],
          } : {}),
        },
        orderBy: { createdAt: 'desc' },
      });
      const publication = publish ? { publishStatus: 'published', publishedAt: existing?.publishedAt ?? new Date() } : {};
      const row = existing
        ? await tx.competition.update({
            where: { id: existing.id },
            data: {
              name,
              ...publication,
              completeness,
              credibility: credibility.level,
              credibilityScore: credibility.score,
              credibilityBasis: credibility.basis.join('；'),
              registrationStatus,
              nearestDeadline,
              signupMethod,
              signupUrl: signupUrl ?? null,
              siteStatus: sites.siteStatus,
              category: category ?? existing.category,
              level: level ?? existing.level,
              ...(eligibility || Object.prototype.hasOwnProperty.call(overrides, 'eligibility')
                ? { eligibilityJson: JSON.stringify({ ...JSON.parse(existing.eligibilityJson), eligibility: eligibility ?? '' }) }
                : {}),
              versionNo: { increment: 1 },
              updatedAt: new Date(),
            },
          })
        : await tx.competition.create({
            data: {
              name,
              ...publication,
              normalizedName,
              category: category ?? null,
              level: level ?? null,
              completeness,
              credibility: credibility.level,
              credibilityScore: credibility.score,
              credibilityBasis: credibility.basis.join('；'),
              registrationStatus,
              nearestDeadline,
              signupMethod,
              signupUrl: signupUrl ?? null,
              siteStatus: sites.siteStatus,
              eligibilityJson: JSON.stringify(eligibility ? { eligibility } : {}),
              createdBy: actorId,
            },
          });

      if (organizer?.trim()) {
        const organizerName = organizer.trim();
        const normalizedName = normalizeCompetitionName(organizerName);
        const host = await tx.organizer.upsert({
          where: { normalizedName },
          create: { name: organizerName, normalizedName },
          update: {},
        });
        await tx.competitionOrganizer.upsert({
          where: { competitionId_organizerId_role: { competitionId: row.id, organizerId: host.id, role: 'host' } },
          create: { competitionId: row.id, organizerId: host.id, role: 'host' },
          update: {},
        });
      }

      if (deadlineTime || startTime) {
        const stage = {
            competitionId: row.id,
            name: '报名阶段',
            stageType: 'official',
            startAt: startTime?.at ? new Date(startTime.at) : null,
            startPrecision: startTime?.precision ?? 'unknown',
            startTimezone: startTime?.timezone ?? 'Asia/Shanghai',
            startRawText: startTime?.rawText ?? null,
            endAt: deadlineTime?.at ? new Date(deadlineTime.at) : null,
            endPrecision: deadlineTime?.precision ?? 'unknown',
            endTimezone: deadlineTime?.timezone ?? 'Asia/Shanghai',
            endRawText: deadlineTime?.rawText ?? null,
            sortOrder: 0,
        };
        if (!await tx.registrationStage.findFirst({ where: stage })) {
          await tx.registrationStage.create({ data: stage });
        }
      }

      if (signupMethod !== 'to_be_announced' || signupUrl) {
        const entry = {
            competitionId: row.id,
            type: 'official',
            url: signupUrl ?? null,
            method: signupMethod,
            status: 'unverified',
            note: valueOf('signupMethod') === 'email' ? valueOf('signupUrl') : null,
        };
        if (!await tx.signupEntry.findFirst({ where: entry })) {
          await tx.signupEntry.create({ data: entry });
        }
      }

      await tx.documentCompetitionLink.upsert({
        where: {
          documentId_competitionId: {
            documentId: task.documentId,
            competitionId: row.id,
          },
        },
        create: { documentId: task.documentId, competitionId: row.id, locationNote: '由文档解析确认导入' },
        update: {},
      });
      await tx.sourceMaterial.updateMany({
        where: { documentId: task.documentId, competitionId: null },
        data: { competitionId: row.id },
      });
      if (!await tx.sourceMaterial.findFirst({ where: { documentId: task.documentId, competitionId: row.id } })) {
        await tx.sourceMaterial.create({ data: { competitionId: row.id, documentId: task.documentId,
          type: 'uploaded_document', title: result.stored.fileName, ownerId: actorId } });
      }

      await tx.fieldEvidence.deleteMany({
        where: { competitionId: row.id, parseVersionId: result.versionId },
      });
      for (const field of extraction.fields) {
        if (!field.evidence) continue;
        await tx.fieldEvidence.create({
          data: {
            competitionId: row.id,
            fieldName: field.key,
            fieldValue: valueOf(field.key) ?? '',
            sourceTitle: result.stored.fileName,
            snippet: field.evidence.snippet,
            locationJson: JSON.stringify(field.evidence.location ?? {}),
            extractMethod: field.evidence.extractMethod,
            confidence: field.evidence.confidence,
            fieldState: field.state,
            manuallyCorrected: Object.prototype.hasOwnProperty.call(overrides, field.key),
            parseVersionId: result.versionId,
          },
        });
      }

      await tx.competitionVersion.create({
        data: {
          competitionId: row.id,
          versionNo: row.versionNo,
          changesJson: JSON.stringify([
            { field: 'name', before: existing?.name ?? null, after: name },
          ]),
          actor: actorId,
          reason: payload.reason ?? '文档解析确认导入',
        },
      });

      await tx.outboxEvent.create({
        data: {
          eventType: 'competition.updated',
          objectType: 'competition',
          objectId: row.id,
          payloadJson: JSON.stringify({ completeness, credibilityScore: credibility.score }),
        },
      });

      if (publish && existing?.publishStatus !== 'published') await this.recordDocumentPublication(tx, row.id, actorId);
      return { row, existed: Boolean(existing) };
    });

    await this.audit.record({
      actorId,
      action: publish ? 'competition.confirm_and_publish_document' : competition.existed ? 'competition.update_from_parse' : 'competition.create_from_parse',
      objectType: 'competition',
      objectId: competition.row.id,
      detail: { taskId, source: result.stored.source, completeness },
    });

    return this.detail(competition.row.id, actorId);
  }

  async confirmCatalog(taskId: string, payload: CatalogConfirmInput, actorId: string): Promise<CatalogConfirmResult> {
    const result = await this.parseService.getResultVersion(taskId, actorId);
    if (!result) throw new AppException('PARSE_TASK_NOT_FOUND');
    if (!payload || payload.resultVersionId !== result.versionId) throw new AppException('STATE_TRANSITION_INVALID', null, '解析结果已更新，请重新打开核对页。');
    const catalog = result.stored.extraction.catalog;
    if (!catalog || !Array.isArray(payload.items) || !payload.items.length || payload.items.length > catalog.competitions.length) {
      throw new AppException('VALIDATION_FAILED', null, '请选择目录中需要录入的竞赛。');
    }
    const sequences = new Set<number>();
    const names = new Set<string>();
    const selected = payload.items.map(item => {
      const source = catalog.competitions.find(row => row.sequence === item?.sequence);
      const name = typeof item?.name === 'string' ? item.name.trim() : '';
      const normalizedName = normalizeCompetitionName(name);
      if (!source || sequences.has(item.sequence) || !name || name.length > 500 || names.has(normalizedName)
        || !['A类', 'B类', 'C类'].includes(item.schoolRecognitionLevel)) {
        throw new AppException('VALIDATION_FAILED', null, '目录序号、名称或 A/B/C 认定等级无效，名称和序号不可重复。');
      }
      sequences.add(item.sequence); names.add(normalizedName);
      return { source, name, normalizedName, grade: item.schoolRecognitionLevel };
    });
    const items = await this.prisma.$transaction(async tx => {
      const reserved = await tx.competitionDocument.updateMany({ where: { ownerId: actorId, status: 'stored',
        parseTasks: { some: { id: taskId }, none: { status: { in: ['queued', 'processing'] } } },
        resultVersions: { some: { id: result.versionId, adopted: true } } }, data: { status: 'stored' } });
      if (!reserved.count) throw new AppException('STATE_TRANSITION_INVALID', null, '文档正在识别、已删除或结果已更新，请重新打开核对页。');
      const task = await tx.parseTask.findUniqueOrThrow({ where: { id: taskId } });
      const saved: CatalogConfirmResult['items'] = [];
      for (const item of selected) {
        const linked = payload.publish === true && await tx.documentCompetitionLink.findFirst({
          where: { documentId: task.documentId, locationNote: `目录序号 ${item.source.sequence}`,
            competition: { createdBy: actorId, deletedAt: null, dataOrigin: 'formal', demoFlag: false } },
          include: { competition: true },
        });
        const existing = linked ? linked.competition : await tx.competition.findFirst({ where: { normalizedName: item.normalizedName,
          createdBy: actorId, publishStatus: 'draft', deletedAt: null, dataOrigin: 'formal', demoFlag: false } });
        const alreadyImported = existing && await tx.fieldEvidence.findFirst({ where: { competitionId: existing.id,
          parseVersionId: result.versionId, fieldName: 'schoolRecognitionLevel', fieldValue: item.grade } });
        if (alreadyImported && existing.schoolRecognitionLevel === item.grade && existing.name === item.name
          && (payload.publish !== true || existing.publishStatus === 'published')) {
          saved.push({ id: existing.id, name: existing.name, schoolRecognitionLevel: existing.schoolRecognitionLevel }); continue;
        }
        const publish = payload.publish === true;
        const publication = publish ? { publishStatus: 'published', publishedAt: existing?.publishedAt ?? new Date() } : {};
        const confirmedQuality = publish && existing?.publishStatus !== 'published'
          ? { credibility: 'medium', credibilityScore: Math.max(existing?.credibilityScore ?? 0, 60),
              credibilityBasis: '人工核对学校认定目录，报名信息以赛事公告为准' } : {};
        const row = existing ? await tx.competition.update({ where: { id: existing.id }, data: {
          name: item.name, normalizedName: item.normalizedName, schoolRecognitionLevel: item.grade,
          ...publication, ...confirmedQuality, versionNo: { increment: 1 } } })
          : await tx.competition.create({ data: { name: item.name, normalizedName: item.normalizedName,
            schoolRecognitionLevel: item.grade, createdBy: actorId, publishStatus: 'draft', completeness: 'partial',
            credibility: 'low', credibilityScore: 40, credibilityBasis: '上传目录；原文仅载明竞赛名称及学校认定等级，报名信息待补充',
            ...publication, ...confirmedQuality } });
        await tx.documentCompetitionLink.upsert({ where: { documentId_competitionId: { documentId: task.documentId, competitionId: row.id } },
          create: { documentId: task.documentId, competitionId: row.id, locationNote: `目录序号 ${item.source.sequence}` }, update: {} });
        if (!await tx.sourceMaterial.findFirst({ where: { documentId: task.documentId, competitionId: row.id } })) {
          await tx.sourceMaterial.create({ data: { competitionId: row.id, documentId: task.documentId,
            type: 'uploaded_document', title: result.stored.fileName, ownerId: actorId } });
        }
        for (const [fieldName, fieldValue, corrected] of [
          ['name', item.name, item.name !== item.source.name],
          ['schoolRecognitionLevel', item.grade, item.grade !== item.source.schoolRecognitionLevel],
          ['schoolRecognitionScope', catalog.recognitionScope, false],
        ] as const) {
          await tx.fieldEvidence.deleteMany({ where: { competitionId: row.id, fieldName, sourceTitle: result.stored.fileName } });
          await tx.fieldEvidence.create({ data: { competitionId: row.id, fieldName, fieldValue,
            sourceTitle: result.stored.fileName, snippet: fieldName === 'schoolRecognitionScope' ? catalog.title : item.source.evidence.snippet,
            locationJson: JSON.stringify(item.source.evidence.location ?? {}), extractMethod: item.source.evidence.extractMethod,
            confidence: 'high', fieldState: 'explicit', manuallyCorrected: corrected, parseVersionId: result.versionId } });
        }
        await tx.competitionVersion.create({ data: { competitionId: row.id, versionNo: row.versionNo, actor: actorId,
          reason: '竞赛目录核对录入', changesJson: JSON.stringify([{ field: 'schoolRecognitionLevel', before: existing?.schoolRecognitionLevel ?? null, after: item.grade }]) } });
        await tx.outboxEvent.create({ data: { eventType: 'competition.updated', objectType: 'competition', objectId: row.id,
          payloadJson: JSON.stringify({ source: 'document_catalog', sequence: item.source.sequence }) } });
        if (publish && existing?.publishStatus !== 'published') await this.recordDocumentPublication(tx, row.id, actorId);
        saved.push({ id: row.id, name: row.name, schoolRecognitionLevel: row.schoolRecognitionLevel });
      }
      return saved;
    }, { timeout: 30000 });
    await this.audit.record({ actorId, action: payload.publish === true ? 'competition.confirm_and_publish_catalog' : 'competition.import_catalog', objectType: 'parse_task', objectId: taskId,
      detail: { count: items.length, resultVersionId: result.versionId } });
    return { count: items.length, items };
  }

  private async recordDocumentPublication(tx: Prisma.TransactionClient, competitionId: string, actorId: string): Promise<void> {
    await tx.reviewRecord.create({
      data: { competitionId, action: 'approve', reviewer: actorId, comment: '文档核对确认后直接发布' },
    });
    await tx.outboxEvent.create({
      data: { eventType: 'competition.published', objectType: 'competition', objectId: competitionId,
        payloadJson: JSON.stringify({ auto: false, source: 'document_confirmation' }) },
    });
  }

  async saveDiscoveryFields(
    competitionId: string, expectedVersion: number, page: DiscoveryPage, actorId: string, roles: readonly string[] = [],
  ): Promise<CompetitionDetail> {
    const sourceUrl = discoveryUrl(page.url);
    const values = new Map(page.fields.map(field => [field.key, field.value]));
    const signupValue = values.get('signupUrl');
    const signupUrl = signupValue ? discoveryUrl(signupValue) : null;
    const deadlineValue = values.get('nearestDeadline');
    const deadline = deadlineValue ? parseDateTime(deadlineValue) : null;
    const nearestDeadline = deadline ? endOfDayIfNeeded(deadline) : null;
    if (!sourceUrl || (signupValue && !signupUrl) || (deadlineValue && !nearestDeadline)) {
      throw new AppException('VALIDATION_FAILED', null, '所选字段包含无法识别的报名地址或日期。');
    }

    await this.prisma.$transaction(async tx => {
      const reserved = await tx.competition.updateMany({
        where: { id: competitionId, versionNo: expectedVersion, ...competitionDiscoveryScope(actorId, roles) },
        data: { versionNo: { increment: 1 } },
      });
      if (!reserved.count) {
        throw new AppException('STATE_TRANSITION_INVALID', null, '竞赛已更新，请重新采集后再保存。');
      }

      const row = await tx.competition.findUniqueOrThrow({
        where: { id: competitionId },
        include: { organizers: { where: { role: 'host' }, include: { organizer: true } } },
      });
      const changes: Array<{ field: string; before: string | null; after: string }> = [];
      const data: Prisma.CompetitionUpdateInput = {};
      const organizer = values.get('organizer');
      if (organizer) {
        const normalizedName = normalizeCompetitionName(organizer);
        const host = await tx.organizer.upsert({
          where: { normalizedName }, create: { name: organizer, normalizedName }, update: { name: organizer },
        });
        await tx.competitionOrganizer.deleteMany({ where: { competitionId, role: 'host', organizerId: { not: host.id } } });
        await tx.competitionOrganizer.upsert({
          where: { competitionId_organizerId_role: { competitionId, organizerId: host.id, role: 'host' } },
          create: { competitionId, organizerId: host.id, role: 'host' }, update: {},
        });
        changes.push({ field: 'organizer', before: row.organizers.map(item => item.organizer.name).join('、') || null, after: organizer });
      }
      const eligibility = values.get('eligibility');
      if (eligibility) {
        const previous = JSON.parse(row.eligibilityJson) as Record<string, string>;
        data.eligibilityJson = JSON.stringify({ ...previous, eligibility });
        changes.push({ field: 'eligibility', before: previous.eligibility ?? null, after: eligibility });
      }
      const content = values.get('competitionContent');
      if (content) {
        data.description = content;
        changes.push({ field: 'description', before: row.description, after: content });
      }
      const schedule = values.get('scheduleNote');
      if (schedule) {
        data.scheduleNote = schedule;
        changes.push({ field: 'schedule', before: row.scheduleNote, after: schedule });
      }
      if (signupUrl) {
        data.signupUrl = signupUrl;
        data.signupMethod = 'web';
        if (signupUrl !== row.signupUrl) data.siteStatus = 'unverified';
        const entry = await tx.signupEntry.findFirst({
          where: { competitionId, type: 'official', method: 'web', url: signupUrl },
        });
        if (!entry) {
          const previousEntry = row.signupUrl && await tx.signupEntry.findFirst({
            where: { competitionId, type: 'official', method: 'web', url: row.signupUrl },
          });
          if (previousEntry) {
            await tx.signupEntry.update({ where: { id: previousEntry.id }, data: {
              url: signupUrl, status: 'unverified', lastCheckedAt: null, trustedDomain: false, internalReason: null,
            } });
          } else {
            await tx.signupEntry.create({ data: { competitionId, type: 'official', method: 'web', url: signupUrl } });
          }
        }
        changes.push({ field: 'signupUrl', before: row.signupUrl, after: signupUrl });
      }
      if (deadline?.at && nearestDeadline) {
        data.nearestDeadline = nearestDeadline;
        const previousStage = await tx.registrationStage.findFirst({
          where: { competitionId, stageType: 'official' }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        });
        data.registrationStatus = deriveRegistrationStatus({
          endAt: deadline,
          startAt: previousStage?.startAt ? {
            at: previousStage.startAt.toISOString(), precision: 'second', timezone: previousStage.startTimezone,
          } : null,
        });
        const timing = { endAt: new Date(deadline.at), endPrecision: deadline.precision,
          endTimezone: deadline.timezone, endRawText: deadline.rawText };
        if (previousStage) await tx.registrationStage.update({ where: { id: previousStage.id }, data: timing });
        else await tx.registrationStage.create({ data: { competitionId, name: '报名阶段', ...timing } });
        changes.push({ field: 'nearestDeadline', before: row.nearestDeadline?.toISOString() ?? null, after: nearestDeadline.toISOString() });
      }

      if (Object.keys(data).length) await tx.competition.update({ where: { id: competitionId }, data });
      const source = await tx.sourceMaterial.findFirst({ where: { competitionId, url: sourceUrl }, select: { id: true } })
        ?? await tx.sourceMaterial.create({
          data: { competitionId, type: page.tracks?.length ? 'official_site' : 'other', title: page.title, url: sourceUrl, ownerId: actorId },
        });
      if (page.tracks?.length) {
        const previous = await tx.fieldEvidence.findFirst({
          where: { competitionId, fieldName: 'discoveryTracks' },
          orderBy: { createdAt: 'desc' },
        });
        const edition = page.tracks[0].edition;
        const savedTracks = new Map(readSavedTracks(previous?.fieldValue).filter(track => track.edition === edition)
          .map(track => [track.url, track]));
        const links = new Map<string, DiscoveryLink>();
        for (const track of page.tracks) {
          const existing = savedTracks.get(track.url);
          const schedule = track.schedule?.some(row => row.source)
            ? [...new Map([...(existing?.schedule ?? []), ...track.schedule].map(row =>
              [JSON.stringify([row.subject, row.label]), row])).values()]
            : track.schedule ?? existing?.schedule;
          const confirmed = {
            ...track,
            subjects: track.subjects ?? existing?.subjects,
            registration: track.registration ?? existing?.registration,
            schedule,
            guide: track.guide ?? existing?.guide,
            scheduleNotice: track.scheduleNotice ?? existing?.scheduleNotice,
          };
          savedTracks.set(track.url, confirmed);
          for (const link of [track.guide, track.scheduleNotice, ...(track.schedule ?? []).map(row => row.source)]) {
            if (link) links.set(link.url, link);
          }
        }
        for (const link of links.values()) {
          const existing = await tx.sourceMaterial.findFirst({ where: { competitionId, url: link.url }, select: { id: true } });
          if (!existing) {
            await tx.sourceMaterial.create({ data: { competitionId, ...link, type: 'official_site', ownerId: actorId } });
          }
        }
        const fieldValue = JSON.stringify([...savedTracks.values()]);
        await tx.fieldEvidence.deleteMany({ where: { competitionId, fieldName: 'discoveryTracks' } });
        await tx.fieldEvidence.create({
          data: { competitionId, fieldName: 'discoveryTracks', fieldValue, sourceId: source.id, sourceTitle: page.title,
            locationJson: JSON.stringify({ kind: 'web', url: sourceUrl, sources: [...links.values()] }), extractMethod: 'rule' },
        });
        changes.push({ field: 'discoveryTracks', before: previous?.fieldValue ?? null, after: fieldValue });
      }
      for (const field of page.fields) {
        const key = field.key === 'scheduleNote' ? 'schedule' : field.key === 'competitionContent' ? 'description' : field.key;
        await tx.fieldEvidence.deleteMany({ where: { competitionId, fieldName: key, sourceId: source.id } });
        await tx.fieldEvidence.create({
          data: { competitionId, fieldName: key, fieldValue: field.value, sourceId: source.id,
            sourceTitle: page.title, snippet: field.quote, locationJson: JSON.stringify({ kind: 'web', url: sourceUrl }),
            extractMethod: 'rule', confidence: 'medium' },
        });
      }
      await tx.competitionVersion.create({
        data: { competitionId, versionNo: row.versionNo, actor: actorId,
          reason: '确认官网采集资料', changesJson: JSON.stringify(changes) },
      });
      await tx.outboxEvent.create({
        data: { eventType: 'competition.updated', objectType: 'competition', objectId: competitionId,
          payloadJson: JSON.stringify({ source: 'web_discovery', fields: changes.map(change => change.field) }) },
      });
    });
    await this.audit.record({ actorId, action: 'competition.save_discovery_fields', objectType: 'competition',
      objectId: competitionId, detail: { fields: page.fields.map(field => field.key), trackCount: page.tracks?.length ?? 0 } });
    return this.detail(competitionId, actorId);
  }

  async detail(competitionId: string, actorId: string): Promise<CompetitionDetail> {
    const row = await this.prisma.competition.findFirst({
      where: { id: competitionId, deletedAt: null },
      include: {
        series: true,
        edition: true,
        track: true,
        stages: { orderBy: { sortOrder: 'asc' } },
        entries: true,
        sources: true,
        reviews: trackSummaryInclude.reviews,
        changeEvents: { orderBy: { detectedAt: 'desc' }, take: 20 },
        organizers: { include: { organizer: true } },
        children: {
          include: {
            series: true,
            edition: true,
            track: true,
            stages: trackSummaryInclude.stages,
            organizers: { include: { organizer: true } },
            children: { select: { id: true } },
          },
        },
      },
    });
    if (!row) throw new AppException('RESOURCE_NOT_FOUND');
    if (row.publishStatus === 'draft' && row.createdBy && row.createdBy !== actorId) {
      throw new AppException('RESOURCE_NOT_FOUND');
    }

    const evidence = await this.prisma.fieldEvidence.findMany({
      where: { competitionId },
      orderBy: { fieldName: 'asc' },
    });
    const favorite = await this.prisma.favorite.findFirst({
      where: { userId: actorId, competitionId },
    });

    const fieldStates: Record<string, FieldState> = {};
    const trackEvidence = evidence.find(item => item.fieldName === 'discoveryTracks');
    const discoveryTracks = readSavedTracks(trackEvidence?.fieldValue);
    const summary = summarizeSavedTracks({
      ...row, sources: row.sources.filter(source => source.type === 'official_site' || source.type === 'rss'),
    }, discoveryTracks, new Date());
    const ordinaryEvidence = evidence.filter(item => item.fieldName !== 'discoveryTracks');
    for (const item of ordinaryEvidence) {
      fieldStates[item.fieldName] = (item.fieldState as FieldState) ?? 'explicit';
    }

    return {
      ...this.toCard(row, favorite !== null, row.children.length, summary),
      discoveryTracks,
      credibilityBasis: summary.quality?.basis.join('；') ?? row.credibilityBasis,
      schoolRecognitionScope: evidence.filter(item => item.fieldName === 'schoolRecognitionScope')
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0]?.fieldValue ?? null,
      description: row.description,
      eligibility: row.eligibilityJson ? (JSON.parse(row.eligibilityJson) as Record<string, string>) : {},
      schedule: row.scheduleNote,
      awards: row.awards,
      stages: row.stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        stageType: stage.stageType,
        startAt: stage.startAt
          ? {
              at: stage.startAt.toISOString(),
              precision: stage.startPrecision as 'day' | 'second' | 'unknown',
              timezone: stage.startTimezone,
              rawText: stage.startRawText,
            }
          : null,
        endAt: stage.endAt
          ? {
              at: stage.endAt.toISOString(),
              precision: stage.endPrecision as 'day' | 'second' | 'unknown',
              timezone: stage.endTimezone,
              rawText: stage.endRawText,
            }
          : null,
        status:
          stage.id === row.stages[0]?.id
            ? (row.registrationStatus as RegistrationStatus)
            : deriveRegistrationStatus({
                startAt: stage.startAt
                  ? {
                      at: stage.startAt.toISOString(),
                      precision: stage.startPrecision as 'day' | 'second' | 'unknown',
                      timezone: stage.startTimezone,
                      rawText: stage.startRawText,
                    }
                  : null,
                endAt: stage.endAt
                  ? {
                      at: stage.endAt.toISOString(),
                      precision: stage.endPrecision as 'day' | 'second' | 'unknown',
                      timezone: stage.endTimezone,
                      rawText: stage.endRawText,
                    }
                  : null,
              }),
        applicableTo: stage.applicableTo,
      })),
      entries: row.entries.map((entry) => ({
        id: entry.id,
        type: entry.type as CompetitionDetail['entries'][number]['type'],
        url: entry.url,
        method: entry.method as CompetitionDetail['entries'][number]['method'],
        status: entry.status as CompetitionDetail['entries'][number]['status'],
        note: entry.note,
        contact: entry.contact,
        lastCheckedAt: entry.lastCheckedAt?.toISOString() ?? null,
        trustedDomain: entry.trustedDomain,
      })),
      sources: row.sources.map((source) => ({
        id: source.id,
        type: source.type as CompetitionDetail['sources'][number]['type'],
        title: source.title,
        url: source.url,
        documentId: source.documentId,
        capturedAt: source.capturedAt.toISOString(),
      })),
      fieldStates,
      evidenceFields: ordinaryEvidence.map((item) => item.fieldName),
      versionNo: row.versionNo,
      updatedAt: row.updatedAt.toISOString(),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      changeEvents: row.changeEvents.map((event) => ({
        id: event.id,
        type: event.type as CompetitionDetail['changeEvents'][number]['type'],
        field: event.field,
        before: event.beforeValue,
        after: event.afterValue,
        detectedAt: event.detectedAt.toISOString(),
      })),
      parentId: row.parentId,
      children: row.children.map((child) => this.toCard(child, false, child.children.length)),
    };
  }

  async search(query: SearchQuery, actorId: string, roles: readonly string[] = []): Promise<SearchResult> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = query.cursor ? Number(Buffer.from(query.cursor, 'base64').toString('utf8')) || 0 : 0;

    const statusFilter: Prisma.CompetitionWhereInput = {
      ...(query.registrationStatus?.length ? { registrationStatus: { in: query.registrationStatus } } : {}),
      ...(query.credibility?.length ? { credibility: { in: query.credibility } } : {}),
      ...(query.deadlineFrom || query.deadlineTo ? { nearestDeadline: {
        ...(query.deadlineFrom ? { gte: new Date(query.deadlineFrom) } : {}),
        ...(query.deadlineTo ? { lte: new Date(query.deadlineTo) } : {}),
      } } : {}),
    };
    const where: Prisma.CompetitionWhereInput = {
      deletedAt: null,
      dataOrigin: 'formal',
      demoFlag: false,
      parentId: null,
      ...(query.documentId ? { documentLinks: { some: { document: { id: query.documentId, ownerId: actorId, status: 'stored' } } } } : {}),
      ...(query.categories?.length ? { category: { in: query.categories } } : {}),
      ...(query.levels?.length ? { level: { in: query.levels } } : {}),
      AND: [
        query.scope === 'workspace' ? competitionDiscoveryScope(actorId, roles) : { publishStatus: 'published' },
        ...(Object.keys(statusFilter).length ? [{ OR: [
          statusFilter, { fieldEvidence: { some: { fieldName: 'discoveryTracks' } } },
        ] }] : []),
      ],
      ...(query.keyword
        ? {
            OR: [
              { name: { contains: query.keyword } },
              { description: { contains: query.keyword } },
              { category: { contains: query.keyword } },
            ],
          }
        : {}),
    };

    if (query.scope !== undefined && query.scope !== 'published' && query.scope !== 'workspace') {
      throw new AppException('QUERY_CONDITION_INVALID', { field: 'scope' });
    }
    for (const field of ['deadlineFrom', 'deadlineTo'] as const) {
      const value = query[field];
      if (value && Number.isNaN(Date.parse(value))) throw new AppException('QUERY_CONDITION_INVALID', { field });
    }
    if (query.limit !== undefined && (query.limit < 1 || query.limit > 100)) {
      throw new AppException('QUERY_CONDITION_INVALID', { field: 'limit' });
    }

    const rows = await this.prisma.competition.findMany({
      where,
      include: {
        ...trackSummaryInclude,
        series: true,
        edition: true,
        track: true,
        organizers: { include: { organizer: true } },
        children: { select: { id: true } },
      },
      take: 500,
    });

    const favorites = await this.prisma.favorite.findMany({
      where: { userId: actorId, competitionId: { in: rows.map((row) => row.id) } },
    });
    const favoriteIds = new Set(favorites.map((item) => item.competitionId));

    const now = new Date();
    const cards = rows.map(row => this.toCard(row, favoriteIds.has(row.id), row.children.length,
      summarizeSavedTracks(row, readSavedTracks(row.fieldEvidence[0]?.fieldValue), now))).filter(card => {
      if (query.registrationStatus?.length && !query.registrationStatus.includes(card.registrationStatus)) return false;
      if (query.credibility?.length && !query.credibility.includes(card.credibility)) return false;
      const at = card.nearestDeadline?.at;
      return (!query.deadlineFrom || Boolean(at && Date.parse(at) >= Date.parse(query.deadlineFrom))) &&
        (!query.deadlineTo || Boolean(at && Date.parse(at) <= Date.parse(query.deadlineTo)));
    });
    const filtered = cards.filter((card) => {
      if (!query.includeLowCredibility && (card.credibility === 'low' || card.siteStatus === 'suspected_invalid')) {
        return false;
      }
      if (!query.includeExpired && card.registrationStatus === 'closed') {
        return false;
      }
      if (query.eligibility?.degree && card.tags.length > 0) {
        const matched = card.tags.some((tag) => tag.includes(query.eligibility?.degree ?? ''));
        if (!matched) return false;
      }
      return true;
    });

    const sorted = this.sortCards(filtered, query.sort ?? 'default');
    const items = sorted.slice(offset, offset + limit);
    const total = sorted.length;
    const excluded = this.buildExcluded(cards, filtered);

    return {
      items,
      page: {
        total,
        limit,
        nextCursor: offset + limit < total ? Buffer.from(String(offset + limit)).toString('base64') : null,
        hasMore: offset + limit < total,
      },
      facets: {
        category: this.bucket(cards, (card) => card.category ?? '未分类'),
        level: this.bucket(cards, (card) => card.level ?? '未分级'),
        registrationStatus: this.bucket(
          cards,
          (card) => card.registrationStatus,
          (key) => REGISTRATION_STATUS_META[key as keyof typeof REGISTRATION_STATUS_META]?.label ?? key,
        ),
        credibility: this.bucket(
          cards,
          (card) => card.credibility,
          (key) => CREDIBILITY_META[key as keyof typeof CREDIBILITY_META]?.label ?? key,
        ),
      },
      excluded,
      relaxSuggestions: total === 0 ? ['尝试减少筛选条件', '扩大截止时间范围', '搜索更通用的关键词'] : [],
      asOf: new Date().toISOString(),
    };
  }

  async submitReview(competitionId: string, actorId: string, comment?: string | null): Promise<{ status: PublishStatus }> {
    const row = await this.prisma.competition.findFirst({ where: { id: competitionId, deletedAt: null } });
    if (!row || (row.publishStatus === 'draft' && row.createdBy && row.createdBy !== actorId)) {
      throw new AppException('RESOURCE_NOT_FOUND');
    }
    const next = nextStatus(row.publishStatus as PublishStatus, 'submit');
    assertTransition(row.publishStatus as PublishStatus, next);

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.competition.updateMany({
        where: { id: competitionId, publishStatus: row.publishStatus, versionNo: row.versionNo, deletedAt: null },
        data: { publishStatus: next, versionNo: { increment: 1 } },
      });
      if (!updated.count) throw new AppException('STATE_TRANSITION_INVALID');
      await tx.reviewRecord.create({
        data: { competitionId, action: 'submit', reviewer: actorId, comment: comment ?? '提交审核' },
      });
      await tx.outboxEvent.create({
        data: {
          eventType: 'competition.submitted',
          objectType: 'competition',
          objectId: competitionId,
          payloadJson: '{}',
        },
      });
    });

    await this.audit.record({
      actorId,
      action: 'competition.submit_review',
      objectType: 'competition',
      objectId: competitionId,
    });
    return { status: next };
  }

  async publish(competitionId: string, actorId: string, comment?: string | null): Promise<{ status: PublishStatus; autoRule?: string }> {
    const row = await this.prisma.competition.findFirst({
      where: { id: competitionId, deletedAt: null },
      include: { sources: true, stages: true },
    });
    if (!row) throw new AppException('RESOURCE_NOT_FOUND');
    if (row.publishStatus !== 'pending_review') {
      throw new AppException('STATE_TRANSITION_INVALID', { from: row.publishStatus, to: 'published' });
    }

    const auto = canAutoPublish({
      officialSource: row.sources.every((source) => source.type === 'official_site' || source.type === 'rss'),
      completeness: row.completeness,
      hasConflict: row.completeness === 'conflict',
      hasDuplicateDispute: false,
      signupMethod: row.signupMethod,
      parseFailed: false,
    });

    const next = nextStatus(row.publishStatus as PublishStatus, 'publish');
    const now = new Date();
    const credibility = computeCredibility({
      sourceTypes: row.sources.map(source => source.type),
      completeness: row.completeness as Completeness,
      distinctSourceCount: 1,
      reviewed: true,
    });

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.competition.updateMany({
        where: { id: competitionId, publishStatus: row.publishStatus, versionNo: row.versionNo, deletedAt: null },
        data: {
          publishStatus: next,
          publishedAt: now,
          versionNo: { increment: 1 },
          credibility: credibility.level,
          credibilityScore: credibility.score,
          credibilityBasis: credibility.basis.join('；'),
        },
      });
      if (!updated.count) throw new AppException('STATE_TRANSITION_INVALID');
      await tx.reviewRecord.create({
        data: {
          competitionId,
          action: 'approve',
          reviewer: actorId,
          comment: comment ?? (auto.allowed ? `自动审核通过：${auto.reason}` : '人工审核通过'),
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventType: 'competition.published',
          objectType: 'competition',
          objectId: competitionId,
          payloadJson: JSON.stringify({ auto: auto.allowed }),
        },
      });
    });

    await this.audit.record({
      actorId,
      action: 'competition.publish',
      objectType: 'competition',
      objectId: competitionId,
      detail: { autoRule: auto.reason },
    });

    return { status: next, autoRule: auto.reason };
  }

  async reject(competitionId: string, actorId: string, comment: string): Promise<{ status: PublishStatus }> {
    if (!comment?.trim()) throw new AppException('REVIEW_COMMENT_REQUIRED');
    const row = await this.prisma.competition.findFirst({ where: { id: competitionId, deletedAt: null } });
    if (!row) throw new AppException('RESOURCE_NOT_FOUND');
    if (row.publishStatus !== 'pending_review') {
      throw new AppException('STATE_TRANSITION_INVALID', { from: row.publishStatus, to: 'draft' });
    }
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.competition.updateMany({
        where: { id: competitionId, publishStatus: row.publishStatus, versionNo: row.versionNo, deletedAt: null },
        data: { publishStatus: 'draft', versionNo: { increment: 1 } },
      });
      if (!updated.count) throw new AppException('STATE_TRANSITION_INVALID');
      await tx.reviewRecord.create({
        data: { competitionId, action: 'reject', reviewer: actorId, comment },
      });
    });
    await this.audit.record({
      actorId,
      action: 'competition.reject',
      objectType: 'competition',
      objectId: competitionId,
      detail: { comment },
    });
    return { status: 'draft' };
  }

  async unpublish(competitionId: string, actorId: string, comment: string): Promise<{ status: PublishStatus }> {
    if (!comment?.trim()) throw new AppException('REVIEW_COMMENT_REQUIRED');
    const row = await this.prisma.competition.findFirst({ where: { id: competitionId, deletedAt: null } });
    if (!row) throw new AppException('RESOURCE_NOT_FOUND');
    const next = nextStatus(row.publishStatus as PublishStatus, 'unpublish');
    await this.prisma.$transaction(async (tx) => {
      await tx.competition.update({ where: { id: competitionId }, data: { publishStatus: next } });
      await tx.reviewRecord.create({
        data: { competitionId, action: 'unpublish', reviewer: actorId, comment },
      });
    });
    await this.audit.record({
      actorId,
      action: 'competition.unpublish',
      objectType: 'competition',
      objectId: competitionId,
    });
    return { status: next };
  }

  async restore(competitionId: string, actorId: string): Promise<{ status: PublishStatus }> {
    const row = await this.prisma.competition.findFirst({ where: { id: competitionId, deletedAt: null } });
    if (!row) throw new AppException('RESOURCE_NOT_FOUND');
    const next = nextStatus(row.publishStatus as PublishStatus, 'restore');
    await this.prisma.competition.update({ where: { id: competitionId }, data: { publishStatus: next } });
    await this.audit.record({
      actorId,
      action: 'competition.restore_to_review',
      objectType: 'competition',
      objectId: competitionId,
    });
    return { status: next };
  }

  async reviewQueue(): Promise<unknown[]> {
    const rows = await this.prisma.competition.findMany({
      where: { publishStatus: 'pending_review', deletedAt: null },
      orderBy: { updatedAt: 'asc' },
      include: { reviews: {
        orderBy: { createdAt: 'desc' }, take: 1, select: { action: true, createdAt: true },
      } },
      take: 100,
    });
    return rows.map((row) => {
      const missing = row.completeness === 'complete' ? [] : ['存在缺失或冲突字段'];
      const latestReview = row.reviews[0];
      const submittedAt = latestReview?.action === 'submit' ? latestReview.createdAt : row.updatedAt;
      const waitingHours = Math.max(
        0,
        Math.round((Date.now() - submittedAt.getTime()) / (60 * 60 * 1000)),
      );
      const closingBoost = row.registrationStatus === 'closing_soon' ? 30 : 0;
      const conflictBoost = row.completeness === 'conflict' ? 20 : 0;
      const priority = Math.min(100, 50 + closingBoost + conflictBoost);
      return {
        competitionId: row.id,
        name: row.name,
        priority,
        priorityReason:
          closingBoost > 0 ? '临近截止，优先处理' : conflictBoost > 0 ? '存在冲突信息' : '常规审核',
        completeness: row.completeness,
        conflictCount: row.completeness === 'conflict' ? 1 : 0,
        missingFields: missing,
        submittedAt: submittedAt.toISOString(),
        waitingHours,
      };
    });
  }

  async versions(competitionId: string): Promise<unknown[]> {
    const rows = await this.prisma.competitionVersion.findMany({
      where: { competitionId },
      orderBy: { versionNo: 'desc' },
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      versionNo: row.versionNo,
      changes: JSON.parse(row.changesJson),
      actor: row.actor,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async favorite(competitionId: string, actorId: string, on: boolean): Promise<{ favorited: boolean }> {
    const exists = await this.prisma.competition.findFirst({ where: { id: competitionId, deletedAt: null } });
    if (!exists) throw new AppException('RESOURCE_NOT_FOUND');
    if (on) {
      await this.prisma.favorite.upsert({
        where: { userId_competitionId: { userId: actorId, competitionId } },
        create: { userId: actorId, competitionId },
        update: {},
      });
    } else {
      await this.prisma.favorite.deleteMany({ where: { userId: actorId, competitionId } });
    }
    return { favorited: on };
  }

  async listMyDrafts(actorId: string, documentId?: string, page = 1): Promise<{
    items: CompetitionCard[];
    total: number;
    pageSize: number;
  }> {
    const pageSize = 100;
    if (!Number.isSafeInteger(page) || page < 1 || page > Math.floor(Number.MAX_SAFE_INTEGER / pageSize)) {
      throw new AppException('QUERY_CONDITION_INVALID', { field: 'page' });
    }

    const where = {
      createdBy: actorId,
      publishStatus: 'draft',
      deletedAt: null,
      ...(documentId ? {
        documentLinks: { some: { document: { id: documentId, ownerId: actorId, status: 'stored' } } },
      } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.competition.count({ where }),
      this.prisma.competition.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { stages: trackSummaryInclude.stages, organizers: { include: { organizer: true } } },
      }),
    ]);
    return { items: rows.map((row) => this.toCard(row, false)), total, pageSize };
  }

  async listPublished(limit = 50): Promise<CompetitionCard[]> {
    const rows = await this.prisma.competition.findMany({
      where: { publishStatus: 'published', dataOrigin: 'formal', demoFlag: false, parentId: null, deletedAt: null },
      orderBy: { nearestDeadline: 'asc' },
      take: limit,
      include: { ...trackSummaryInclude, series: true, edition: true, track: true, children: { select: { id: true } } },
    });
    const now = new Date();
    return rows.map(row => this.toCard(row, false, row.children.length,
      summarizeSavedTracks(row, readSavedTracks(row.fieldEvidence[0]?.fieldValue), now)));
  }

  private toCard(
    row: {
      id: string;
      name: string;
      category: string | null;
      level: string | null;
      schoolRecognitionLevel?: string | null;
      publishStatus: string;
      completeness: string;
      registrationStatus: string;
      credibility: string;
      credibilityScore: number;
      siteStatus: string;
      signupMethod: string;
      nearestDeadline: Date | null;
      stages?: Array<{ endAt: Date | null; endPrecision: string; endTimezone: string | null; endRawText: string | null }>;
      series?: { name: string } | null;
      edition?: { name: string } | null;
      track?: { name: string } | null;
      organizers?: Array<{ organizer: { name: string } }>;
    },
    favorited: boolean,
    childCount = 0,
    summary?: ReturnType<typeof summarizeSavedTracks>,
  ): CompetitionCard {
    // The parent cutoff is normalized for querying; its stage retains source precision.
    const deadlineStage = row.nearestDeadline ? row.stages?.find(stage => {
      if (!stage.endAt) return false;
      const cutoff = endOfDayIfNeeded({ at: stage.endAt.toISOString(), precision: stage.endPrecision as TimePrecision,
        timezone: stage.endTimezone ?? 'Asia/Shanghai', rawText: stage.endRawText });
      return cutoff?.getTime() === row.nearestDeadline?.getTime() || stage.endAt.getTime() === row.nearestDeadline?.getTime();
    }) : undefined;
    return {
      id: row.id,
      name: row.name,
      seriesName: row.series?.name ?? null,
      editionName: row.edition?.name ?? null,
      trackName: row.track?.name ?? null,
      category: row.category,
      level: row.level,
      schoolRecognitionLevel: row.schoolRecognitionLevel ?? null,
      organizer: row.organizers?.[0]?.organizer.name ?? null,
      publishStatus: row.publishStatus as PublishStatus,
      completeness: row.completeness as Completeness,
      registrationStatus: summary?.next?.status ?? row.registrationStatus as RegistrationStatus,
      credibility: summary?.quality?.level ?? row.credibility as Credibility,
      credibilityScore: summary?.quality?.score ?? row.credibilityScore,
      siteStatus: row.siteStatus as CompetitionCard['siteStatus'],
      signupMethod: row.signupMethod as CompetitionCard['signupMethod'],
      nearestDeadline: summary?.next?.endAt ?? (deadlineStage?.endAt ? {
        at: deadlineStage.endAt.toISOString(), precision: deadlineStage.endPrecision as TimePrecision,
        timezone: deadlineStage.endTimezone ?? 'Asia/Shanghai', rawText: deadlineStage.endRawText,
      } : row.nearestDeadline
        ? {
            at: row.nearestDeadline.toISOString(),
            precision: 'day',
            timezone: 'Asia/Shanghai',
            rawText: null,
          }
        : null),
      tags: [row.category, row.level].filter((item): item is string => Boolean(item)),
      matchedBy: [],
      favorited,
      childCount,
      discoveryTrackCount: summary?.discoveryTrackCount,
      discoverySubjectCount: summary?.discoverySubjectCount,
    };
  }

  private sortCards(cards: CompetitionCard[], sort: NonNullable<SearchQuery['sort']>): CompetitionCard[] {
    const order: Record<string, number> = {
      closing_soon: 0,
      open: 1,
      not_started: 2,
      undetermined: 3,
      closed: 4,
    };
    const copy = [...cards];
    if (sort === 'deadline_asc') {
      return copy.sort((a, b) => this.deadlineMs(a) - this.deadlineMs(b));
    }
    if (sort === 'deadline_desc') {
      return copy.sort((a, b) => this.deadlineMs(b) - this.deadlineMs(a));
    }
    if (sort === 'credibility_desc') {
      return copy.sort((a, b) => b.credibilityScore - a.credibilityScore);
    }
    if (sort === 'updated_desc') {
      return copy.sort((a, b) => b.id.localeCompare(a.id));
    }
    return copy.sort((a, b) => {
      const statusDiff = (order[a.registrationStatus] ?? 9) - (order[b.registrationStatus] ?? 9);
      if (statusDiff !== 0) return statusDiff;
      const deadlineDiff = this.deadlineMs(a) - this.deadlineMs(b);
      if (deadlineDiff !== 0) return deadlineDiff;
      return a.id.localeCompare(b.id);
    });
  }

  private deadlineMs(card: CompetitionCard): number {
    return card.nearestDeadline?.at ? new Date(card.nearestDeadline.at).getTime() : Number.MAX_SAFE_INTEGER;
  }

  private bucket(
    cards: CompetitionCard[],
    selector: (card: CompetitionCard) => string,
    labeler?: (key: string) => string,
  ): Bucket[] {
    const map = new Map<string, number>();
    for (const card of cards) {
      const key = selector(card);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([key, count]) => ({ key, label: labeler ? labeler(key) : key, count }))
      .sort((a, b) => b.count - a.count);
  }

  private buildExcluded(
    all: CompetitionCard[],
    kept: CompetitionCard[],
  ): { count: number; reasons: Bucket[] } {
    const keptIds = new Set(kept.map((card) => card.id));
    const excluded = all.filter((card) => !keptIds.has(card.id));
    const reasons: Bucket[] = [];
    const low = excluded.filter((card) => card.credibility === 'low').length;
    const expired = excluded.filter((card) => card.registrationStatus === 'closed').length;
    const site = excluded.filter((card) => card.siteStatus === 'suspected_invalid').length;
    if (low > 0) reasons.push({ key: 'low_credibility', label: '低可信默认隐藏', count: low });
    if (expired > 0) reasons.push({ key: 'expired', label: '已截止默认隐藏', count: expired });
    if (site > 0) reasons.push({ key: 'site_invalid', label: '报名入口疑似失效', count: site });
    return { count: excluded.length, reasons };
  }

  evidenceView(item: {
    sourceTitle: string | null;
    snippet: string | null;
    locationJson: string | null;
    extractMethod: string;
    confidence: string;
    manuallyCorrected: boolean;
  }): EvidenceView {
    return {
      sourceTitle: item.sourceTitle,
      snippet: item.snippet ?? '',
      location: item.locationJson ? (JSON.parse(item.locationJson) as Record<string, unknown>) : null,
      extractMethod: item.extractMethod,
      confidence: item.confidence as EvidenceView['confidence'],
      manuallyCorrected: item.manuallyCorrected,
      locatable: Boolean(item.snippet),
    };
  }
}

export function missingFieldsOf(extraction: ExtractionResult): string[] {
  const inputs = extraction.fields.map((field) => ({
    key: field.key,
    state: field.state,
    value: field.value,
  }));
  return missingKeyFields(inputs);
}
