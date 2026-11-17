import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FieldState } from '@competition/contracts';
import { PrismaService } from '../platform/prisma.module';
import { SafeEgressService, fetchRaw } from '../platform/safe-fetch';
import { RobotsService } from '../platform/robots.service';
import { RateLimiterService } from '../platform/rate-limiter.service';
import { ArtifactService } from './artifact.service';
import { LlmService } from './llm.service';
import { ExtractionService } from './extraction.service';
import { TrackSplitService, inferSeriesName, fourElementKey } from './track-split.service';
import { extractLinks, findAttachmentLinks, htmlToText, pageTitle, type LinkItem } from '../domain/html';
import { computeCompleteness, computeCredibility } from '../domain/quality';
import { deriveRegistrationStatus, endOfDayIfNeeded, parseDateTime } from '../domain/time';
import { AppException } from '../platform/app-exception';
import { ConfigResolverService } from '../config/config-resolver.service';
import type { ExtractionResult } from '../domain/rule-extractor';

export interface CrawlOptions {
  trigger?: 'manual' | 'schedule' | 'onboarding' | 'verification';
  batchId?: string | null;
  limit?: number;
}

export interface CrawlReport {
  taskId: string;
  status: string;
  emptyReason: string | null;
  counters: Record<string, number>;
  message: string;
}

@Injectable()
export class CrawlerService {
  private readonly logger = new Logger(CrawlerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly egress: SafeEgressService,
    private readonly robots: RobotsService,
    private readonly rateLimiter: RateLimiterService,
    private readonly artifacts: ArtifactService,
    private readonly llm: LlmService,
    private readonly extraction: ExtractionService,
    private readonly trackSplit: TrackSplitService,
    private readonly resolver: ConfigResolverService,
  ) {}

  private get maxDetailPerRun(): number {
    return this.resolver.getNumber('crawl.maxDetailPerRun', 12);
  }

  private get maxPageBytes(): number {
    return this.resolver.getNumber('crawl.maxPageBytes', 5 * 1024 * 1024);
  }

  private get maxAttachmentBytes(): number {
    return this.resolver.getNumber('crawl.maxAttachmentBytes', 20 * 1024 * 1024);
  }

  private get maxAttachmentsPerDetail(): number {
    return this.resolver.getNumber('crawl.maxAttachmentsPerPage', 3);
  }

  async crawlSource(sourceId: string, options: CrawlOptions = {}): Promise<CrawlReport> {
    const source = await this.prisma.sourceDefinition.findUnique({ where: { id: sourceId } });
    if (!source) throw new AppException('RESOURCE_NOT_FOUND');

    const limit = Math.min(options.limit ?? this.maxDetailPerRun, this.maxDetailPerRun);
    const task = await this.prisma.crawlTask.create({
      data: {
        sourceId,
        batchId: options.batchId ?? null,
        triggerType: options.trigger ?? 'manual',
        status: 'processing',
        stage: 'precheck',
        startedAt: new Date(),
      },
    });

    const counters: Record<string, number> = {
      linksFound: 0,
      candidates: 0,
      detailsFetched: 0,
      competitionsCreated: 0,
      competitionsUpdated: 0,
      attachmentsSaved: 0,
      attachmentsRejected: 0,
      aiDegraded: 0,
      failures: 0,
    };

    try {
      const robotsResult = await this.robots.isAllowed(source.address);
      if (!robotsResult.allowed) {
        return await this.finish(task.id, 'failed', `robots_${robotsResult.reason}`, counters, `robots 限制：${robotsResult.reason}`);
      }

      await this.rateLimiter.waitForDomain(source.address);
      await this.rateLimiter.waitForUrl(source.address);

      if (this.isLanqiao(source)) {
        return await this.crawlLanqiao(source, options, task.id, counters);
      }

      const listResult = await fetchRaw(source.address, { maxBytes: this.maxPageBytes });
      if (!listResult.ok) {
        return await this.finish(
          task.id,
          'failed',
          listResult.internalReason ?? 'fetch_failed',
          counters,
          `列表页抓取失败：${listResult.internalReason ?? `HTTP ${listResult.status}`}`,
        );
      }

      await this.artifacts.saveSnapshot({
        taskId: task.id,
        sourceId,
        batchId: options.batchId ?? null,
        pageKind: 'list',
        result: listResult,
      });

      const listHtml = listResult.buffer.toString('utf8');
      const links = extractLinks(listHtml, listResult.finalUrl);
      counters.linksFound = links.length;

      const candidates = this.filterCandidateLinks(links, listResult.finalUrl);
      counters.candidates = candidates.length;

      if (candidates.length === 0) {
        return await this.finish(task.id, 'succeeded', 'zero_items', counters, '未发现竞赛公告链接');
      }

      let aiNote = '';
      if (this.llm.configured) {
        const ai = await this.llm.completeJson<{ announcementIds?: number[] }>(
          'link_discovery',
          '你是公告链接识别器。只从提供的真实链接清单中挑选竞赛公告，返回 JSON {"announcementIds":[序号]}。不得创造新链接。',
          JSON.stringify(candidates.slice(0, 40).map((item) => ({ id: item.index, text: item.text, url: item.url }))),
          { relatedType: 'crawl_task', relatedId: task.id },
        );
        if (ai.degraded) {
          counters.aiDegraded += 1;
          aiNote = '（AI 链接识别已降级为规则）';
        }
      }

      const limited = candidates.slice(0, limit);
      for (const link of limited) {
        const fingerprint = createHash('sha256').update(link.url).digest('hex');
        await this.prisma.candidate.upsert({
          where: { id: fingerprint },
          create: {
            id: fingerprint,
            sourceId,
            taskId: task.id,
            batchId: options.batchId ?? null,
            title: link.text || link.url,
            url: link.url,
            fingerprint,
            rawJson: JSON.stringify({ text: link.text }),
            status: 'pending',
          },
          update: { taskId: task.id, status: 'pending' },
        });
      }

      for (const link of limited) {
        try {
          const created = await this.processDetail(task.id, source, link, options.batchId ?? null, counters);
          if (created) counters.competitionsCreated += created;
        } catch (error) {
          counters.failures += 1;
          this.logger.warn(`detail ${link.url} failed: ${(error as Error).message}`);
          await this.prisma.candidate.updateMany({
            where: { url: link.url, sourceId },
            data: { status: 'failed', filterReason: (error as Error).message.slice(0, 200) },
          });
        }
      }

      const message = `抓取完成：发现 ${counters.linksFound} 个链接，公告候选 ${candidates.length} 个，抓取详情 ${counters.detailsFetched} 个，生成竞赛 ${counters.competitionsCreated} 个，附件 ${counters.attachmentsSaved} 个${aiNote}`;
      return await this.finish(task.id, 'succeeded', null, counters, message);
    } catch (error) {
      return await this.finish(task.id, 'failed', 'unexpected_error', counters, (error as Error).message);
    }
  }

  private isLanqiao(source: { address: string; name: string }): boolean {
    const pattern = this.resolver.getString('crawl.lanqiao.identifyPattern', 'lanqiao\\.cn|蓝桥杯');
    try {
      return new RegExp(pattern, 'i').test(`${source.address} ${source.name}`);
    } catch {
      return /lanqiao\.cn|蓝桥杯/i.test(`${source.address} ${source.name}`);
    }
  }

  private async crawlLanqiao(
    source: { id: string; address: string; name: string; whitelist: boolean; attachmentEnabled: boolean },
    options: CrawlOptions,
    taskId: string,
    counters: Record<string, number>,
  ): Promise<CrawlReport> {
    const batchId = options.batchId ?? null;
    const limit = Math.min(options.limit ?? this.maxDetailPerRun, this.maxDetailPerRun);
    const listUrl = `${
      this.resolver.getString('crawl.lanqiao.listApi', 'https://www.guoxinlanqiao.com/api/news/find')
    }?status=1&project=dasai&progid=20&pageno=1&pagesize=20`;

    await this.rateLimiter.waitForDomain(listUrl);
    const robotsResult = await this.robots.isAllowed(listUrl);
    if (!robotsResult.allowed) {
      return this.finish(taskId, 'failed', `robots_${robotsResult.reason}`, counters, 'robots 限制');
    }

    const listResult = await fetchRaw(listUrl, { maxBytes: this.maxPageBytes, accept: 'application/json' });
    if (!listResult.ok) {
      return this.finish(
        taskId,
        'failed',
        listResult.internalReason ?? 'fetch_failed',
        counters,
        '公告列表接口抓取失败',
      );
    }

    await this.artifacts.saveSnapshot({
      taskId,
      sourceId: source.id,
      batchId,
      pageKind: 'list',
      result: listResult,
    });

    const payload = JSON.parse(listResult.buffer.toString('utf8')) as {
      datalist?: Array<{ nnid: number; title: string }>;
    };
    const datalist = payload.datalist ?? [];
    counters.linksFound = datalist.length;
    counters.candidates = datalist.length;

    if (datalist.length === 0) {
      return this.finish(taskId, 'succeeded', 'zero_items', counters, '公告接口返回空列表');
    }

    for (const item of datalist.slice(0, limit)) {
      try {
        const created = await this.processLanqiaoDetail(taskId, source, item, batchId, counters);
        counters.competitionsCreated += created;
      } catch (error) {
        counters.failures += 1;
        this.logger.warn(`lanqiao detail ${item.nnid} failed: ${(error as Error).message}`);
      }
    }

    const message = `蓝桥杯真实采集完成：公告 ${datalist.length} 条，抓取详情 ${counters.detailsFetched} 条，生成竞赛 ${counters.competitionsCreated} 个，附件 ${counters.attachmentsSaved} 个`;
    return this.finish(taskId, 'succeeded', null, counters, message);
  }

  private async processLanqiaoDetail(
    taskId: string,
    source: { id: string; whitelist: boolean; attachmentEnabled: boolean },
    item: { nnid: number; title: string },
    batchId: string | null,
    counters: Record<string, number>,
  ): Promise<number> {
    const noticeUrl = this.resolver
      .getString('crawl.lanqiao.detailTemplate', 'https://dasai.lanqiao.cn/notices/{nnid}')
      .replace('{nnid}', String(item.nnid));
    const detailApi = `${
      this.resolver.getString(
        'crawl.lanqiao.detailApi',
        'https://www.guoxinlanqiao.com/api/web/news/selectone',
      )
    }?nnid=${item.nnid}`;

    await this.rateLimiter.waitForDomain(detailApi);
    await this.rateLimiter.waitForUrl(detailApi);
    const result = await fetchRaw(detailApi, { maxBytes: this.maxPageBytes, accept: 'application/json' });
    if (!result.ok) throw new Error(result.internalReason ?? `HTTP ${result.status}`);

    const snapshot = await this.artifacts.saveSnapshot({
      taskId,
      sourceId: source.id,
      batchId,
      pageKind: 'detail',
      result,
    });
    counters.detailsFetched += 1;

    const payload = JSON.parse(result.buffer.toString('utf8')) as {
      news?: { title?: string; content?: string };
    };
    const news = payload.news ?? {};
    const contentHtml = news.content ?? '';
    const text = htmlToText(contentHtml);
    const fullText = `${news.title ?? item.title}\n${text}`;
    const extraction = await this.extraction.extract(fullText, [], news.title ?? item.title);
    const officialTitle = (news.title ?? item.title).trim();
    if (officialTitle) {
      extraction.competitionName = officialTitle;
      const nameField = extraction.fields.find((field) => field.key === 'name');
      if (nameField) {
        nameField.value = officialTitle;
        nameField.state = 'explicit';
        nameField.confidence = 'high';
      }
    }

    const link: LinkItem = { url: noticeUrl, text: news.title ?? item.title, index: item.nnid };
    const created = await this.saveCompetitions({
      taskId,
      source,
      link,
      extraction,
      text: fullText,
      batchId,
      snapshotId: snapshot.snapshotId,
    });

    if (source.attachmentEnabled) {
      const attachments = findAttachmentLinks(contentHtml, detailApi).slice(0, this.maxAttachmentsPerDetail);
      for (const attachment of attachments) {
        try {
          await this.rateLimiter.waitForDomain(attachment.url);
          await this.rateLimiter.waitForUrl(attachment.url);
          const fileResult = await fetchRaw(attachment.url, { maxBytes: this.maxAttachmentBytes });
          if (!fileResult.ok) continue;
          const saved = await this.artifacts.saveAttachment({
            snapshotId: snapshot.snapshotId,
            sourceId: source.id,
            taskId,
            batchId,
            parentUrl: noticeUrl,
            url: attachment.url,
            fileName: this.fileNameOf(attachment),
            buffer: fileResult.buffer,
          });
          if (saved.stored) counters.attachmentsSaved += 1;
          else counters.attachmentsRejected += 1;
        } catch (error) {
          counters.failures += 1;
          this.logger.warn(`lanqiao attachment ${attachment.url} failed: ${(error as Error).message}`);
        }
      }
    }

    const fingerprint = createHash('sha256').update(noticeUrl).digest('hex');
    await this.prisma.candidate.upsert({
      where: { id: fingerprint },
      create: {
        id: fingerprint,
        sourceId: source.id,
        taskId,
        batchId,
        title: link.text,
        url: noticeUrl,
        fingerprint,
        rawJson: JSON.stringify({ nnid: item.nnid }),
        status: 'structured',
        snapshotId: snapshot.snapshotId,
      },
      update: { taskId, status: 'structured', snapshotId: snapshot.snapshotId },
    });

    return created;
  }

  private filterCandidateLinks(links: LinkItem[], baseUrl: string): LinkItem[] {
    const base = new URL(baseUrl);
    return links.filter((link) => {
      try {
        const url = new URL(link.url);
        if (url.hostname !== base.hostname && !url.hostname.endsWith(`.${base.hostname}`)) return false;
        if (!['http:', 'https:'].includes(url.protocol)) return false;
        const text = link.text || '';
        const path = url.pathname.toLowerCase();
        const looksLikeNotice = /(notice|news|article|detail|content|view|show|info|contest|competition|match|announce|activity|bulletin)/i.test(path);
        const hasCompetitionText = /(竞赛|大赛|比赛|挑战赛|锦标赛|报名|通知|公告)/.test(text);
        const meaningful = text.length >= 4 || looksLikeNotice;
        if (!meaningful) return false;
        if (/(登录|注册|首页|关于|联系|帮助|隐私|政策|English|登录|注册)/i.test(text) && !hasCompetitionText) return false;
        return looksLikeNotice || hasCompetitionText;
      } catch {
        return false;
      }
    });
  }

  private async processDetail(
    taskId: string,
    source: { id: string; address: string; whitelist: boolean; attachmentEnabled: boolean },
    link: LinkItem,
    batchId: string | null,
    counters: Record<string, number>,
  ): Promise<number> {
    await this.rateLimiter.waitForDomain(link.url);
    await this.rateLimiter.waitForUrl(link.url);
    const robotsResult = await this.robots.isAllowed(link.url);
    if (!robotsResult.allowed) {
      throw new Error(`robots_${robotsResult.reason}`);
    }

    const result = await fetchRaw(link.url, { maxBytes: this.maxPageBytes });
    if (!result.ok) {
      throw new Error(result.internalReason ?? `HTTP ${result.status}`);
    }

    const snapshot = await this.artifacts.saveSnapshot({
      taskId,
      sourceId: source.id,
      batchId,
      pageKind: 'detail',
      result,
    });
    counters.detailsFetched += 1;

    const html = result.buffer.toString('utf8');
    const text = htmlToText(html);
    const title = pageTitle(html) ?? link.text;
    const extraction = await this.extraction.extract(text, [], title || link.url);

    const created = await this.saveCompetitions({
      taskId,
      source,
      link,
      extraction,
      text,
      batchId,
      snapshotId: snapshot.snapshotId,
    });

    if (source.attachmentEnabled) {
      const attachments = findAttachmentLinks(html, result.finalUrl).slice(0, this.maxAttachmentsPerDetail);
      for (const attachment of attachments) {
        try {
          await this.rateLimiter.waitForDomain(attachment.url);
          await this.rateLimiter.waitForUrl(attachment.url);
          const fileResult = await fetchRaw(attachment.url, { maxBytes: this.maxAttachmentBytes });
          if (!fileResult.ok) continue;
          const fileName = this.fileNameOf(attachment);
          const saved = await this.artifacts.saveAttachment({
            snapshotId: snapshot.snapshotId,
            sourceId: source.id,
            taskId,
            batchId,
            parentUrl: link.url,
            url: attachment.url,
            fileName,
            buffer: fileResult.buffer,
          });
          if (saved.stored) counters.attachmentsSaved += 1;
          else counters.attachmentsRejected += 1;
        } catch (error) {
          counters.failures += 1;
          this.logger.warn(`attachment ${attachment.url} failed: ${(error as Error).message}`);
        }
      }
    }

    await this.prisma.candidate.updateMany({
      where: { url: link.url, sourceId: source.id },
      data: { status: 'structured', snapshotId: snapshot.snapshotId },
    });

    return created;
  }

  private async ensureSeriesParent(
    seriesId: string,
    seriesName: string,
    batchId: string | null,
  ): Promise<string> {
    const key = createHash('sha256')
      .update(`${seriesId}|__edition__|__series__|__none__`)
      .digest('hex');
    const existing = await this.prisma.competition.findFirst({
      where: { fourElementKey: key, deletedAt: null },
    });
    if (existing) return existing.id;

    const parent = await this.prisma.competition.create({
      data: {
        name: seriesName,
        normalizedName: seriesName.replace(/\s+/g, ''),
        seriesId,
        editionId: null,
        trackId: null,
        parentId: null,
        fourElementKey: key,
        description: `${seriesName} 系列聚合父记录`,
        publishStatus: 'draft',
        dataOrigin: batchId ? 'verification' : 'formal',
        verificationBatchId: batchId,
        createdBy: 'crawler',
      },
    });
    return parent.id;
  }

  private async saveCompetitions(input: {
    taskId: string;
    source: { id: string; whitelist: boolean };
    link: LinkItem;
    extraction: ExtractionResult;
    text: string;
    batchId: string | null;
    snapshotId: string;
  }): Promise<number> {
    const { extraction, text, batchId } = input;
    const name = extraction.competitionName || input.link.text || '未识别竞赛';
    const seriesName = inferSeriesName(name, text);
    const tracks = this.trackSplit.detect(text);
    const hierarchy = await this.trackSplit.ensureHierarchy({
      seriesName,
      editionText: text,
      tracks,
    });

    const deadlineTime = this.timeOf(extraction, 'nearestDeadline');
    const startTime = this.timeOf(extraction, 'startAt');
    const signupUrl = this.fieldValue(extraction, 'signupUrl');
    const signupMethod = this.fieldValue(extraction, 'signupMethod') ?? 'to_be_announced';
    const category = this.fieldValue(extraction, 'category');
    const level =
      this.fieldValue(extraction, 'level') ?? (seriesName.includes('蓝桥杯') ? '国家级' : null);
    const organizer = this.fieldValue(extraction, 'organizer');
    const eligibility = this.fieldValue(extraction, 'eligibility');

    const qualityFields = extraction.fields.map((field) => ({
      key: field.key,
      state: field.state as FieldState,
      value: field.value,
    }));
    const completeness = computeCompleteness(qualityFields, extraction.conflicts.length > 0);
    const credibility = computeCredibility({
      sourceTypes: ['official_site'],
      completeness,
      distinctSourceCount: 1,
      reviewed: false,
    });
    const nearestDeadline = deadlineTime?.at ? endOfDayIfNeeded(deadlineTime) : null;
    const registrationStatus = deriveRegistrationStatus({ startAt: startTime, endAt: deadlineTime });

    let createdCount = 0;
    const multipleTracks = hierarchy.tracks.length > 1 && hierarchy.tracks[0]?.name !== '未分赛道';
    let parentRowId: string | null = null;
    const seriesParentId = await this.ensureSeriesParent(
      hierarchy.seriesId,
      seriesName,
      batchId,
    );
    const targets = multipleTracks
      ? [
          {
            name,
            trackId: null as string | null,
            isParent: true,
            key: fourElementKey(hierarchy.seriesId, hierarchy.editionId, '__parent__'),
            parentId: seriesParentId as string | null,
          },
          ...hierarchy.tracks.map((track) => ({
            name: `${name}·${track.name}`,
            trackId: track.trackId as string | null,
            isParent: false,
            key: fourElementKey(hierarchy.seriesId, hierarchy.editionId, track.trackId),
            parentId: null as string | null,
          })),
        ]
      : [
          {
            name,
            trackId: (hierarchy.tracks[0]?.trackId ?? null) as string | null,
            isParent: false,
            key: fourElementKey(
              hierarchy.seriesId,
              hierarchy.editionId,
              hierarchy.tracks[0]?.trackId ?? '__none__',
            ),
            parentId: seriesParentId as string | null,
          },
        ];

    for (const target of targets) {
      const key = target.key;
      const competitionName = target.name;
      const existing = await this.prisma.competition.findFirst({
        where: { fourElementKey: key, deletedAt: null },
      });

      const data = {
        name: competitionName,
        normalizedName: competitionName.replace(/\s+/g, ''),
        seriesId: hierarchy.seriesId,
        editionId: hierarchy.editionId,
        trackId: target.trackId,
        parentId: target.parentId ?? parentRowId,
        fourElementKey: key,
        description: this.fieldValue(extraction, 'description'),
        category,
        level,
        organizerLevel: organizer ? '官方公告' : null,
        completeness,
        credibility: credibility.level,
        credibilityScore: credibility.score,
        credibilityBasis: credibility.basis.join('；'),
        registrationStatus,
        nearestDeadline,
        signupMethod,
        signupUrl,
        eligibilityJson: JSON.stringify({ eligibility: eligibility ?? '' }),
        dataOrigin: batchId ? 'verification' : 'formal',
        verificationBatchId: batchId,
        publishStatus: batchId ? 'draft' : 'pending_review',
      } as Prisma.CompetitionUncheckedCreateInput;

      const competition = existing
        ? await this.prisma.competition.update({
            where: { id: existing.id },
            data: { ...data, versionNo: { increment: 1 } },
          })
        : await this.prisma.competition.create({ data: { ...data, createdBy: 'crawler' } });

      if (!existing) createdCount += 1;
      if (target.isParent) parentRowId = competition.id;

      if (deadlineTime || startTime) {
        await this.prisma.registrationStage.create({
          data: {
            competitionId: competition.id,
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
          },
        });
      }

      if (signupUrl || signupMethod !== 'to_be_announced') {
        await this.prisma.signupEntry.create({
          data: {
            competitionId: competition.id,
            type: 'official',
            url: signupUrl,
            method: signupMethod,
            status: 'unverified',
          },
        });
      }

      await this.prisma.sourceMaterial.create({
        data: {
          competitionId: competition.id,
          type: 'official_site',
          title: input.link.text || competitionName,
          url: input.link.url,
          ownerId: 'crawler',
        },
      });

      for (const field of extraction.fields) {
        if (!field.evidence) continue;
        await this.prisma.fieldEvidence.create({
          data: {
            competitionId: competition.id,
            fieldName: field.key,
            fieldValue: String(field.value ?? ''),
            sourceTitle: input.link.text || input.link.url,
            snippet: field.evidence.snippet,
            locationJson: JSON.stringify(field.evidence.location ?? {}),
            extractMethod: field.evidence.extractMethod,
            confidence: field.evidence.confidence,
            fieldState: field.state,
            parseVersionId: null,
          },
        });
      }

      await this.prisma.competitionVersion.create({
        data: {
          competitionId: competition.id,
          versionNo: competition.versionNo,
          changesJson: JSON.stringify([{ field: 'name', before: existing?.name ?? null, after: competitionName }]),
          actor: 'crawler',
          reason: existing ? '真实采集更新' : '真实采集创建',
        },
      });

      await this.prisma.outboxEvent.create({
        data: {
          eventType: existing ? 'competition.crawl_updated' : 'competition.crawl_created',
          objectType: 'competition',
          objectId: competition.id,
          payloadJson: JSON.stringify({ taskId: input.taskId, batchId }),
        },
      });
    }

    return createdCount;
  }

  private timeOf(extraction: ExtractionResult, key: string) {
    const field = extraction.fields.find((item) => item.key === key);
    if (field?.time) return field.time;
    if (field?.value) return parseDateTime(field.value);
    return null;
  }

  private fieldValue(extraction: ExtractionResult, key: string): string | null {
    const field = extraction.fields.find((item) => item.key === key);
    return field?.value ?? null;
  }

  private fileNameOf(link: LinkItem): string {
    try {
      const url = new URL(link.url);
      const segment = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
      if (segment) return segment;
    } catch {
      // ignore
    }
    return link.text ? `${link.text.slice(0, 60)}.pdf` : 'attachment.pdf';
  }

  private async finish(
    taskId: string,
    status: string,
    emptyReason: string | null,
    counters: Record<string, number>,
    message: string,
  ): Promise<CrawlReport> {
    await this.prisma.crawlTask.update({
      where: { id: taskId },
      data: {
        status,
        stage: 'done',
        emptyReason,
        countersJson: JSON.stringify(counters),
        errorMessage: status === 'failed' ? message : null,
        finishedAt: new Date(),
      },
    });
    return { taskId, status, emptyReason, counters, message };
  }

  async listTasks(limit = 30): Promise<unknown[]> {
    const rows = await this.prisma.crawlTask.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,

    });
    return rows.map((row) => ({
      id: row.id,
      sourceId: row.sourceId,
      batchId: row.batchId,
      triggerType: row.triggerType,
      status: row.status,
      stage: row.stage,
      emptyReason: row.emptyReason,
      counters: JSON.parse(row.countersJson),
      errorMessage: row.errorMessage,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async taskDetail(taskId: string): Promise<unknown> {
    const task = await this.prisma.crawlTask.findUnique({ where: { id: taskId } });
    if (!task) throw new AppException('RESOURCE_NOT_FOUND');
    const snapshots = await this.artifacts.listByTask(taskId);
    return {
      id: task.id,
      sourceId: task.sourceId,
      batchId: task.batchId,
      status: task.status,
      stage: task.stage,
      emptyReason: task.emptyReason,
      counters: JSON.parse(task.countersJson),
      errorMessage: task.errorMessage,
      snapshots,
      createdAt: task.createdAt.toISOString(),
    };
  }
}