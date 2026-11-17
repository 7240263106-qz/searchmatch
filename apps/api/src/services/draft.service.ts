import { Injectable } from '@nestjs/common';
import type { DraftView } from '@competition/contracts';
import { PrismaService } from '../platform/prisma.module';
import { AppException } from '../platform/app-exception';

const DRAFT_TTL_DAYS = 7;

@Injectable()
export class DraftService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    actorId: string,
    input: { title?: string | null; payload?: Record<string, unknown>; documentIds?: string[] },
  ): Promise<DraftView> {
    const row = await this.prisma.draft.create({
      data: {
        ownerId: actorId,
        title: input.title ?? null,
        payloadJson: JSON.stringify(input.payload ?? {}),
        documentIdsJson: JSON.stringify(input.documentIds ?? []),
        expiresAt: new Date(Date.now() + DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    return this.toView(row);
  }

  async list(actorId: string): Promise<DraftView[]> {
    const rows = await this.prisma.draft.findMany({
      where: { ownerId: actorId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    return rows.map((row) => this.toView(row));
  }

  async update(
    draftId: string,
    actorId: string,
    input: { title?: string | null; payload?: Record<string, unknown>; documentIds?: string[] },
    expectedVersion?: number,
  ): Promise<DraftView> {
    const row = await this.prisma.draft.findFirst({ where: { id: draftId, ownerId: actorId } });
    if (!row) throw new AppException('RESOURCE_NOT_FOUND');
    if (expectedVersion !== undefined && row.version !== expectedVersion) {
      throw new AppException('DRAFT_VERSION_CONFLICT', {
        expected: expectedVersion,
        actual: row.version,
      });
    }
    const updated = await this.prisma.draft.update({
      where: { id: draftId },
      data: {
        title: input.title ?? row.title,
        payloadJson: input.payload ? JSON.stringify(input.payload) : row.payloadJson,
        documentIdsJson: input.documentIds ? JSON.stringify(input.documentIds) : row.documentIdsJson,
        version: { increment: 1 },
        expiresAt: new Date(Date.now() + DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    return this.toView(updated);
  }

  private toView(row: {
    id: string;
    ownerId: string;
    title: string | null;
    payloadJson: string;
    documentIdsJson: string;
    version: number;
    expiresAt: Date;
    updatedAt: Date;
  }): DraftView {
    return {
      id: row.id,
      ownerId: row.ownerId,
      title: row.title,
      payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
      version: row.version,
      expiresAt: row.expiresAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      documentIds: JSON.parse(row.documentIdsJson) as string[],
    };
  }
}