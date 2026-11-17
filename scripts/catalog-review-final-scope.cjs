require('../apps/api/node_modules/reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('../apps/api/node_modules/@prisma/client');
const { CompetitionService } = require('../apps/api/dist/services/competition.service');
const { AuditService } = require('../apps/api/dist/platform/audit.module');
const { directory, decisions, page } = require('./catalog-review-decisions.cjs');

const prisma = new PrismaClient();
const audit = new AuditService(prisma);
const service = new CompetitionService(prisma, audit, null);
const resultFile = path.join(directory, 'final-scope-execution.json');
const actor = 'u-demo';
const notes = new Map([
  [22, '现有报名入口仅对应数字化设计与制造分赛；其他赛项请核对各自通知和报名入口。'],
  [29, '现有报名入口仅对应西北赛区，其他赛区及赛道的报名入口、截止时间请分别核实。'],
]);

async function main() {
  if (fs.existsSync(resultFile)) throw new Error('已有最终范围修正记录，请先核查，禁止盲目重复执行');
  const report = { startedAt: new Date().toISOString(), rows: [] };
  for (const [index, signupNote] of notes) {
    const decision = decisions.find(item => item.index === index);
    let row = await prisma.competition.findUniqueOrThrow({ where: { id: decision.id } });
    const result = { index, id: row.id, name: row.name, beforeVersion: row.versionNo, status: 'running' };
    report.rows.push(result);
    fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
    if (index === 29) {
      const previousCount = decision.pages.length;
      page(29, 'https://psat.yangtzeu.edu.cn/info/1026/1579.htm', [[
        'scheduleNote',
        '第十四届创意赛道原通知：全国竞赛拟于2026年6月下旬在长春举行，具体时间另行通知；采用区赛晋级国赛制，各赛区报名与区赛安排分别公布。原4月19日及西北报名入口仅适用于西北区，不设全赛事统一截止。',
        '全国大学生光电设计竞赛由中国光学学会主办', '四、参赛项目要求',
      ]]);
      const source = decision.pages[previousCount];
      if (source.fields.length !== 1) throw new Error('光电赛程的原文引文不完整');
      const saved = await service.saveDiscoveryFields(row.id, row.versionNo, source, actor, ['editor', 'reviewer', 'admin']);
      result.saved = { url: source.url, fields: source.fields, versionNo: saved.versionNo };
      fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
      row = await prisma.competition.findUniqueOrThrow({ where: { id: row.id } });
      if (row.versionNo !== saved.versionNo) throw new Error('赛程保存后出现并发更新，停止后续写入');
    }
    await prisma.$transaction(async tx => {
      const reserved = await tx.competition.updateMany({
        where: { id: row.id, versionNo: row.versionNo, deletedAt: null },
        data: { signupNote, versionNo: { increment: 1 } },
      });
      if (reserved.count !== 1) throw new Error('并发版本冲突，停止范围修正');
      await tx.signupEntry.updateMany({ where: { competitionId: row.id, url: row.signupUrl }, data: { note: signupNote } });
      const sourceEvidence = await tx.fieldEvidence.findFirst({
        where: { competitionId: row.id, fieldName: 'signupUrl', sourceId: { not: null } },
        orderBy: { createdAt: 'desc' },
      });
      if (!sourceEvidence) throw new Error('缺少报名入口的原始证据');
      await tx.fieldEvidence.create({ data: {
        competitionId: row.id, fieldName: 'signupNote', fieldValue: signupNote,
        sourceId: sourceEvidence.sourceId, sourceTitle: sourceEvidence.sourceTitle,
        snippet: sourceEvidence.snippet, locationJson: sourceEvidence.locationJson,
        extractMethod: 'manual', confidence: 'medium', manuallyCorrected: true,
      } });
      await tx.competitionVersion.create({ data: {
        competitionId: row.id, versionNo: row.versionNo + 1, actor,
        reason: '竞赛逐项审核：明确报名入口范围',
        changesJson: JSON.stringify([{ field: 'signupNote', before: row.signupNote, after: signupNote }]),
      } });
      await tx.reviewRecord.create({ data: { competitionId: row.id, action: 'comment', reviewer: actor,
        comment: `审核补正：${signupNote}${index === 29 ? '赛程已替换为标明创意赛道、原通知拟定范围的全国安排。' : ''}` } });
      await tx.outboxEvent.create({ data: { eventType: 'competition.updated', objectType: 'competition',
        objectId: row.id, payloadJson: JSON.stringify({ source: 'catalog_review_final_scope', fields: ['signupNote'] }) } });
    });
    await audit.record({ actorId: actor, action: 'competition.catalog_review_scope', objectType: 'competition',
      objectId: row.id, detail: { index, signupNote } });
    const verified = await prisma.competition.findUniqueOrThrow({ where: { id: row.id }, include: { entries: true } });
    if (verified.signupNote !== signupNote || verified.entries.some(entry => entry.url === verified.signupUrl && entry.note !== signupNote)) {
      throw new Error('报名范围保存后的回读校验失败');
    }
    Object.assign(result, { status: 'completed', afterVersion: verified.versionNo,
      scheduleNote: verified.scheduleNote, signupNote: verified.signupNote, nearestDeadline: verified.nearestDeadline });
    fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
