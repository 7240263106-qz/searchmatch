import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function seriesKey(seriesId: string): string {
  return createHash('sha256').update(`${seriesId}|__edition__|__series__|__none__`).digest('hex');
}

async function main(): Promise<void> {
  const series = await prisma.competitionSeries.findFirst({
    where: { normalizedName: { contains: '蓝桥杯' } },
  });
  if (!series) {
    console.log('no lanqiao series found');
    return;
  }

  const rows = await prisma.competition.findMany({
    where: { seriesId: series.id, parentId: null, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`top-level lanqiao rows: ${rows.length}`);
  for (const row of rows) console.log(`- ${row.name}`);

  if (rows.length === 0) return;

  const existingSeriesParent = rows.find((row) => row.fourElementKey === seriesKey(series.id));
  const targets = existingSeriesParent
    ? rows.filter((row) => row.id !== existingSeriesParent.id)
    : rows;

  const key = seriesKey(series.id);
  let parent = existingSeriesParent;
  if (!parent) {
    const first = rows[0];
    if (!first) return;
    const published = rows.filter((row) => row.publishStatus === 'published');
    const earliest = published
      .map((row) => row.publishedAt)
      .filter((value): value is Date => Boolean(value))
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

    parent = await prisma.competition.create({
      data: {
        name: series.name,
        normalizedName: series.normalizedName,
        seriesId: series.id,
        editionId: null,
        trackId: null,
        parentId: null,
        fourElementKey: key,
        description: `蓝桥杯系列聚合父记录，包含 ${rows.length} 个公告/赛道子项。`,
        category: first.category,
        level: first.level,
        organizerLevel: first.organizerLevel,
        completeness: first.completeness,
        credibility: first.credibility,
        credibilityScore: first.credibilityScore,
        credibilityBasis: first.credibilityBasis,
        registrationStatus: 'undetermined',
        publishStatus: published.length > 0 ? 'published' : 'draft',
        publishedAt: earliest,
        dataOrigin: first.dataOrigin,
        createdBy: 'migration',
      },
    });
    console.log(`created series parent: ${parent.id}`);
  }

  const updated = await prisma.competition.updateMany({
    where: { id: { in: targets.map((row) => row.id) } },
    data: { parentId: parent.id },
  });
  console.log(`attached ${updated.count} announcements under ${parent.name}`);

  const firstStage = targets[0]
    ? await prisma.registrationStage.findFirst({ where: { competitionId: targets[0].id } })
    : null;
  const hasStage = await prisma.registrationStage.findFirst({ where: { competitionId: parent.id } });
  if (firstStage && !hasStage) {
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

  const top = await prisma.competition.count({ where: { deletedAt: null, parentId: null } });
  const total = await prisma.competition.count({ where: { deletedAt: null } });
  console.log(`now: top-level=${top}, total=${total}, children=${total - top}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });