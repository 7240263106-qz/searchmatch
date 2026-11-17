import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function fourElementKey(seriesId: string, editionId: string, trackId: string, groupKey = '__none__'): string {
  return createHash('sha256').update(`${seriesId}|${editionId}|${trackId}|${groupKey}`).digest('hex');
}

function baseNameOf(name: string): string {
  return name.replace(/·[^·]+$/, '').trim();
}

function statusRank(status: string): number {
  return { published: 4, pending_review: 3, draft: 2, unpublished: 1 }[status] ?? 0;
}

async function main(): Promise<void> {
  const rows = await prisma.competition.findMany({
    where: { parentId: null, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.seriesId ?? 'none'}|${row.editionId ?? 'none'}|${baseNameOf(row.name)}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  let mergedParents = 0;
  let attachedChildren = 0;

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const trackIds = new Set(group.map((row) => row.trackId).filter(Boolean));
    if (trackIds.size < 2) continue;

    const first = group[0];
    if (!first?.seriesId || !first?.editionId) continue;

    const baseName = baseNameOf(first.name);
    const parentKey = fourElementKey(first.seriesId, first.editionId, '__parent__');

    let parent = await prisma.competition.findFirst({
      where: { fourElementKey: parentKey, deletedAt: null },
    });

    const publishedRows = group.filter((row) => row.publishStatus === 'published');
    const status = [...group].sort((a, b) => statusRank(b.publishStatus) - statusRank(a.publishStatus))[0]
      ?.publishStatus ?? 'draft';
    const deadlines = group
      .map((row) => row.nearestDeadline)
      .filter((value): value is Date => Boolean(value))
      .sort((a, b) => a.getTime() - b.getTime());
    const nearestDeadline = deadlines[0] ?? null;

    if (!parent) {
      parent = await prisma.competition.create({
        data: {
          name: baseName,
          normalizedName: baseName.replace(/\s+/g, ''),
          seriesId: first.seriesId,
          editionId: first.editionId,
          trackId: null,
          parentId: null,
          fourElementKey: parentKey,
          description: first.description,
          category: first.category,
          level: first.level,
          organizerLevel: first.organizerLevel,
          completeness: first.completeness,
          credibility: first.credibility,
          credibilityScore: first.credibilityScore,
          credibilityBasis: first.credibilityBasis,
          registrationStatus: first.registrationStatus,
          nearestDeadline,
          signupMethod: first.signupMethod,
          signupUrl: first.signupUrl,
          eligibilityJson: first.eligibilityJson,
          dataOrigin: first.dataOrigin,
          verificationBatchId: first.verificationBatchId,
          publishStatus: status,
          publishedAt: publishedRows[0]?.publishedAt ?? null,
          createdBy: 'migration',
        },
      });
      mergedParents += 1;
    } else {
      await prisma.competition.update({
        where: { id: parent.id },
        data: { nearestDeadline, publishStatus: status, updatedAt: new Date() },
      });
    }

    const firstStage = await prisma.registrationStage.findFirst({ where: { competitionId: first.id } });
    const existingStage = await prisma.registrationStage.findFirst({ where: { competitionId: parent.id } });
    if (firstStage && !existingStage) {
      await prisma.registrationStage.create({
        data: {
          competitionId: parent.id,
          name: firstStage.name,
          stageType: firstStage.stageType,
          startAt: firstStage.startAt,
          startPrecision: firstStage.startPrecision,
          startTimezone: firstStage.startTimezone,
          startRawText: firstStage.startRawText,
          endAt: firstStage.endAt,
          endPrecision: firstStage.endPrecision,
          endTimezone: firstStage.endTimezone,
          endRawText: firstStage.endRawText,
          applicableTo: firstStage.applicableTo,
          sortOrder: 0,
        },
      });
    }

    const firstSource = await prisma.sourceMaterial.findFirst({ where: { competitionId: first.id } });
    const existingSource = await prisma.sourceMaterial.findFirst({ where: { competitionId: parent.id } });
    if (firstSource && !existingSource) {
      await prisma.sourceMaterial.create({
        data: {
          competitionId: parent.id,
          type: firstSource.type,
          title: firstSource.title,
          url: firstSource.url,
          ownerId: firstSource.ownerId,
        },
      });
    }

    const updated = await prisma.competition.updateMany({
      where: { id: { in: group.map((row) => row.id) } },
      data: { parentId: parent.id },
    });
    attachedChildren += updated.count;
  }

  const total = await prisma.competition.count({ where: { deletedAt: null } });
  const parents = await prisma.competition.count({ where: { deletedAt: null, parentId: null } });
  console.log(`merged parents: ${mergedParents}, attached children: ${attachedChildren}`);
  console.log(`competitions total: ${total}, top-level: ${parents}, children: ${total - parents}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });