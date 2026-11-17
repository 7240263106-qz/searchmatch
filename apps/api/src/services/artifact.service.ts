import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../platform/prisma.module';
import { StorageService } from '../platform/storage.module';
import { AppException } from '../platform/app-exception';
import { detectDocumentType } from '../domain/file-security';
import { ConfigResolverService } from '../config/config-resolver.service';
import type { RawFetchResult } from '../platform/safe-fetch';

export interface SnapshotInput {
  taskId?: string | null;
  sourceId?: string | null;
  batchId?: string | null;
  pageKind: 'list' | 'detail' | 'rss' | 'attachment';
  result: RawFetchResult;
}

export interface AttachmentInput {
  snapshotId?: string | null;
  sourceId?: string | null;
  taskId?: string | null;
  batchId?: string | null;
  parentUrl: string;
  url: string;
  fileName: string;
  buffer: Buffer;
}

@Injectable()
export class ArtifactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly resolver: ConfigResolverService,
  ) {}

  private retentionDaysOf(pageKind: SnapshotInput['pageKind']): number {
    return this.resolver.getNumber(
      pageKind === 'attachment' ? 'retention.attachmentDays' : 'retention.snapshotDays',
      180,
    );
  }

  async saveSnapshot(input: SnapshotInput): Promise<{ snapshotId: string; evidenceId: string; fingerprint: string }> {
    const { result } = input;
    if (!result.ok || result.truncated || result.buffer.byteLength === 0) {
      throw new AppException('FILE_UNREADABLE', { reason: result.internalReason ?? 'empty_response' });
    }

    const fingerprint = createHash('sha256').update(result.buffer).digest('hex');
    if (fingerprint !== result.fingerprint) {
      throw new AppException('FILE_SECURITY_REJECTED', { reason: 'fingerprint_mismatch' });
    }

    const storageKey = await this.storage.save(result.buffer, `snapshot-${randomUUID()}.html`);

    const evidence = await this.prisma.requestEvidence.create({
      data: {
        taskId: input.taskId ?? null,
        sourceId: input.sourceId ?? null,
        batchId: input.batchId ?? null,
        url: result.url,
        finalUrl: result.finalUrl,
        redirectChainJson: JSON.stringify(result.redirectChain),
        status: result.status,
        bytes: result.bytes,
        fingerprint,
      },
    });

    const snapshot = await this.prisma.rawPageSnapshot.create({
      data: {
        evidenceId: evidence.id,
        sourceId: input.sourceId ?? null,
        taskId: input.taskId ?? null,
        batchId: input.batchId ?? null,
        pageKind: input.pageKind,
        url: result.url,
        finalUrl: result.finalUrl,
        storageKey,
        fingerprint,
        bytes: result.bytes,
        contentType: result.contentType,
        status: 'available',
        parseStatus: 'pending',
        expiresAt: new Date(
          Date.now() + this.retentionDaysOf(input.pageKind) * 24 * 60 * 60 * 1000,
        ),
      },
    });

    return { snapshotId: snapshot.id, evidenceId: evidence.id, fingerprint };
  }

  async saveAttachment(input: AttachmentInput): Promise<{
    attachmentId: string;
    approved: boolean;
    stored: boolean;
    reason?: string;
    storageKey?: string;
  }> {
    const detection = detectDocumentType(input.fileName, input.buffer);
    const unsupported = detection.reasonCode === 'FILE_FORMAT_UNSUPPORTED';
    const stored = detection.accepted || unsupported;
    const rejected = !stored;

    let storageKey: string | undefined;
    let fingerprint: string | undefined;
    if (!rejected) {
      storageKey = await this.storage.save(input.buffer, `attachment-${randomUUID()}`);
      fingerprint = createHash('sha256').update(input.buffer).digest('hex');
    }

    const attachment = await this.prisma.crawlAttachment.create({
      data: {
        snapshotId: input.snapshotId ?? null,
        sourceId: input.sourceId ?? null,
        taskId: input.taskId ?? null,
        batchId: input.batchId ?? null,
        parentUrl: input.parentUrl,
        url: input.url,
        fileName: input.fileName,
        storageKey: storageKey ?? null,
        fingerprint: fingerprint ?? null,
        bytes: input.buffer.byteLength,
        securityStatus: rejected ? 'rejected' : detection.accepted ? 'approved' : 'unparsed',
        securityReason: rejected || unsupported ? detection.reason ?? null : null,
      },
    });

    return {
      attachmentId: attachment.id,
      approved: detection.accepted,
      stored,
      reason: detection.reason,
      storageKey,
    };
  }

  async readSnapshotText(snapshotId: string): Promise<string> {
    const snapshot = await this.prisma.rawPageSnapshot.findUnique({ where: { id: snapshotId } });
    if (!snapshot) throw new AppException('RESOURCE_NOT_FOUND');
    const buffer = await this.storage.read(snapshot.storageKey);
    return buffer.toString('utf8');
  }

  async listByTask(taskId: string): Promise<unknown[]> {
    const rows = await this.prisma.rawPageSnapshot.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    });
    const changedAt = await this.storageChangedAt();
    const items = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        pageKind: row.pageKind,
        url: row.url,
        finalUrl: row.finalUrl,
        fingerprint: row.fingerprint,
        bytes: row.bytes,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        ...(await this.availabilityOf(row.storageKey, row.createdAt, changedAt)),
      })),
    );
    return items;
  }

  async lineage(competitionId: string): Promise<unknown> {
    const competition = await this.prisma.competition.findUnique({
      where: { id: competitionId },
      include: { sources: true },
    });
    if (!competition) throw new AppException('RESOURCE_NOT_FOUND');

    const batchId = competition.verificationBatchId;
    const snapshots = batchId
      ? await this.prisma.rawPageSnapshot.findMany({ where: { batchId }, take: 20 })
      : [];
    const attachments = batchId
      ? await this.prisma.crawlAttachment.findMany({ where: { batchId }, take: 20 })
      : [];
    const changedAt = await this.storageChangedAt();

    const snapshotItems = await Promise.all(
      snapshots.map(async (snapshot) => ({
        id: snapshot.id,
        pageKind: snapshot.pageKind,
        url: snapshot.url,
        fingerprint: snapshot.fingerprint,
        createdAt: snapshot.createdAt.toISOString(),
        ...(await this.availabilityOf(snapshot.storageKey, snapshot.createdAt, changedAt)),
      })),
    );
    const attachmentItems = await Promise.all(
      attachments.map(async (attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        url: attachment.url,
        securityStatus: attachment.securityStatus,
        bytes: attachment.bytes,
        ...(attachment.storageKey
          ? await this.availabilityOf(attachment.storageKey, attachment.createdAt, changedAt)
          : { availability: 'inaccessible', reason: '附件未保存原件' }),
      })),
    );
    const inaccessibleCount = [...snapshotItems, ...attachmentItems].filter(
      (item) => item.availability === 'inaccessible',
    ).length;

    return {
      competitionId,
      dataOrigin: competition.dataOrigin,
      verificationBatchId: batchId,
      sources: competition.sources.map((source) => ({
        id: source.id,
        type: source.type,
        title: source.title,
        url: source.url,
      })),
      snapshots: snapshotItems,
      attachments: attachmentItems,
      affectedCount: inaccessibleCount,
      storageNote:
        inaccessibleCount > 0
          ? '部分历史原件所在存储目标已变更；记录与指纹保留，可按旧目标只读回退'
          : '历史原件均可按当前存储目标访问',
    };
  }

  private async storageChangedAt(): Promise<Date | null> {
    const row = await this.prisma.configChangeRecord.findFirst({
      where: { key: { startsWith: 'storage.' } },
      orderBy: { createdAt: 'desc' },
    });
    return row?.createdAt ?? null;
  }

  private async availabilityOf(
    storageKey: string | null,
    createdAt: Date,
    changedAt: Date | null,
  ): Promise<{ availability: 'available' | 'migrated' | 'inaccessible'; reason: string | null }> {
    if (!storageKey) return { availability: 'inaccessible', reason: '未保存原件' };
    const stat = await this.storage.stat(storageKey);
    return availabilityFromStat(stat, createdAt, changedAt);
  }
}
export function availabilityFromStat(
  stat: { exists: boolean; size: number },
  createdAt: Date,
  changedAt: Date | null,
): { availability: 'available' | 'migrated' | 'inaccessible'; reason: string | null } {
  if (stat.exists) {
    return {
      availability: 'available',
      reason: changedAt && createdAt < changedAt ? '旧存储目标仍可只读回退' : null,
    };
  }
  return {
    availability: 'inaccessible',
    reason: changedAt ? '存储目标已变更' : '原件不可读',
  };
}