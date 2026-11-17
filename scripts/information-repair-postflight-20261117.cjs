/* Correct two issues found by contract-level readback; never replay the main repair. */
const fs = require('node:fs');
const path = require('node:path');
const apiRoot = process.env.REPAIR_API_ROOT || path.resolve(__dirname, '../apps/api');
require(path.join(apiRoot, 'node_modules/reflect-metadata'));
const { PrismaClient } = require(path.join(apiRoot, 'node_modules/@prisma/client'));
const { AuditService } = require(path.join(apiRoot, 'dist/platform/audit.module'));
const { computeCredibility } = require(path.join(apiRoot, 'dist/domain/quality'));
const directory = process.env.REPAIR_DIR || path.resolve(__dirname, '../artifacts/competition-information-repair-20261117');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'repair-manifest.json'), 'utf8'));
const actorId = 'system:information-repair-ai-assisted';
const prisma = new PrismaClient();
const resultFile = path.join(directory, process.env.REPAIR_POST_RESULT || 'postflight-execution.json');
const apply = process.argv.includes('--apply');
const save = r => fs.writeFileSync(resultFile, JSON.stringify(r, null, 2));

function delta(row, d) {
  const parsed = JSON.parse(row.eligibilityJson || '{}');
  const data = {};
  if (parsed.informationRepairScope?.repairId === manifest.repairId) {
    delete parsed.informationRepairScope;
    data.eligibilityJson = JSON.stringify(parsed); // Scope remains in field evidence and the review log.
  }
  const types = [...new Set([...row.sources.map(s => s.type), ...d.fields.map(f => f.evidence.sourceType)])];
  const q = computeCredibility({ sourceTypes: types, completeness: row.completeness, distinctSourceCount: 1, reviewed: true });
  if (q.score !== row.credibilityScore || q.level !== row.credibility) {
    Object.assign(data, { credibility: q.level, credibilityScore: q.score,
      credibilityBasis: q.basis.map(s => s.replace('已人工审核', '已逐项复核原文（AI辅助）')).join('；') +
        '；综合原有审核来源和本轮新增来源；来源可信度不代表字段完整或报名开放；未验证真实提交。' });
  }
  return data;
}

async function main() {
  const prepared = [];
  for (const d of manifest.rows) {
    const row = await prisma.competition.findUniqueOrThrow({ where: { id: d.id }, include: { sources: true } });
    if (row.versionNo !== d.expectedVersion + 1 || row.publishStatus !== d.publishStatus) throw new Error(`Version drift: ${d.index}`);
    const data = delta(row, d);
    if (Object.keys(data).length) prepared.push({ d, data });
  }
  console.log(JSON.stringify({ prepared: prepared.length, eligibilityCleanups: prepared.filter(p => p.data.eligibilityJson).length,
    credibilityCorrections: prepared.filter(p => p.data.credibility).length, mode: apply ? 'apply' : 'read_only' }));
  if (!apply) return;
  if (fs.existsSync(resultFile)) throw new Error('Result exists; inspect before recovery');
  const result = { repairId: manifest.repairId + '.1', startedAt: new Date().toISOString(), rows: [] }; save(result);
  for (const { d, data } of prepared) {
    const item = { index: d.index, id: d.id, status: 'running' }; result.rows.push(item); save(result);
    try {
      await prisma.$transaction(async tx => {
        const row = await tx.competition.findUniqueOrThrow({ where: { id: d.id } });
        const changes = Object.entries(data).map(([field, after]) => ({ field, before: row[field], after }));
        const updated = await tx.competition.updateMany({ where: { id: d.id, versionNo: d.expectedVersion + 1, publishStatus: d.publishStatus },
          data: { ...data, versionNo: { increment: 1 } } });
        if (updated.count !== 1) throw new Error('Concurrent edit');
        await tx.competitionVersion.create({ data: { competitionId: d.id, versionNo: d.expectedVersion + 2, actor: actorId,
          reason: 'FIX-20261117-02.1 验收修正：资格展示保持字符串契约，可信度综合全部既有审核来源', changesJson: JSON.stringify(changes) } });
        await tx.reviewRecord.create({ data: { competitionId: d.id, action: 'comment', reviewer: actorId,
          comment: '【FIX-20261117-02.1】验收发现并修正：范围元数据仅存证据，不混入资格字符串；可信度综合原有及本轮来源，不因本轮仅补充高校通知忽略原有官方来源。未补充独立来源一致性分；保留日期冲突及发布状态。' } });
        await tx.outboxEvent.create({ data: { eventType: 'competition.updated', objectType: 'competition', objectId: d.id,
          payloadJson: JSON.stringify({ repairId: 'FIX-20261117-02.1', fields: Object.keys(data), publication: 'unchanged' }) } });
        await new AuditService(tx).record({ actorId, action: 'competition.information_repair_postflight', objectType: 'competition', objectId: d.id,
          detail: { repairId: 'FIX-20261117-02.1', fields: Object.keys(data), versionNo: d.expectedVersion + 2 } });
      });
      Object.assign(item, { status: 'completed', fields: Object.keys(data), versionNo: d.expectedVersion + 2 });
    } catch (error) { item.status = 'failed'; item.error = error.message; save(result); throw error; }
    save(result);
  }
  result.finishedAt = new Date().toISOString(); save(result); console.log(JSON.stringify({ completed: result.rows.length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
