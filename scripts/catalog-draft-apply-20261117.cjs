/* Production follow-up: native service field writes plus an append-only review. */
const fs = require('node:fs');
const path = require('node:path');
const apiRoot = process.env.CATALOG_API_ROOT || path.resolve(__dirname, '../apps/api');
require(path.join(apiRoot, 'node_modules/reflect-metadata'));
const { PrismaClient } = require(path.join(apiRoot, 'node_modules/@prisma/client'));
const { CompetitionService } = require(path.join(apiRoot, 'dist/services/competition.service'));
const { AuditService } = require(path.join(apiRoot, 'dist/platform/audit.module'));
const { computeCredibility } = require(path.join(apiRoot, 'dist/domain/quality'));
const { parseDateTime } = require(path.join(apiRoot, 'dist/domain/time'));
const directory = process.env.CATALOG_AUDIT_DIR || path.resolve(__dirname, '../artifacts/catalog-draft-audit-20261117');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'review-manifest.json'), 'utf8'));
const resultFile = path.join(directory, 'execution.json');
const prisma = new PrismaClient();
const audit = new AuditService(prisma);
const service = new CompetitionService(prisma, audit, null);
const actorId = 'u-demo';
const roles = ['editor', 'reviewer', 'admin'];
const apply = process.argv.includes('--apply');
const save = value => fs.writeFileSync(resultFile, JSON.stringify(value, null, 2));
const current = id => prisma.competition.findUniqueOrThrow({ where: { id }, include: {
  sources: true, stages: true, fieldEvidence: true, organizers: { include: { organizer: true } },
} });
const snapshot = row => ({ id: row.id, name: row.name, versionNo: row.versionNo,
  publishStatus: row.publishStatus, credibility: row.credibility, credibilityScore: row.credibilityScore,
  credibilityBasis: row.credibilityBasis, completeness: row.completeness, description: row.description,
  eligibilityJson: row.eligibilityJson, scheduleNote: row.scheduleNote,
  nearestDeadline: row.nearestDeadline?.toISOString() ?? null, signupUrl: row.signupUrl,
  signupMethod: row.signupMethod, signupNote: row.signupNote,
  stages: row.stages.map(s => ({ name: s.name, startAt: s.startAt?.toISOString() ?? null,
    endAt: s.endAt?.toISOString() ?? null, endPrecision: s.endPrecision, applicableTo: s.applicableTo })),
});

async function prepare() {
  if (manifest.rows.length !== 71 || manifest.publicationPolicy !== 'preserve') throw new Error('Unexpected review scope');
  const checks = [];
  for (const d of manifest.rows) {
    const row = await current(d.id);
    if (row.name !== d.name || row.versionNo !== d.expectedVersion || row.publishStatus !== d.publishStatus
      || row.deletedAt || row.parentId || row.demoFlag || !['A类', 'B类', 'C类'].includes(row.schoolRecognitionLevel)) {
      throw new Error(`Identity/version drift: ${d.index}`);
    }
    checks.push({ index: d.index, id: d.id, version: row.versionNo,
      fields: d.pages.flatMap(p => p.fields.map(f => f.key)), reviewOnly: !d.qualityReview });
  }
  return checks;
}

async function finish(d, expectedVersion) {
  await prisma.$transaction(async tx => {
    const row = await tx.competition.findUniqueOrThrow({ where: { id: d.id } });
    if (row.versionNo !== expectedVersion || row.publishStatus !== d.publishStatus) throw new Error('Concurrent update before review');
    for (const p of d.pages) {
      await tx.sourceMaterial.updateMany({ where: { competitionId: d.id, url: new URL(p.url).href }, data: { type: p.sourceType } });
    }
    const sourceRows = await tx.sourceMaterial.findMany({ where: { competitionId: d.id } });
    const completeness = d.completeness || row.completeness;
    const quality = d.qualityReview ? computeCredibility({ sourceTypes: sourceRows.map(s => s.type),
      completeness, distinctSourceCount: 1, reviewed: true }) : null;
    const data = { versionNo: { increment: 1 }, ...(quality ? {
      completeness, credibility: quality.level, credibilityScore: quality.score,
      credibilityBasis: quality.basis.map(text => text.replace('已人工审核', '已完成逐项证据复核（AI辅助）')).join('；')
        + (d.notes.length ? '；审核备注：' + d.notes.join(' ') : ''),
    } : {}), ...(d.signupCorrection ? {
      signupMethod: d.signupCorrection.signupMethod, signupNote: d.signupCorrection.signupNote,
    } : {}) };
    const reserved = await tx.competition.updateMany({ where: { id: d.id, versionNo: expectedVersion,
      publishStatus: d.publishStatus }, data });
    if (reserved.count !== 1) throw new Error('Review version reservation failed');
    for (const timing of d.stages) {
      const start = parseDateTime(timing.start), end = parseDateTime(timing.end);
      if (!start.at || !end.at || new Date(start.at) > new Date(end.at)) throw new Error('Invalid scoped registration window');
      const previous = await tx.registrationStage.findFirst({ where: { competitionId: d.id, stageType: 'official' },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
      if (!previous) throw new Error('Native service did not create registration stage');
      await tx.registrationStage.update({ where: { id: previous.id }, data: { name: timing.name,
        startAt: new Date(start.at), startPrecision: start.precision, startTimezone: start.timezone,
        startRawText: timing.start, endAt: new Date(end.at), endPrecision: end.precision,
        endTimezone: end.timezone, endRawText: timing.end, applicableTo: timing.applicableTo,
      } });
    }
    if (d.signupCorrection) {
      const source = sourceRows.find(s => s.url === d.signupCorrection.sourceUrl);
      await tx.fieldEvidence.create({ data: { competitionId: d.id, fieldName: 'signupMethod',
        fieldValue: d.signupCorrection.signupMethod, sourceId: source?.id,
        sourceTitle: source?.title, snippet: d.signupCorrection.quote, extractMethod: 'manual',
        manuallyCorrected: true, confidence: 'medium',
        locationJson: JSON.stringify({ kind: 'web', url: d.signupCorrection.sourceUrl }),
      } });
    }
    const review = { reviewId: manifest.reviewId, reviewedAt: new Date().toISOString(),
      reason: d.reason, notes: d.notes, publication: 'unchanged',
      sources: d.pages.map(p => ({ url: p.url, title: p.title, cacheFile: p.cacheFile,
        sha256: p.sha256, type: p.sourceType, fields: p.fields.map(f => f.key) })),
      priorWarnings: d.priorWarnings || [],
      unresolved: [
        ...(!row.nearestDeadline ? ['没有适用于父项的已核实统一报名截止；详见比赛时间说明'] : []),
        ...(!row.signupUrl && !d.signupCorrection ? ['直达报名入口未核实'] : []),
        ...(!JSON.parse(row.eligibilityJson || '{}').eligibility ? ['全国详细参赛资格仍待补核'] : []),
        ...(d.completeness === 'conflict' ? ['同一官方章程I—J报名截止存在差异'] : []),
      ],
    };
    await tx.fieldEvidence.create({ data: { competitionId: d.id, fieldName: 'catalogFollowupReview',
      fieldValue: JSON.stringify(review), sourceTitle: '2026-11-17 竞赛逐项复核与补录',
      extractMethod: 'manual', manuallyCorrected: true, confidence: quality?.level || row.credibility,
    } });
    await tx.reviewRecord.create({ data: { competitionId: d.id, action: 'comment', reviewer: actorId,
      comment: `逐项复核及联网补录：${d.reason}${d.notes.join('；')} 发布状态保持${d.publishStatus}。` } });
    await tx.competitionVersion.create({ data: { competitionId: d.id, versionNo: expectedVersion + 1,
      actor: actorId, reason: '竞赛草稿后续审核：来源、跳过原因与分范围赛程',
      changesJson: JSON.stringify([{ field: 'catalogFollowupReview', after: review },
        ...(quality ? [{ field: 'credibilityScore', before: row.credibilityScore, after: quality.score }] : []),
        ...(d.signupCorrection ? [{ field: 'signupMethod', before: row.signupMethod, after: d.signupCorrection.signupMethod }] : []),
      ]),
    } });
    await tx.outboxEvent.create({ data: { eventType: 'competition.updated', objectType: 'competition', objectId: d.id,
      payloadJson: JSON.stringify({ source: manifest.reviewId, reviewed: true, publication: 'unchanged' }) } });
  });
  await audit.record({ actorId, action: 'competition.catalog_followup_review', objectType: 'competition',
    objectId: d.id, detail: { reviewId: manifest.reviewId, index: d.index, reason: d.reason, notes: d.notes } });
}

async function main() {
  const checks = await prepare();
  console.log(JSON.stringify({ prepared: checks.length, fieldWrites: checks.flatMap(c => c.fields).length,
    reviewOnly: checks.filter(c => c.reviewOnly).length, mode: apply ? 'apply' : 'read_only' }));
  if (!apply) return;
  if (fs.existsSync(resultFile)) throw new Error('Execution exists; read results before any recovery');
  const result = { reviewId: manifest.reviewId, startedAt: new Date().toISOString(), rows: [] };
  save(result);
  for (const d of manifest.rows) {
    const execution = { index: d.index, id: d.id, name: d.name, status: 'running', steps: [] };
    result.rows.push(execution); save(result);
    try {
      let row = await current(d.id);
      execution.before = snapshot(row); save(result);
      if (row.versionNo !== d.expectedVersion || row.publishStatus !== d.publishStatus) throw new Error('Concurrent update; preserving user edit');
      for (const p of d.pages) {
        await service.saveDiscoveryFields(d.id, row.versionNo, p, actorId, roles);
        row = await current(d.id);
        execution.steps.push({ url: p.url, fields: p.fields.map(f => f.key), versionNo: row.versionNo }); save(result);
      }
      await finish(d, row.versionNo);
      row = await current(d.id);
      execution.after = snapshot(row);
      if (row.publishStatus !== d.publishStatus) throw new Error('Unexpected publication change');
      execution.status = 'completed';
    } catch (error) {
      execution.status = 'failed'; execution.error = error.message;
      execution.after = snapshot(await current(d.id));
      save(result);
      throw error; // No blind retry after a partial write.
    }
    save(result);
    console.log(JSON.stringify({ index: d.index, status: execution.status, score: execution.after.credibilityScore,
      publishStatus: execution.after.publishStatus, schedule: !!execution.after.scheduleNote }));
  }
  result.finishedAt = new Date().toISOString(); save(result);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
