import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await prisma.changeEvent.deleteMany();
  await prisma.competitionVersion.deleteMany();
  await prisma.reviewRecord.deleteMany();
  await prisma.fieldEvidence.deleteMany();
  await prisma.trackSplitRecord.deleteMany();
  await prisma.documentCompetitionLink.deleteMany();
  await prisma.sourceMaterial.deleteMany();
  await prisma.signupEntry.deleteMany();
  await prisma.registrationStage.deleteMany();
  await prisma.competitionOrganizer.deleteMany();
  await prisma.favorite.deleteMany();
  await prisma.competition.deleteMany();
  await prisma.competitionGroup.deleteMany();
  await prisma.competitionTrack.deleteMany();
  await prisma.competitionEdition.deleteMany();
  await prisma.competitionSeries.deleteMany();
  await prisma.organizer.deleteMany();
  await prisma.crawlAttachment.deleteMany();
  await prisma.rawPageSnapshot.deleteMany();
  await prisma.requestEvidence.deleteMany();
  await prisma.processingCheckpoint.deleteMany();
  await prisma.candidate.deleteMany();
  await prisma.crawlTask.deleteMany();
  await prisma.verificationBatch.deleteMany();
  await prisma.parseResultVersion.deleteMany();
  await prisma.parseTask.deleteMany();
  await prisma.competitionDocument.deleteMany();
  await prisma.draft.deleteMany();
  await prisma.agentTurn.deleteMany();
  await prisma.agentSession.deleteMany();
  await prisma.pushItem.deleteMany();
  await prisma.pushBatch.deleteMany();
  await prisma.subscriptionRule.deleteMany();
  await prisma.sourceDefinition.deleteMany();
  await prisma.outboxEvent.deleteMany();

  const officialSource = await prisma.sourceDefinition.upsert({
    where: {
      ownerKind_ownerId_normalizedAddress: {
        ownerKind: 'team',
        ownerId: 'team-demo',
        normalizedAddress: 'https://dasai.lanqiao.cn',
      },
    },
    create: {
      name: '蓝桥杯全国软件和信息技术专业人才大赛官网',
      address: 'https://dasai.lanqiao.cn/',
      normalizedAddress: 'https://dasai.lanqiao.cn',
      type: 'official_site',
      ownerKind: 'team',
      ownerId: 'team-demo',
      intervalSeconds: 86400,
      enabled: false,
      verified: false,
      whitelist: true,
      whitelistConfirmedBy: 'system',
      whitelistConfirmedAt: new Date(),
      dataOrigin: 'formal',
      attachmentEnabled: true,
    },
    update: {
      whitelist: true,
      dataOrigin: 'formal',
    },
  });

  const counts = {
    competitions: await prisma.competition.count(),
    candidates: await prisma.candidate.count(),
    drafts: await prisma.draft.count(),
    favorites: await prisma.favorite.count(),
    pushBatches: await prisma.pushBatch.count(),
    sources: await prisma.sourceDefinition.count(),
  };

  console.log(`empty-library init done: ${JSON.stringify(counts)}`);
  console.log(`official source: ${officialSource.name} (${officialSource.normalizedAddress})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });