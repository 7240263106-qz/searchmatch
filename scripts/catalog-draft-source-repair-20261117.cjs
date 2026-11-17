// Narrow repair identified by post-write verification: native URL encoding.
const fs = require('node:fs');
const root = '/opt/competition-sj/current/apps/api';
require(root + '/node_modules/reflect-metadata');
const { PrismaClient } = require(root + '/node_modules/@prisma/client');
const { AuditService } = require(root + '/dist/platform/audit.module');
const prisma = new PrismaClient();
const audit = new AuditService(prisma);
const directory = '/opt/competition-sj/shared/catalog-draft-audit-20261117';
const m = JSON.parse(fs.readFileSync(directory + '/review-manifest.json', 'utf8'));
const execution = JSON.parse(fs.readFileSync(directory + '/execution.json', 'utf8'));
async function main() {
  const d = m.rows.find(r => r.index === 49);
  const prior = execution.rows.find(r => r.index === 49);
  const url = new URL(d.pages[0].url).href;
  const row = await prisma.competition.findUniqueOrThrow({ where: { id: d.id } });
  const source = await prisma.sourceMaterial.findFirstOrThrow({ where: { competitionId: d.id, url } });
  if (row.versionNo !== prior.after.versionNo || source.type !== 'other') throw new Error('Repair target drifted; inspect');
  await prisma.$transaction(async tx => {
    const changed = await tx.competition.updateMany({ where: { id: d.id, versionNo: row.versionNo }, data: { versionNo: { increment: 1 } } });
    if (changed.count !== 1) throw new Error('Concurrent update');
    await tx.sourceMaterial.update({ where: { id: source.id }, data: { type: 'official_site' } });
    await tx.competitionVersion.create({ data: { competitionId: d.id, versionNo: row.versionNo + 1,
      actor: 'u-demo', reason: '补录回读：中文附件地址经URL编码，补正官方来源分类',
      changesJson: JSON.stringify([{ field: 'sourceMaterial.type', sourceId: source.id, before: 'other', after: 'official_site' }]) } });
    await tx.outboxEvent.create({ data: { eventType: 'competition.updated', objectType: 'competition', objectId: d.id,
      payloadJson: JSON.stringify({ source: m.reviewId, sourceClassificationCorrected: true }) } });
  });
  await audit.record({ actorId: 'u-demo', action: 'competition.source_classification_correction',
    objectType: 'competition', objectId: d.id, detail: { sourceId: source.id, url, before: 'other', after: 'official_site' } });
  const verified = await prisma.sourceMaterial.findUniqueOrThrow({ where: { id: source.id } });
  if (verified.type !== 'official_site') throw new Error('Repair readback failed');
  execution.postVerificationRepairs = [{ id: d.id, sourceId: source.id, before: 'other', after: verified.type,
    expectedVersion: row.versionNo, newVersion: row.versionNo + 1, verifiedAt: new Date().toISOString() }];
  fs.writeFileSync(directory + '/execution.json', JSON.stringify(execution, null, 2));
  console.log(JSON.stringify({ repaired: 1, version: row.versionNo + 1, verified: true }));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
