const fs = require('node:fs'), path = require('node:path');
const root = process.env.REPAIR_API_ROOT || path.resolve(__dirname, '../apps/api');
require(path.join(root, 'node_modules/reflect-metadata'));
const { PrismaClient } = require(path.join(root, 'node_modules/@prisma/client'));
const { AuditService } = require(path.join(root, 'dist/platform/audit.module'));
const directory = process.env.REPAIR_DIR || path.resolve(__dirname, '../artifacts/competition-information-repair-20261117');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'supplement-manifest.json'), 'utf8'));
const resultFile = path.join(directory, process.env.REPAIR_SUP_RESULT || 'supplement-execution.json');
const prisma = new PrismaClient(), actor = 'system:information-repair-ai-assisted';
async function main() {
  for (const d of manifest.rows) {
    const r = await prisma.competition.findUniqueOrThrow({ where: { id: d.id } });
    if (r.name !== d.name || r.versionNo !== d.expectedVersion || r.publishStatus !== d.publishStatus) throw new Error('Version drift');
  }
  if (!process.argv.includes('--apply')) return console.log(JSON.stringify({ prepared: manifest.rows.length }));
  if (fs.existsSync(resultFile)) throw new Error('Result exists; inspect before recovery');
  const result = { repairId: manifest.repairId, rows: [] };
  const save = () => fs.writeFileSync(resultFile, JSON.stringify(result, null, 2)); save();
  for (const d of manifest.rows) {
    const item = { index: d.index, id: d.id, status: 'running' }; result.rows.push(item); save();
    try {
      await prisma.$transaction(async tx => {
        const r = await tx.competition.findUniqueOrThrow({ where: { id: d.id } });
        const data = { versionNo: { increment: 1 } };
        if (d.key === 'eligibility') data.eligibilityJson = JSON.stringify({ ...JSON.parse(r.eligibilityJson), eligibility: d.value });
        else if (d.key === 'organizers') {
          for (const name of d.value) {
            const normalizedName = name.replace(/\s+/g, '').toLowerCase();
            const o = await tx.organizer.upsert({ where: { normalizedName }, update: {}, create: { name, normalizedName } });
            await tx.competitionOrganizer.upsert({ where: { competitionId_organizerId_role: { competitionId: d.id, organizerId: o.id, role: 'host' } },
              update: {}, create: { competitionId: d.id, organizerId: o.id, role: 'host' } });
          }
        } else throw new Error('Unexpected field');
        const reserved = await tx.competition.updateMany({ where: { id: d.id, versionNo: d.expectedVersion, publishStatus: d.publishStatus }, data });
        if (reserved.count !== 1) throw new Error('Concurrent edit');
        let source = await tx.sourceMaterial.findFirst({ where: { competitionId: d.id, url: d.evidence.url } });
        if (!source) source = await tx.sourceMaterial.create({ data: { competitionId: d.id, title: d.evidence.title, type: d.evidence.sourceType, url: d.evidence.url, ownerId: actor } });
        await tx.fieldEvidence.create({ data: { competitionId: d.id, fieldName: d.key === 'organizers' ? 'organizer' : d.key,
          fieldValue: typeof d.value === 'string' ? d.value : JSON.stringify(d.value), sourceId: source.id, sourceTitle: d.evidence.title,
          snippet: d.evidence.snippet, extractMethod: 'manual', manuallyCorrected: true, confidence: 'medium', fieldState: 'explicit',
          locationJson: JSON.stringify({ kind: 'web', url: d.evidence.url, scope: d.scope, repairId: manifest.repairId, sha256: d.evidence.sha256 }) } });
        const comment = `【${manifest.repairId}】最终原文交叉检查补录${d.key}，适用范围${d.scope}；此前缺口按本次证据更新。AI辅助复核，保留发布状态，不以局部资格冒充全国完整。`;
        await tx.reviewRecord.create({ data: { competitionId: d.id, action: 'comment', reviewer: actor, comment } });
        await tx.competitionVersion.create({ data: { competitionId: d.id, versionNo: d.expectedVersion + 1, actor,
          reason: manifest.repairId + ' 最终原文交叉检查补录', changesJson: JSON.stringify([{ field: d.key, before: d.key === 'eligibility' ? r.eligibilityJson : null, after: d.value, scope: d.scope }]) } });
        await tx.outboxEvent.create({ data: { eventType: 'competition.updated', objectType: 'competition', objectId: d.id,
          payloadJson: JSON.stringify({ repairId: manifest.repairId, field: d.key, publication: 'unchanged' }) } });
        await new AuditService(tx).record({ actorId: actor, action: 'competition.information_repair_supplement', objectType: 'competition', objectId: d.id,
          detail: { repairId: manifest.repairId, field: d.key, scope: d.scope, versionNo: d.expectedVersion + 1 } });
      });
      item.status = 'completed'; item.versionNo = d.expectedVersion + 1;
    } catch (e) { item.status = 'failed'; item.error = e.message; save(); throw e; }
    save();
  }
  result.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify({ completed: result.rows.length }));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
