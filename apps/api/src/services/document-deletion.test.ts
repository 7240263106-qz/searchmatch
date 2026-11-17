import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../platform/audit.module';
import { LocalBlobStore } from '../platform/blob-store';
import { PrismaService } from '../platform/prisma.module';
import type { StorageService } from '../platform/storage.module';
import type { ConfigResolverService } from '../config/config-resolver.service';
import type { ParserClient } from './parser-client.service';
import { ExtractionService } from './extraction.service';
import type { CredentialVault } from '../config/credential-vault.service';
import { DocumentService } from './document.service';
import { ParseService } from './parse.service';
import { CompetitionService } from './competition.service';
import { CompetitionDiscoveryService } from './competition-discovery.service';
import type { AuthContext, DiscoveryPage, DiscoveryResult } from '@competition/contracts';
import { CompetitionsController } from '../controllers/competitions.controller';
import { extractDocumentCatalog } from '../domain/document-catalog';

const apiRoot = resolve(__dirname, '../..');
const localRequire = createRequire(join(apiRoot, 'package.json'));
const owner = 'document-delete-owner';
let root: string;
let prisma: PrismaService;
let blobs: LocalBlobStore;
let storage: StorageService;
let audit: AuditService;
let documents: DocumentService;
const enqueue = vi.fn(async () => ({ taskId: 'test-task', reused: false }));

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'competition-document-delete-'));
  const databasePath = join(root, 'test.db');
  writeFileSync(databasePath, '');
  const url = `file:${databasePath.split(sep).join('/')}`;
  execFileSync(process.execPath, [localRequire.resolve('prisma/build/index.js'), 'db', 'push',
    '--schema', resolve(apiRoot, 'prisma/schema.prisma'), '--skip-generate'], {
    cwd: apiRoot, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 30000,
  });
  prisma = new PrismaService({ datasourceUrl: url });
  await prisma.$connect();
  blobs = new LocalBlobStore(join(root, 'uploads'));
  storage = {
    save: async (buffer: Buffer, extension: string) => {
      const key = `${randomUUID()}.${extension}`;
      await blobs.put(key, buffer);
      return key;
    },
    read: (key: string) => blobs.get(key),
    delete: vi.fn((key: string) => blobs.delete(key)),
    signedUrl: (id: string) => `/documents/${id}/file`,
    verify: () => true,
  } as unknown as StorageService;
  audit = new AuditService(prisma);
  documents = service();
}, 40000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (root) rmSync(root, { recursive: true, force: true });
});

function tracedParser(options: { enabled?: boolean; text?: string; defaultModel?: string; documentModel?: string } = {}) {
  const values: Record<string, unknown> = { 'model.enabled': options.enabled ?? true,
    'model.baseUrl': 'https://model.example.com/v1', 'model.model': options.defaultModel ?? 'model-default',
    'model.taskModel.document': options.documentModel ?? '', 'model.secretRef': 'test-ref', 'model.timeoutMs': 3000 };
  const resolver = { get: (key: string, fallback: unknown) => values[key] ?? fallback,
    getString: (key: string, fallback: string) => values[key] ?? fallback,
    getBoolean: (key: string, fallback: boolean) => values[key] ?? fallback,
    getNumber: (key: string, fallback: number) => values[key] ?? fallback, snapshotVersion: () => 15 } as unknown as ConfigResolverService;
  const extraction = new ExtractionService(resolver, { resolve: () => 'test-secret-do-not-record' } as unknown as CredentialVault);
  const text = options.text ?? '2026年运行日志竞赛通知\n主办单位：测试大学\n参赛对象：在校大学生';
  const parser = { parse: async () => ({ ok: true, text, blocks: [], source: 'python', degraded: false, pageCount: 1 }) } as unknown as ParserClient;
  return { service: new ParseService(prisma, storage, parser, extraction), extraction };
}

async function waitForTask(taskId: string, predicate: (task: { status: string; traceJson: string }) => boolean) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const task = await prisma.parseTask.findUniqueOrThrow({ where: { id: taskId } });
    if (predicate(task)) return task;
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error('Task did not reach expected state');
}

describe('文档运行详情与持久化日志', () => {
  const catalogText = readFileSync(join(__dirname, '../domain/fixtures/recognition-catalog.txt'), 'utf8');
  const catalogRows = extractDocumentCatalog(catalogText, [], '目录.pdf')!.competitions;
  it('目录分三批请求，核验 71 项后预览、批量入库且保留 ABC 与来源，重复保存不增项', async () => {
    const { document } = await fixture();
    const { service } = tracedParser({ text: catalogText });
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0].content).toContain('逐行完整返回');
      const sequence = /序号 ([\d,]+)。/.exec(body.messages[1].content)![1].split(',').map(Number);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ competitions: sequence.map(value => {
        const row = catalogRows.find(row => row.sequence === value)!;
        return { sequence: value, name: row.name, schoolRecognitionLevel: row.schoolRecognitionLevel };
      }) }) } }], usage: { prompt_tokens: 500, completion_tokens: 900 } }), { status: 200 });
    });
    try {
      const { taskId } = await service.enqueue(document.id, 'reparse', owner);
      await waitForTask(taskId, task => task.status === 'succeeded');
      expect(request).toHaveBeenCalledTimes(3);
      const preview = await service.preview(taskId, owner);
      expect(preview.catalog?.competitions).toHaveLength(71);
      expect(preview.fields).toEqual([]);
      expect(preview.competitionName).toBeNull();
      const run = (await service.runs(document.id, owner)).runs[0];
      expect(run.trace?.extraction).toMatchObject({ status: 'used', promptTokens: 1500, completionTokens: 2700,
        catalog: { expectedRows: 71, returnedRows: 71, validatedRows: 71, batches: 3 } });
      expect(run.result?.catalog?.gradeCounts).toEqual({ 'A类': 5, 'B类': 14, 'C类': 52 });
      const competitions = new CompetitionService(prisma, audit, service);
      await expect(competitions.confirmFromParse(taskId, {}, owner)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const payload = { resultVersionId: preview.resultVersionId, items: catalogRows.map(row => ({ sequence: row.sequence, name: row.name, schoolRecognitionLevel: row.schoolRecognitionLevel! })) };
      await expect(competitions.confirmCatalog(taskId, { ...payload, resultVersionId: 'stale' }, owner)).rejects.toMatchObject({ code: 'STATE_TRANSITION_INVALID' });
      await expect(competitions.confirmCatalog(taskId, payload, 'other-owner')).rejects.toMatchObject({ code: 'PARSE_TASK_NOT_FOUND' });
      await expect(competitions.confirmCatalog(taskId, { ...payload, items: [...payload.items, payload.items[0]] }, owner)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const otherDraft = await prisma.competition.create({ data: { name: catalogRows[0].name, normalizedName: payload.items[0].name.toLowerCase().replace(/\s+/g, ''),
        createdBy: 'other-owner', schoolRecognitionLevel: 'C类' } });
      const saved = await competitions.confirmCatalog(taskId, payload, owner);
      expect((await prisma.competition.findUniqueOrThrow({ where: { id: otherDraft.id } })).schoolRecognitionLevel).toBe('C类');
      expect(saved.count).toBe(71);
      expect(await prisma.documentCompetitionLink.count({ where: { documentId: document.id } })).toBe(71);
      const detail = await competitions.detail(saved.items[0].id, owner);
      expect(detail).toMatchObject({ schoolRecognitionLevel: 'A类', schoolRecognitionScope: '江苏师范大学科文学院', level: null,
        organizer: null, entries: [], publishStatus: 'draft', registrationStatus: 'undetermined' });
      expect((await prisma.competition.findUniqueOrThrow({ where: { id: saved.items[0].id } })).signupUrl).toBeNull();
      expect(await prisma.fieldEvidence.count({ where: { competitionId: saved.items[0].id, parseVersionId: preview.resultVersionId } })).toBe(3);
      const again = await competitions.confirmCatalog(taskId, payload, owner);
      expect(again.items.map(row => row.id)).toEqual(saved.items.map(row => row.id));
      expect(await prisma.documentCompetitionLink.count({ where: { documentId: document.id } })).toBe(71);
      expect((await documents.list(owner)).find(row => row.id === document.id)?.linkedCompetitionCount).toBe(71);
      expect((await competitions.search({ documentId: document.id, limit: 100 }, owner)).items).toEqual([]);
      const workspace = await competitions.search({ scope: 'workspace', documentId: document.id, includeLowCredibility: true, includeExpired: true, limit: 100 }, owner, ['editor']);
      expect(workspace.items).toHaveLength(71);
      expect(workspace.items.every(row => row.publishStatus === 'draft')).toBe(true);
      const published = await competitions.confirmCatalog(taskId, { ...payload, publish: true }, owner);
      expect(published.items.map(row => row.id)).toEqual(saved.items.map(row => row.id));
      const search = await competitions.search({ documentId: document.id, limit: 100 }, owner);
      expect(search.items).toHaveLength(71);
      expect(search.items.every(row => row.publishStatus === 'published')).toBe(true);
      const retry = await competitions.confirmCatalog(taskId, { ...payload, publish: true }, owner);
      expect(retry.items.map(row => row.id)).toEqual(saved.items.map(row => row.id));
      expect(await prisma.reviewRecord.count({ where: { competitionId: saved.items[0].id, action: 'approve' } })).toBe(1);
    } finally { request.mockRestore(); }
  }, 30000);

  it('工作区搜索展示授权草稿和待审核，关键词与筛选不绕过权限或正式数据边界', async () => {
    const keyword = `搜索范围${randomUUID()}`;
    const competitions = new CompetitionService(prisma, audit, tracedParser({ enabled: false }).service);
    const create = (label: string, extra: Record<string, unknown> = {}) => prisma.competition.create({
      data: { name: `${keyword}${label}`, normalizedName: `${keyword}${label}`, createdBy: owner,
        publishStatus: 'published', registrationStatus: 'open', credibility: 'high', ...extra },
    });
    const published = await create('已发布');
    const draft = await create('我的草稿', { publishStatus: 'draft' });
    await create('他人草稿', { publishStatus: 'draft', createdBy: 'other-owner' });
    const pending = await create('待审核', { publishStatus: 'pending_review', createdBy: 'other-owner' });
    const expired = await create('已截止', { registrationStatus: 'closed' });
    await create('演示数据', { demoFlag: true });
    await create('测试数据', { dataOrigin: 'test' });
    await create('已删除', { deletedAt: new Date() });
    const query = { keyword, includeLowCredibility: true, includeExpired: true, limit: 100 };
    const ids = (result: Awaited<ReturnType<CompetitionService['search']>>) => result.items.map(row => row.id).sort();
    expect(ids(await competitions.search(query, owner, ['admin']))).toEqual([published.id, expired.id].sort());
    expect(ids(await competitions.search({ ...query, scope: 'published' }, owner, ['admin'])))
      .toEqual([published.id, expired.id].sort());
    expect(ids(await competitions.search({ ...query, scope: 'workspace' }, owner, ['editor'])))
      .toEqual([published.id, draft.id, expired.id].sort());
    expect(ids(await competitions.search({ ...query, scope: 'workspace', registrationStatus: ['open'] }, owner, ['reviewer'])))
      .toEqual([published.id, draft.id, pending.id].sort());
    expect(ids(await competitions.search({ ...query, scope: 'workspace', includeExpired: false }, owner, ['admin'])))
      .toEqual([published.id, draft.id, pending.id].sort());
    expect(ids(await competitions.search({ ...query, scope: 'workspace' }, 'unrelated-viewer', ['viewer'])))
      .toEqual([published.id, expired.id].sort());
    const controller = new CompetitionsController(competitions, null!, null!);
    expect(ids(await controller.search({ ...query, scope: 'workspace' }, { userId: owner, roles: ['reviewer'] } as AuthContext) as Awaited<ReturnType<CompetitionService['search']>>))
      .toEqual([published.id, draft.id, pending.id, expired.id].sort());
    await expect(competitions.search({ ...query, scope: 'invalid' as 'workspace' }, owner))
      .rejects.toMatchObject({ code: 'QUERY_CONDITION_INVALID' });
  });

  it('单场确认直接发布，并只更新所选采集字段且保留原文依据', async () => {
    const { document } = await fixture();
    const { service } = tracedParser({ enabled: false });
    const { taskId } = await service.enqueue(document.id, 'reparse', owner);
    await waitForTask(taskId, task => task.status === 'succeeded');
    const preview = await service.preview(taskId, owner);
    const competitions = new CompetitionService(prisma, audit, service);
    const published = await competitions.confirmFromParse(taskId, {
      resultVersionId: preview.resultVersionId, publish: true, name: '发布与采集集成测试竞赛',
    }, owner);
    expect(published.publishStatus).toBe('published');
    expect((await competitions.search({ documentId: document.id }, owner)).items.map(row => row.id)).toEqual([published.id]);

    const page = {
      url: 'https://contest.example.org/notice', title: '赛事公告', kind: 'notice' as const,
      scope: 'general' as const, year: 2099, edition: null, excerpt: '', attachments: [],
      fields: [
        { key: 'signupUrl', label: '报名入口', value: 'https://contest.example.org/register', quote: '请通过 https://contest.example.org/register 报名' },
        { key: 'nearestDeadline', label: '报名截止时间', value: '2099年12月31日', quote: '报名截止时间：2099年12月31日' },
      ],
    };
    const discovery = new CompetitionDiscoveryService(prisma, null!, null!, null!, null!, null!, null!);
    vi.spyOn(discovery, 'discover').mockResolvedValue({
      name: published.name, searchedAt: new Date().toISOString(), matching: 'rules',
      searches: [], sites: [], pages: [page], issues: [],
    } satisfies DiscoveryResult);
    const run = await discovery.discoverForCompetition(published.id, owner);
    expect(discovery.discover).toHaveBeenCalledWith(published.name, owner, undefined, undefined);
    const input = { runId: run.runId!, pageUrl: page.url, keys: ['signupUrl', 'nearestDeadline'] };
    expect(() => discovery.selectedFields(published.id, 'other-owner', input))
      .toThrow(expect.objectContaining({ code: 'STATE_TRANSITION_INVALID' }));
    expect(() => discovery.selectedFields(published.id, owner, { ...input, keys: ['schoolRecognitionLevel'] }))
      .toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    const selected = discovery.selectedFields(published.id, owner, input);
    const updated = await competitions.saveDiscoveryFields(published.id, selected.version, selected.page, owner);
    expect(updated.versionNo).toBe(published.versionNo + 1);
    expect(updated.organizer).toBe(published.organizer);
    expect(updated.entries).toContainEqual(expect.objectContaining({ url: page.fields[0].value, status: 'unverified' }));
    expect(updated.stages[0]?.endAt?.rawText).toBe(page.fields[1].value);
    expect(updated.sources).toContainEqual(expect.objectContaining({ url: page.url }));
    expect(await prisma.fieldEvidence.findFirst({ where: { competitionId: published.id, fieldName: 'signupUrl' } }))
      .toMatchObject({ snippet: page.fields[0].quote });
    await expect(competitions.saveDiscoveryFields(published.id, published.versionNo, page, owner))
      .rejects.toMatchObject({ code: 'STATE_TRANSITION_INVALID' });
  });

  it('在草稿和待审核中采集并保存字段，保持原状态和访问权限', async () => {
    const row = await prisma.competition.create({
      data: { name: '审核采集竞赛', normalizedName: '审核采集竞赛', createdBy: owner },
    });
    const competitions = new CompetitionService(prisma, audit, tracedParser({ enabled: false }).service);
    const discovery = new CompetitionDiscoveryService(prisma, null!, null!, null!, null!, null!, null!);
    const page = {
      url: 'https://contest.example.org/review-notice', title: '赛事公告', kind: 'notice' as const,
      scope: 'general' as const, year: 2099, edition: null, excerpt: '', attachments: [],
      fields: [{ key: 'signupUrl', label: '报名入口', value: 'https://contest.example.org/register', quote: '赛事报名入口' }],
    };
    vi.spyOn(discovery, 'discover').mockResolvedValue({
      name: row.name, searchedAt: new Date().toISOString(), matching: 'rules', searches: [], sites: [], pages: [page], issues: [],
    });
    const editor = ['editor'];
    const reviewer = ['reviewer'];
    const other = 'reviewer-other';
    await expect(discovery.discoverForCompetition(row.id, other, undefined, reviewer))
      .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(competitions.saveDiscoveryFields(row.id, row.versionNo, page, other, reviewer))
      .rejects.toMatchObject({ code: 'STATE_TRANSITION_INVALID' });
    await expect(competitions.submitReview(row.id, other)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    const draftRun = await discovery.discoverForCompetition(row.id, owner, undefined, editor);
    const select = (runId: string, actor: string) => discovery.selectedFields(row.id, actor, {
      runId, pageUrl: page.url, keys: ['signupUrl'],
    });
    const draftSelection = select(draftRun.runId!, owner);
    const draft = await competitions.saveDiscoveryFields(row.id, draftSelection.version, draftSelection.page, owner, editor);
    expect(draft.publishStatus).toBe('draft');
    expect(draft.entries).toContainEqual(expect.objectContaining({ url: page.fields[0].value }));
    await expect(competitions.submitReview(row.id, owner)).resolves.toMatchObject({ status: 'pending_review' });
    const submittedAt = (await prisma.reviewRecord.findFirstOrThrow({
      where: { competitionId: row.id, action: 'submit' },
    })).createdAt.toISOString();
    await expect(discovery.discoverForCompetition(row.id, owner, undefined, editor))
      .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    const reviewRun = await discovery.discoverForCompetition(row.id, other, undefined, reviewer);
    const reviewSelection = select(reviewRun.runId!, other);
    await expect(competitions.saveDiscoveryFields(row.id, reviewSelection.version, reviewSelection.page, other, editor))
      .rejects.toMatchObject({ code: 'STATE_TRANSITION_INVALID' });
    const pending = await competitions.saveDiscoveryFields(row.id, reviewSelection.version, reviewSelection.page, other, reviewer);
    expect(pending.publishStatus).toBe('pending_review');
    expect(await competitions.reviewQueue()).toContainEqual(expect.objectContaining({
      competitionId: row.id, submittedAt,
    }));
    await expect(competitions.reject(row.id, other, '')).rejects.toMatchObject({ code: 'REVIEW_COMMENT_REQUIRED' });
    await expect(competitions.reject(row.id, other, '请核对公告届次')).resolves.toMatchObject({ status: 'draft' });
    await expect(competitions.saveDiscoveryFields(row.id, pending.versionNo, page, owner, editor))
      .rejects.toMatchObject({ code: 'STATE_TRANSITION_INVALID' });
    await expect(competitions.submitReview(row.id, owner)).resolves.toMatchObject({ status: 'pending_review' });
    await expect(competitions.publish(row.id, other)).resolves.toMatchObject({ status: 'published' });
  });

  it('保存经核验的赛道资料，提交审核和发布后保留分项日期与原文', async () => {
    const row = await prisma.competition.create({
      data: { name: '赛道资料核对竞赛', normalizedName: '赛道资料核对竞赛', createdBy: owner,
        credibility: 'low', credibilityScore: 40 },
    });
    const competitions = new CompetitionService(prisma, audit, tracedParser({ enabled: false }).service);
    const discovery = new CompetitionDiscoveryService(prisma, null!, null!, null!, null!, null!, null!);
    const controller = new CompetitionsController(competitions, discovery, null!);
    const guide = { url: 'https://contest.example.org/guide.pdf', title: '官方报名说明' };
    const scheduleNotice = { url: 'https://contest.example.org/schedule', title: '省赛时间公告' };
    const track = {
      url: 'https://contest.example.org/special', title: '专项赛', edition: '第十八届',
      subjects: ['应用开发', '视觉设计'],
      registration: [
        { subject: '应用开发', start: '2020年10月8日10:00', end: '2099年12月18日14:00', includesSubmission: false },
        { subject: '视觉设计', start: '2099年9月8日14:00', end: '2099年11月30日14:00', includesSubmission: true },
      ],
      schedule: [{ subject: '应用开发', time: '2027年4月24日 9:00—13:00' }],
      guide, scheduleNotice,
    };
    const page: DiscoveryPage = {
      url: 'https://contest.example.org/', title: '赛事官网', kind: 'site', scope: 'general', year: null, edition: null,
      excerpt: '', attachments: [], fields: [], tracks: [track, { title: '只有入口', url: 'https://contest.example.org/entry' }],
    };
    const notice: DiscoveryPage = {
      ...page, url: 'https://contest.example.org/notice', kind: 'notice', tracks: undefined,
      fields: [
        { key: 'eligibility', label: '参赛对象', value: '在校生', quote: '参赛对象为在校生。' },
        { key: 'competitionContent', label: '比赛内容', value: '完成作品设计。', quote: '参赛团队需完成作品设计。' },
      ],
    };
    const result: DiscoveryResult = { name: row.name, searchedAt: new Date().toISOString(), matching: 'rules',
      searches: [], sites: [], pages: [page, notice], issues: [] };
    const crawl = vi.spyOn(discovery, 'discover').mockResolvedValue(result);
    const actor = { userId: owner, roles: ['editor'] } as AuthContext;
    const reviewer = { userId: 'track-reviewer', roles: ['reviewer'] } as AuthContext;
    const run = await discovery.discoverForCompetition(row.id, owner, undefined, actor.roles);
    const input = { runId: run.runId!, pageUrl: page.url, keys: ['discoveryTracks'] };
    expect(() => discovery.selectedFields(row.id, reviewer.userId, input))
      .toThrow(expect.objectContaining({ code: 'STATE_TRANSITION_INVALID' }));
    expect(() => discovery.selectedFields(row.id, owner, { ...input, pageUrl: notice.url }))
      .toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    const saved = await controller.saveDiscoveryFields(row.id, input, actor) as Awaited<ReturnType<CompetitionService['detail']>>;
    expect(saved).toMatchObject({
      publishStatus: 'draft', discoveryTracks: [track], credibility: 'medium', credibilityScore: 60,
      registrationStatus: 'open', nearestDeadline: { at: '2099-12-18T06:00:00.000Z' },
    });
    expect(saved.sources).toEqual(expect.arrayContaining([
      expect.objectContaining(guide), expect.objectContaining(scheduleNotice),
    ]));
    await controller.saveDiscoveryFields(row.id, { ...input, pageUrl: notice.url, keys: ['eligibility', 'competitionContent'] }, actor);
    await competitions.submitReview(row.id, owner);
    expect(await competitions.detail(row.id, reviewer.userId)).toMatchObject({
      publishStatus: 'pending_review', discoveryTracks: [track], eligibility: { eligibility: '在校生' }, description: '完成作品设计。',
    });

    // A subsequent read of only the fee guide should retain the confirmed timetable.
    crawl.mockResolvedValue({ ...result, pages: [{ ...page, tracks: [{ ...track, schedule: undefined, scheduleNotice: undefined }] }] });
    const laterRun = await discovery.discoverForCompetition(row.id, reviewer.userId, undefined, reviewer.roles);
    await controller.saveDiscoveryFields(row.id, { ...input, runId: laterRun.runId! }, reviewer);
    await competitions.publish(row.id, reviewer.userId);
    expect(await competitions.detail(row.id, 'viewer')).toMatchObject({
      publishStatus: 'published', discoveryTracks: [track], credibility: 'high', credibilityScore: 80,
      discoveryTrackCount: 1, discoverySubjectCount: 2, nearestDeadline: { at: '2099-12-18T06:00:00.000Z' },
    });
    expect((await competitions.search({
      keyword: row.name, registrationStatus: ['open'], credibility: ['high'], deadlineFrom: '2099-12-01',
    }, owner)).items).toMatchObject([{ id: row.id, discoveryTrackCount: 1, discoverySubjectCount: 2, credibilityScore: 80 }]);
    expect((await competitions.search({ keyword: row.name, credibility: ['low'] }, owner)).items).toEqual([]);
    expect(await prisma.competition.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      nearestDeadline: null, credibilityScore: 80,
    });
    expect(await prisma.fieldEvidence.count({ where: { competitionId: row.id, fieldName: 'discoveryTracks' } })).toBe(1);
  });

  it('审核发布后重算目录旧评级，使已核验资料可以被默认知识库检索', async () => {
    const row = await prisma.competition.create({
      data: { name: '审核评级回算竞赛', normalizedName: '审核评级回算竞赛', createdBy: owner,
        publishStatus: 'pending_review', credibility: 'low', credibilityScore: 40,
        sources: { create: { type: 'uploaded_document', title: '竞赛通知' } } },
    });
    const competitions = new CompetitionService(prisma, audit, tracedParser({ enabled: false }).service);
    expect((await competitions.search({ keyword: row.name }, owner)).items).toEqual([]);
    await competitions.publish(row.id, 'reviewer', '核验来源及实质信息，日期尚未公布。');
    expect(await competitions.detail(row.id, owner)).toMatchObject({
      publishStatus: 'published', credibility: 'medium', credibilityScore: 60, completeness: 'partial',
    });
    expect((await competitions.search({ keyword: row.name }, owner)).items).toMatchObject([{ id: row.id }]);
  });

  it('目录模型漏项时保留全部原文行，不用不完整响应覆盖原件', async () => {
    const { document } = await fixture();
    const { service } = tracedParser({ text: catalogText });
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"competitions":[]}' } }] }), { status: 200 }));
    try {
      const { taskId } = await service.enqueue(document.id, 'reparse', owner);
      await waitForTask(taskId, task => task.status === 'succeeded');
      const preview = await service.preview(taskId, owner);
      expect(preview.catalog?.competitions).toHaveLength(71);
      expect(preview.source).toBe('rule');
      expect((await service.runs(document.id, owner)).runs[0].trace?.extraction?.reason).toBe('catalog_row_count_mismatch');
    } finally { request.mockRestore(); }
  });

  it('目录模型改错等级时回退原文，未配置模型时同样保留 ABC 等级', async () => {
    for (const enabled of [true, false]) {
      const { document } = await fixture();
      const { service } = tracedParser({ enabled, text: '测试学院竞赛认定目录\n1\n竞赛甲\nA类\n2\n竞赛乙\nB类' });
      const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ competitions: [
        { sequence: 1, name: '竞赛甲', schoolRecognitionLevel: 'C类' }, { sequence: 2, name: '竞赛乙', schoolRecognitionLevel: 'B类' },
      ] }) } }] }), { status: 200 }));
      try {
        const { taskId } = await service.enqueue(document.id, 'reparse', owner);
        await waitForTask(taskId, task => task.status === 'succeeded');
        expect((await service.preview(taskId, owner)).catalog?.competitions[0].schoolRecognitionLevel).toBe('A类');
        expect((await service.runs(document.id, owner)).runs[0].trace?.extraction?.reason).toBe(enabled ? 'catalog_field_mismatch' : 'configuration_incomplete');
        if (!enabled) expect(request).not.toHaveBeenCalled();
      } finally { request.mockRestore(); }
    }
  });
  it('旧任务按任务关联结果，缺失日志不伪造，并限制文档所有者访问', async () => {
    const { document } = await fixture();
    const { service } = tracedParser();
    const view = await service.runs(document.id, owner);
    expect(view.runs[0].trace).toBeNull();
    expect(view.runs[0].result).toMatchObject({ versionNo: 1, adopted: true, source: 'rule' });
    await expect(service.runs(document.id, 'other-owner')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('调用期间可见日志和进度，完成后保留配置、用量与各次历史，不包含密钥', async () => {
    const { document } = await fixture();
    const { service } = tracedParser({ defaultModel: '', documentModel: 'document-model' });
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await gate;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"fields":[]}' } }], usage: { prompt_tokens: 123, completion_tokens: 14 } }), { status: 200 });
    });
    try {
      const result = await service.enqueue(document.id, 'reparse', owner);
      await waitForTask(result.taskId, task => JSON.parse(task.traceJson).logs?.some((log: { code: string }) => log.code === 'model.started'));
      const active = await service.runs(document.id, owner);
      expect(active.runs[0]).toMatchObject({ status: 'processing', stage: 'extract' });
      expect((await service.enqueue(document.id, 'reparse', owner)).reused).toBe(true);
      release();
      await waitForTask(result.taskId, task => task.status === 'succeeded');
      const view = await service.runs(document.id, owner);
      expect(view.runs).toHaveLength(2);
      expect(view.runs[0].trace?.extraction).toMatchObject({ status: 'used', promptTokens: 123, completionTokens: 14,
        configuration: { model: 'document-model', modelSource: 'document', configVersion: 15, missing: [] } });
      expect(view.runs[0].trace?.logs.at(-1)?.code).toBe('task.completed');
      expect(view.runs[0].result).toMatchObject({ source: 'llm', versionNo: 2, adopted: true });
      expect(view.runs[1].result?.adopted).toBe(false);
      expect(JSON.stringify(view)).not.toContain('test-secret-do-not-record');
      const body = JSON.parse(String(request.mock.calls[0][1]?.body));
      expect(body.model).toBe('document-model');
    } finally { release(); request.mockRestore(); }
  });

  it.each([
    { name: '未启用模型', options: { enabled: false }, status: 200, content: '{}', reason: 'configuration_incomplete', path: 'skipped' },
    { name: '扫描件没有文字', options: { text: '' }, status: 200, content: '{}', reason: 'no_text', path: 'skipped' },
    { name: '错误 API Key', options: {}, status: 401, content: '{}', reason: 'http_401', path: 'failed' },
    { name: '错误 JSON 响应', options: {}, status: 200, content: 'not json', reason: 'invalid_json', path: 'failed' },
  ])('$name 会保留回退原因和规则结果', async ({ options, status, content, reason, path }) => {
    const { document } = await fixture();
    const { service } = tracedParser(options);
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }));
    try {
      const { taskId } = await service.enqueue(document.id, 'reparse', owner);
      await waitForTask(taskId, task => ['succeeded', 'failed'].includes(task.status));
      const run = (await service.runs(document.id, owner)).runs[0];
      expect(run.status).toBe('succeeded');
      expect(run.result?.source).toBe('rule');
      expect(run.trace?.extraction).toMatchObject({ status: path, reason });
      expect(run.trace?.logs.some(log => log.code === reason && log.level === 'warning')).toBe(true);
      if (path === 'skipped') expect(request).not.toHaveBeenCalled();
    } finally { request.mockRestore(); }
  });

  it('解析器故障保留错误日志且不调用模型', async () => {
    const { document } = await fixture();
    const { extraction } = tracedParser();
    const service = new ParseService(prisma, storage, { parse: async () => ({ ok: false, text: '', blocks: [],
      source: 'fallback', degraded: true, errorCode: 'FILE_UNREADABLE', message: '解析服务不可用' }) } as unknown as ParserClient, extraction);
    const { taskId } = await service.enqueue(document.id, 'reparse', owner);
    await waitForTask(taskId, task => task.status === 'failed');
    const run = (await service.runs(document.id, owner)).runs[0];
    expect(run.errorMessage).toBe('解析服务不可用');
    expect(run.trace?.logs.at(-1)).toMatchObject({ level: 'error', code: 'FILE_UNREADABLE' });
    expect(run.trace?.extraction).toBeUndefined();
  });
});

function service(client = prisma): DocumentService {
  return new DocumentService(client, storage, audit, { enqueue } as unknown as ParseService,
    { getNumber: () => 180 } as unknown as ConfigResolverService);
}

describe('报名截止精度在各入口保持一致', () => {
  it('按日截止在存储日末归一化后仍匹配原阶段，且不借用无关阶段的精度', async () => {
    const row = await prisma.competition.create({ data: {
      name: '按日精度回归', normalizedName: randomUUID(), createdBy: owner,
      publishStatus: 'draft', nearestDeadline: new Date('2099-11-30T15:59:59.000Z'),
      stages: { create: [
        { name: '无关阶段', endAt: new Date('2099-11-29T08:00:00.000Z'), endPrecision: 'second', endRawText: '其他日期16:00', sortOrder: 0 },
        { name: '按日阶段', endAt: new Date('2099-11-29T16:00:00.000Z'), endPrecision: 'day', endTimezone: 'Asia/Shanghai', endRawText: '2099年11月30日', sortOrder: 1 },
      ] },
    } });
    const service = new CompetitionService(prisma, audit, tracedParser({ enabled: false }).service);
    expect((await service.detail(row.id, owner)).nearestDeadline).toEqual({
      at: '2099-11-29T16:00:00.000Z', precision: 'day', timezone: 'Asia/Shanghai', rawText: '2099年11月30日',
    });
    await prisma.competition.update({ where: { id: row.id }, data: { nearestDeadline: new Date('2099-12-05T15:59:59.999Z') } });
    expect((await service.detail(row.id, owner)).nearestDeadline).toMatchObject({ precision: 'day', rawText: null });
  });
  it.each(['draft', 'published'])('%s 的列表与详情保留报名阶段的精确时刻、时区和原文', async publishStatus => {
    const endAt = new Date('2099-11-30T08:00:00.000Z');
    const row = await prisma.competition.create({ data: {
      name: '截止精度回归', normalizedName: randomUUID(), createdBy: owner,
      publishStatus, dataOrigin: 'formal', demoFlag: false, nearestDeadline: endAt,
      stages: { create: { name: 'A—H报名', stageType: 'official', endAt,
        endPrecision: 'second', endTimezone: 'Asia/Shanghai', endRawText: '2099年11月30日16:00' } },
    } });
    const service = new CompetitionService(prisma, audit, tracedParser({ enabled: false }).service);
    const expected = { at: endAt.toISOString(), precision: 'second', timezone: 'Asia/Shanghai', rawText: '2099年11月30日16:00' };
    expect((await service.detail(row.id, owner)).nearestDeadline).toEqual(expected);
    const searched = await service.search({ scope: 'workspace', includeExpired: true, includeLowCredibility: true }, owner, ['admin']);
    expect(searched.items.find(item => item.id === row.id)?.nearestDeadline).toEqual(expected);
    const listed = publishStatus === 'draft' ? (await service.listMyDrafts(owner)).items : await service.listPublished(500);
    expect(listed.find(item => item.id === row.id)?.nearestDeadline).toEqual(expected);
  });
  it('父截止与按日阶段同为零点时保留原文、日期精度和时区', async () => {
    const row = await prisma.competition.create({ data: {
      name: '日零点精度回归', normalizedName: randomUUID(), createdBy: owner,
      publishStatus: 'draft', nearestDeadline: new Date('2099-11-29T16:00:00.000Z'),
      stages: { create: { name: '日期精度报名', endAt: new Date('2099-11-29T16:00:00.000Z'),
        endPrecision: 'day', endTimezone: 'Asia/Shanghai', endRawText: '2099年11月30日' } },
    } });
    const service = new CompetitionService(prisma, audit, tracedParser({ enabled: false }).service);
    const expected = { at: '2099-11-29T16:00:00.000Z', precision: 'day', timezone: 'Asia/Shanghai', rawText: '2099年11月30日' };
    expect((await service.detail(row.id, owner)).nearestDeadline).toEqual(expected);
    const searched = await service.search({ scope: 'workspace', includeExpired: true, includeLowCredibility: true }, owner, ['admin']);
    expect(searched.items.find(item => item.id === row.id)?.nearestDeadline).toEqual(expected);
  });
});

async function fixture(status = 'succeeded') {
  const buffer = Buffer.from(`竞赛通知 ${randomUUID()}\n报名截止：2026年12月1日`, 'utf8');
  const key = `${randomUUID()}.txt`;
  await blobs.put(key, buffer);
  const document = await prisma.competitionDocument.create({ data: {
    ownerId: owner, fileName: '删除验证通知.txt', mimeType: 'text/plain', detectedType: 'text',
    size: buffer.length, fingerprint: createHash('sha256').update(buffer).digest('hex'),
    storageKey: key, expiresAt: new Date('2027-01-01'), parseStatus: status,
  } });
  const task = await prisma.parseTask.create({ data: { documentId: document.id, status } });
  const version = await prisma.parseResultVersion.create({ data: {
    documentId: document.id, taskId: task.id, versionNo: 1, adopted: true,
    resultJson: JSON.stringify({ extraction: { competitionName: '删除验证赛', fields: [], conflicts: [] } }),
  } });
  return { document, task, version, buffer };
}

describe('文档删除（隔离 SQLite + 本地原件）', () => {
  it('阻止其他用户删除，且不修改文件状态', async () => {
    const { document } = await fixture();
    await expect(documents.delete(document.id, 'another-user')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect((await prisma.competitionDocument.findUniqueOrThrow({ where: { id: document.id } })).status).toBe('stored');
    expect((await blobs.stat(document.storageKey)).exists).toBe(true);
  });

  it.each(['queued', 'processing'])('阻止删除 %s 任务并回滚删除预留状态', async (status) => {
    const { document } = await fixture(status);
    await expect(documents.delete(document.id, owner)).rejects.toMatchObject({ code: 'STATE_TRANSITION_INVALID' });
    expect((await prisma.competitionDocument.findUniqueOrThrow({ where: { id: document.id } })).status).toBe('stored');
    expect((await blobs.stat(document.storageKey)).exists).toBe(true);
  });

  it('删除原件、解析记录和文档关联，保留竞赛、原文依据及其他草稿附件', async () => {
    const { document, task, version } = await fixture();
    const competition = await prisma.competition.create({ data: { name: '保留竞赛', normalizedName: randomUUID(), createdBy: owner } });
    await prisma.documentCompetitionLink.create({ data: { documentId: document.id, competitionId: competition.id } });
    const evidence = await prisma.fieldEvidence.create({ data: {
      competitionId: competition.id, fieldName: 'organizer', fieldValue: '测试高校',
      sourceTitle: document.fileName, snippet: '主办单位：测试高校', parseVersionId: version.id,
    } });
    const linkedSource = await prisma.sourceMaterial.create({ data: { documentId: document.id, competitionId: competition.id, title: document.fileName } });
    const looseSource = await prisma.sourceMaterial.create({ data: { documentId: document.id, title: document.fileName } });
    const draft = await prisma.draft.create({ data: { ownerId: owner, documentIdsJson: JSON.stringify([document.id, 'keep-document']), expiresAt: new Date('2027-01-01') } });

    await expect(documents.delete(document.id, owner)).resolves.toEqual({ deleted: true });
    expect((await blobs.stat(document.storageKey)).exists).toBe(false);
    expect(await prisma.competitionDocument.findUnique({ where: { id: document.id } })).toBeNull();
    expect(await prisma.parseTask.findUnique({ where: { id: task.id } })).toBeNull();
    expect(await prisma.parseResultVersion.findUnique({ where: { id: version.id } })).toBeNull();
    expect(await prisma.documentCompetitionLink.count({ where: { documentId: document.id } })).toBe(0);
    expect(await prisma.competition.findUnique({ where: { id: competition.id } })).toMatchObject({ name: '保留竞赛' });
    expect(await prisma.fieldEvidence.findUnique({ where: { id: evidence.id } })).toMatchObject({ snippet: '主办单位：测试高校', fieldValue: '测试高校', sourceTitle: document.fileName, parseVersionId: null });
    expect(await prisma.sourceMaterial.findUnique({ where: { id: linkedSource.id } })).toMatchObject({ competitionId: competition.id, documentId: null });
    expect(await prisma.sourceMaterial.findUnique({ where: { id: looseSource.id } })).toBeNull();
    expect(await prisma.draft.findUnique({ where: { id: draft.id } })).toMatchObject({ documentIdsJson: '["keep-document"]', version: 2 });
    expect(await prisma.auditEntry.count({ where: { action: 'document.delete', objectId: document.id } })).toBe(1);
    expect((await documents.list(owner)).some(({ id }) => id === document.id)).toBe(false);
    await expect(documents.readFile(document.id, owner, Date.now(), 'old-link')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('删除后再次上传相同内容会创建新文档并启动解析', async () => {
    const { document, buffer } = await fixture();
    await documents.delete(document.id, owner);
    const result = await documents.upload([{ originalname: '重新上传.txt', mimetype: 'text/plain', size: buffer.length, buffer }], owner);
    expect(result.accepted).toBe(1);
    expect(result.results[0].documentId).not.toBe(document.id);
    expect(result.results[0].deduplicated).not.toBe(true);
    expect(enqueue).toHaveBeenCalledWith(result.results[0].documentId, 'auto');
  });

  it('原件删除失败保留可重试状态，并阻止旧下载、核对、解析和重复上传', async () => {
    const { document, task, buffer } = await fixture();
    vi.mocked(storage.delete).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(documents.delete(document.id, owner)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect((await blobs.stat(document.storageKey)).exists).toBe(true);
    expect((await documents.list(owner)).find(({ id }) => id === document.id)).toMatchObject({ deletionPending: true, fileUrl: '' });
    const parse = new ParseService(prisma, storage, {} as ParserClient, {} as ExtractionService);
    await expect(parse.enqueue(document.id, 'reparse', owner)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(parse.preview(task.id, owner)).rejects.toMatchObject({ code: 'PARSE_TASK_NOT_FOUND' });
    expect(await parse.getResultVersion(task.id, owner)).toBeNull();
    expect((await parse.listTasks(undefined, owner)).some((row) => (row as { documentId: string }).documentId === document.id)).toBe(false);
    await expect(documents.readFile(document.id, owner, Date.now(), 'old-link')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    const result = await documents.upload([{ originalname: document.fileName, mimetype: 'text/plain', size: buffer.length, buffer }], owner);
    expect(result.results[0]).toMatchObject({ accepted: false, reasonCode: 'STATE_TRANSITION_INVALID' });
    await expect(documents.delete(document.id, owner)).resolves.toEqual({ deleted: true });
    expect(await prisma.competitionDocument.findUnique({ where: { id: document.id } })).toBeNull();
  });

  it('数据库清理失败后可以重试，即使原件已移除', async () => {
    const { document } = await fixture();
    let transactions = 0;
    const client = { $transaction: (callback: Parameters<PrismaService['$transaction']>[0]) => {
      if (++transactions === 2) throw new Error('temporary database failure');
      return prisma.$transaction(callback as never);
    } } as unknown as PrismaService;
    await expect(service(client).delete(document.id, owner)).rejects.toThrow('temporary database failure');
    expect((await blobs.stat(document.storageKey)).exists).toBe(false);
    expect((await prisma.competitionDocument.findUniqueOrThrow({ where: { id: document.id } })).status).toBe('deleting');
    await expect(documents.delete(document.id, owner)).resolves.toEqual({ deleted: true });
  });

  it('缺少原件时仍可完成清理，不存在的文档返回 404', async () => {
    const { document } = await fixture();
    await blobs.delete(document.storageKey);
    await expect(documents.delete(document.id, owner)).resolves.toEqual({ deleted: true });
    await expect(documents.delete(document.id, owner)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('删除发生在核对和入库之间时拒绝过期确认，避免生成失去依据的竞赛', async () => {
    const { document, task, version } = await fixture();
    const parse = new ParseService(prisma, storage, {} as ParserClient, {} as ExtractionService);
    const saved = await parse.getResultVersion(task.id, owner);
    await documents.delete(document.id, owner);
    const competitionService = new CompetitionService(prisma, audit, { getResultVersion: async () => saved } as unknown as ParseService);
    await expect(competitionService.confirmFromParse(task.id, { resultVersionId: version.id }, owner)).rejects.toMatchObject({ code: 'STATE_TRANSITION_INVALID' });
    expect(await prisma.competition.count({ where: { name: '删除验证赛' } })).toBe(0);
  });
});
