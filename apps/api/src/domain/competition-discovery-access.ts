import type { Prisma } from '@prisma/client';

export function competitionDiscoveryScope(actorId: string, roles: readonly string[]): Prisma.CompetitionWhereInput {
  const states: Prisma.CompetitionWhereInput[] = [
    { publishStatus: 'published' },
    { publishStatus: 'draft', createdBy: actorId },
  ];
  if (roles.some(role => role === 'reviewer' || role === 'admin')) states.push({ publishStatus: 'pending_review' });
  return { deletedAt: null, dataOrigin: 'formal', demoFlag: false, OR: states };
}
