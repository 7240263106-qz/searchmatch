require('../apps/api/node_modules/reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('../apps/api/node_modules/@prisma/client');
const { CompetitionService } = require('../apps/api/dist/services/competition.service');
const { AuditService } = require('../apps/api/dist/platform/audit.module');
const { computeCredibility } = require('../apps/api/dist/domain/quality');
const { directory, decisions } = require('./catalog-review-decisions.cjs');

const prisma = new PrismaClient();
const audit = new AuditService(prisma);
const service = new CompetitionService(prisma, audit, null);
const actorId = 'u-demo';
const roles = ['editor', 'reviewer', 'admin'];
const manifestFile = path.join(directory, 'review-manifest.json');
const resultFile = path.join(directory, 'execution.json');
const mode = process.argv.includes('--apply') ? 'apply' : 'prepare';
const snapshot = row => ({ id: row.id, versionNo: row.versionNo, name: row.name, publishStatus: row.publishStatus,
  nearestDeadline: row.nearestDeadline?.toISOString() ?? null, description: row.description,
  scheduleNote: row.scheduleNote, eligibilityJson: row.eligibilityJson, credibility: row.credibility,
  credibilityScore: row.credibilityScore, signupUrl: row.signupUrl, completeness: row.completeness });
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

async function current(id) {
  return prisma.competition.findUniqueOrThrow({ where: { id }, include: {
    sources: true, stages: true, fieldEvidence: true, organizers: { include: { organizer: true } },
  } });
}

async function prepare() {
  const manifest = { preparedAt: new Date().toISOString(), mode: 'reviewed_fields_only', rows: [] };
  for (const decision of decisions) {
    const row = await current(decision.id);
    if (row.name !== decision.name || row.deletedAt || row.parentId || row.demoFlag) {
      throw new Error(`记录身份已改变：${decision.index}`);
    }
    const reviewedEvidence = row.fieldEvidence.filter(field => field.sourceId && field.snippet
      && ['description', 'eligibility', 'organizer', 'schedule', 'nearestDeadline'].includes(field.fieldName)
      && !decision.rejectFields.includes(field.fieldName));
    if (decision.decision === 'publish' && !decision.pages.some(page => page.fields.length)
      && !reviewedEvidence.length && !row.fieldEvidence.some(field => field.fieldName === 'discoveryTracks')) {
      throw new Error(`缺少发布的实质证据：${decision.index}`);
    }
    manifest.rows.push({ ...decision, before: snapshot(row), expectedVersion: row.versionNo,
      existingSources: row.sources.map(source => ({ id: source.id, type: source.type, title: source.title, url: source.url })) });
  }
  write(manifestFile, manifest);
  console.log(JSON.stringify({ mode, total: manifest.rows.length,
    approved: manifest.rows.filter(row => row.decision === 'publish').length,
    held: manifest.rows.filter(row => row.decision === 'hold').length,
    fields: manifest.rows.flatMap(row => row.pages).flatMap(page => page.fields).length,
    clearedDeadlines: manifest.rows.filter(row => row.clearDeadline).map(row => row.index), manifestFile }));
}

async function corrections(decision, expectedVersion) {
  const now = new Date().toISOString();
  await prisma.$transaction(async tx => {
    const row = await tx.competition.findUniqueOrThrow({ where: { id: decision.id } });
    const updated = await tx.competition.updateMany({
      where: { id: row.id, versionNo: expectedVersion, deletedAt: null },
      data: { versionNo: { increment: 1 }, ...(decision.clearDeadline
        ? { nearestDeadline: null, registrationStatus: 'undetermined' } : {}) },
    });
    if (!updated.count) throw new Error('并发更新，停止该记录写入');
    const rejected = await tx.fieldEvidence.findMany({ where: { competitionId: row.id,
      OR: [{ fieldName: { in: decision.rejectFields } }, ...(decision.index === 63
        ? [{ fieldName: 'nearestDeadline', snippet: { contains: '2025' }, fieldValue: { contains: '2026' } }] : [])] } });
    for (const field of rejected) {
      let location;
      try { location = JSON.parse(field.locationJson ?? '{}'); } catch { location = { original: field.locationJson }; }
      await tx.fieldEvidence.update({ where: { id: field.id }, data: {
        fieldName: `reviewRejected:${field.fieldName}`, fieldState: 'to_confirm', manuallyCorrected: true,
        locationJson: JSON.stringify({ ...location, review: { at: now, reason: decision.reason, originalField: field.fieldName } }),
      } });
    }
    if (decision.clearDeadline) {
      await tx.registrationStage.updateMany({ where: { competitionId: row.id, stageType: 'official' },
        data: { endAt: null, endPrecision: 'unknown', endRawText: null } });
    }
    await tx.competitionVersion.create({ data: { competitionId: row.id, versionNo: expectedVersion + 1,
      actor: actorId, reason: '竞赛目录逐项审核：日期范围与无效证据纠正', changesJson: JSON.stringify([
        ...(decision.clearDeadline ? [{ field: 'nearestDeadline', before: row.nearestDeadline, after: null }] : []),
        { field: 'evidenceReview', rejectedIds: rejected.map(field => field.id), reason: decision.reason },
      ]) } });
    await tx.outboxEvent.create({ data: { eventType: 'competition.updated', objectType: 'competition', objectId: row.id,
      payloadJson: JSON.stringify({ source: 'catalog_review_20261117', correctedDateScope: decision.dateScope }) } });
  });
  await audit.record({ actorId, action: 'competition.catalog_review_correction', objectType: 'competition',
    objectId: decision.id, detail: { reason: decision.reason, clearDeadline: decision.clearDeadline,
      rejectedFields: decision.rejectFields, dateScope: decision.dateScope } });
}

async function finishReview(decision, expectedVersion) {
  await prisma.$transaction(async tx => {
    const row = await tx.competition.findUniqueOrThrow({ where: { id: decision.id }, include: { sources: true } });
    if (row.versionNo !== expectedVersion) throw new Error('审核前有并发更新，停止该记录');
    for (const page of decision.pages.filter(page => page.official)) {
      await tx.sourceMaterial.updateMany({ where: { competitionId: row.id, url: page.url }, data: { type: 'official_site' } });
    }
    const sources = await tx.sourceMaterial.findMany({ where: { competitionId: row.id } });
    const quality = computeCredibility({ sourceTypes: sources.map(source => source.type),
      completeness: row.completeness, distinctSourceCount: 1, reviewed: decision.decision === 'publish' });
    const data = { versionNo: { increment: 1 } };
    if (decision.decision === 'publish') Object.assign(data, { credibility: quality.level,
      credibilityScore: quality.score, credibilityBasis: quality.basis.join('；') });
    const reserved = await tx.competition.updateMany({ where: { id: row.id, versionNo: expectedVersion }, data });
    if (!reserved.count) throw new Error('审核保存版本冲突');
    const missing = [
      ...(!row.nearestDeadline ? ['全国统一报名截止未确定或不适用于聚合赛事'] : []),
      ...(!row.signupUrl ? ['直达报名入口未核实'] : []),
      ...(!JSON.parse(row.eligibilityJson ?? '{}').eligibility ? ['详细参赛资格未补全'] : []),
    ];
    const result = { at: new Date().toISOString(), decision: decision.decision, reason: decision.reason,
      dateScope: decision.dateScope, missing, sourceUrls: decision.pages.map(page => page.url) };
    await tx.fieldEvidence.create({ data: { competitionId: row.id, fieldName: 'catalogReview',
      fieldValue: JSON.stringify(result), sourceTitle: '竞赛目录逐项审核记录', extractMethod: 'manual',
      manuallyCorrected: true, confidence: decision.decision === 'publish' ? 'medium' : 'low' } });
    await tx.reviewRecord.create({ data: { competitionId: row.id, action: 'comment', reviewer: actorId,
      comment: `逐项审核：${decision.decision === 'publish' ? '可靠字段审核通过，允许部分资料发布' : '暂缓发布'}。${decision.reason} 日期范围：${decision.dateScope}。未完成项：${missing.join('；') || '暂无新增缺项'}。` } });
    await tx.competitionVersion.create({ data: { competitionId: row.id, versionNo: expectedVersion + 1,
      actor: actorId, reason: '竞赛目录审核结论', changesJson: JSON.stringify([{ field: 'catalogReview', after: result },
        ...(decision.decision === 'publish' ? [{ field: 'credibilityScore', before: row.credibilityScore, after: quality.score }] : [])]) } });
    await tx.outboxEvent.create({ data: { eventType: 'competition.updated', objectType: 'competition', objectId: row.id,
      payloadJson: JSON.stringify({ source: 'catalog_review_20261117', decision: decision.decision }) } });
  });
  await audit.record({ actorId, action: 'competition.catalog_review', objectType: 'competition',
    objectId: decision.id, detail: { index: decision.index, decision: decision.decision, reason: decision.reason } });
}

async function apply() {
  if (fs.existsSync(resultFile)) throw new Error('已有执行记录；先检查 execution.json，禁止盲目重复执行');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.rows.length !== 72) throw new Error('审核数量不是72，停止');
  const execution = { startedAt: new Date().toISOString(), rows: [] };
  write(resultFile, execution);
  for (const decision of manifest.rows) {
    const result = { index: decision.index, id: decision.id, name: decision.name, decision: decision.decision,
      reason: decision.reason, dateScope: decision.dateScope, steps: [], before: decision.before, status: 'running' };
    execution.rows.push(result);
    write(resultFile, execution);
    try {
      let row = await current(decision.id);
      if (row.versionNo !== decision.expectedVersion || row.name !== decision.name) {
        throw new Error(`版本已变化：预期${decision.expectedVersion}，当前${row.versionNo}；保留用户更新`);
      }
      if (decision.clearDeadline || decision.rejectFields.length || decision.index === 63) {
        await corrections(decision, row.versionNo);
        result.steps.push('corrected');
        row = await current(decision.id);
        write(resultFile, execution);
      }
      for (const page of decision.pages) {
        const next = await service.saveDiscoveryFields(row.id, row.versionNo, page, actorId, roles);
        result.steps.push({ saved: page.url, fields: page.fields.map(field => field.key), versionNo: next.versionNo });
        row = await current(decision.id);
        write(resultFile, execution);
      }
      await finishReview(decision, row.versionNo);
      result.steps.push('reviewed');
      row = await current(decision.id);
      if (decision.decision === 'publish') {
        if (row.publishStatus === 'draft') {
          await service.submitReview(row.id, actorId, `目录逐项审核通过；${decision.reason}`);
          result.steps.push('submitted');
          write(resultFile, execution);
          row = await current(decision.id);
        }
        if (row.publishStatus === 'pending_review') {
          await service.publish(row.id, actorId, `可靠资料审核发布；${decision.reason} 日期范围：${decision.dateScope}。缺项继续标示未知。`);
          result.steps.push('published');
        }
      } else if (row.publishStatus === 'pending_review') {
        await service.reject(row.id, actorId, decision.reason);
        result.steps.push('returned_to_draft');
      }
      row = await current(decision.id);
      result.after = snapshot(row);
      result.status = 'completed';
    } catch (error) {
      result.status = 'failed';
      result.error = error.message;
      result.after = snapshot(await current(decision.id));
    }
    write(resultFile, execution);
    console.log(JSON.stringify({ index: result.index, status: result.status, error: result.error,
      publishStatus: result.after?.publishStatus, score: result.after?.credibilityScore, steps: result.steps.length }));
  }
  execution.finishedAt = new Date().toISOString();
  execution.summary = { total: execution.rows.length, completed: execution.rows.filter(row => row.status === 'completed').length,
    failed: execution.rows.filter(row => row.status === 'failed').length,
    newlyPublished: execution.rows.filter(row => row.steps.includes('published')).length,
    published: execution.rows.filter(row => row.after?.publishStatus === 'published').length,
    draft: execution.rows.filter(row => row.after?.publishStatus === 'draft').length };
  write(resultFile, execution);
  console.log(JSON.stringify(execution.summary));
}

(mode === 'apply' ? apply() : prepare()).catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
