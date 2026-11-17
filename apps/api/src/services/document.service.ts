import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { DocumentIntakeRow, ParseTaskStatus, PublishStatus, UploadFileResult } from '@competition/contracts';
import { PrismaService } from '../platform/prisma.module';
import { StorageService } from '../platform/storage.module';
import { AuditService } from '../platform/audit.module';
import { AppException } from '../platform/app-exception';
import { detectDocumentType, assertFileLimits, decodeMultipartFilename } from '../domain/file-security';
import { ParseService } from './parse.service';
import { ConfigResolverService } from '../config/config-resolver.service';

export interface UploadInputFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const MAX_SINGLE = 20 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;

@Injectable()
export class DocumentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly parseService: ParseService,
    private readonly resolver: ConfigResolverService,
  ) {}

  private get retentionDays(): number {
    return this.resolver.getNumber('retention.documentDays', 180);
  }

  async upload(files: UploadInputFile[], actorId: string): Promise<{ results: UploadFileResult[]; accepted: number; rejected: number }> {
    assertFileLimits(files, MAX_SINGLE, MAX_TOTAL);
    const results: UploadFileResult[] = [];

    for (const file of files) {
      const fileName = decodeMultipartFilename(file.originalname);
      if (file.size > MAX_SINGLE) {
        results.push({
          fileName,
          accepted: false,
          reasonCode: 'FILE_SIZE_EXCEEDED',
          reason: '单个文件超过 20MB 限制',
        });
        continue;
      }

      const detection = detectDocumentType(fileName, file.buffer);
      if (!detection.accepted) {
        results.push({
          fileName,
          accepted: false,
          detectedType: detection.type,
          reasonCode: detection.reasonCode ?? 'FILE_SECURITY_REJECTED',
          reason: detection.reason ?? '文件未通过安全校验',
        });
        continue;
      }

      const fingerprint = createHash('sha256').update(file.buffer).digest('hex');
      const existing = await this.prisma.competitionDocument.findFirst({
        where: { ownerKind: 'personal', ownerId: actorId, fingerprint },
      });
      if (existing) {
        const deletionPending = existing.status === 'deleting';
        results.push({
          fileName,
          accepted: !deletionPending,
          documentId: deletionPending ? undefined : existing.id,
          deduplicated: true,
          detectedType: existing.detectedType as UploadFileResult['detectedType'],
          size: existing.size,
          reasonCode: deletionPending ? 'STATE_TRANSITION_INVALID' : undefined,
          reason: deletionPending ? '相同文件正在删除，请完成删除后重新上传' : '相同文件已上传，返回已有记录',
        });
        continue;
      }

      const extension = extname(fileName).replace('.', '').toLowerCase();
      const storageKey = await this.storage.save(file.buffer, extension);
      const expiresAt = new Date(Date.now() + this.retentionDays * 24 * 60 * 60 * 1000);

      const document = await this.prisma.$transaction(async (tx) => {
        const row = await tx.competitionDocument.create({
          data: {
            fileName,
            mimeType: file.mimetype || 'application/octet-stream',
            detectedType: detection.type,
            size: file.size,
            fingerprint,
            storageKey,
            ownerKind: 'personal',
            ownerId: actorId,
            expiresAt,
          },
        });
        await tx.sourceMaterial.create({
          data: {
            documentId: row.id,
            type: 'uploaded_document',
            title: fileName,
            ownerId: actorId,
          },
        });
        return row;
      });

      await this.audit.record({
        actorId,
        action: 'document.upload',
        objectType: 'document',
        objectId: document.id,
        detail: { fileName, size: file.size, type: detection.type },
      });

      await this.parseService.enqueue(document.id, 'auto');

      results.push({
        fileName,
        accepted: true,
        documentId: document.id,
        detectedType: detection.type,
        size: file.size,
      });
    }

    return {
      results,
      accepted: results.filter((item) => item.accepted).length,
      rejected: results.filter((item) => !item.accepted).length,
    };
  }

  async list(actorId: string): Promise<DocumentIntakeRow[]> {
    const rows = await this.prisma.competitionDocument.findMany({
      where: { ownerId: actorId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        _count: { select: { links: { where: { competition: { deletedAt: null } } } } },
        parseTasks: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, status: true, stage: true, progress: true, errorCode: true, errorMessage: true },
        },
        resultVersions: {
          where: { adopted: true },
          orderBy: { versionNo: 'desc' },
          take: 1,
          select: { taskId: true },
        },
        links: {
          where: {
            competition: {
              deletedAt: null,
              OR: [{ publishStatus: { not: 'draft' } }, { createdBy: actorId }, { createdBy: null }],
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { competition: { select: { id: true, name: true, publishStatus: true } } },
        },
      },
    });
    return rows.map((row) => {
      const task = row.parseTasks[0];
      const result = row.resultVersions[0];
      const linked = row.links[0]?.competition;
      const deletionPending = row.status === 'deleting';
      return {
        id: row.id,
        fileName: decodeMultipartFilename(row.fileName),
        detectedType: row.detectedType,
        size: row.size,
        parseStatus: row.parseStatus as ParseTaskStatus,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        fileUrl: deletionPending ? '' : this.storage.signedUrl(row.id, actorId),
        deletionPending,
        latestTask: task ? { ...task, status: task.status as ParseTaskStatus } : null,
        reviewTaskId: result ? result.taskId ?? task?.id ?? null : null,
        linkedCompetition: linked ? { ...linked, publishStatus: linked.publishStatus as PublishStatus } : null,
        linkedCompetitionCount: row._count.links,
      };
    });
  }

  async delete(documentId: string, actorId: string): Promise<{ deleted: true }> {
    const document = await this.prisma.$transaction(async (tx) => {
      const reserved = await tx.competitionDocument.updateMany({
        where: { id: documentId, ownerId: actorId },
        data: { status: 'deleting' },
      });
      if (!reserved.count) throw new AppException('RESOURCE_NOT_FOUND');

      const activeTask = await tx.parseTask.findFirst({
        where: { documentId, status: { in: ['queued', 'processing'] } },
        select: { id: true },
      });
      if (activeTask) {
        throw new AppException('STATE_TRANSITION_INVALID', null, '文档正在解析，请等解析结束后再删除。');
      }
      return tx.competitionDocument.findUniqueOrThrow({
        where: { id: documentId },
        select: { storageKey: true },
      });
    });

    // Keep the deletion state until both storage and database cleanup succeed.
    try {
      await this.storage.delete(document.storageKey);
    } catch {
      throw new AppException('INTERNAL_ERROR', { reason: 'document_storage_delete_failed' }, '原件删除未完成，请稍后重试。');
    }

    const removed = await this.prisma.$transaction(async (tx) => {
      const reserved = await tx.competitionDocument.updateMany({
        where: { id: documentId, ownerId: actorId, status: 'deleting' },
        data: { status: 'deleting' },
      });
      if (!reserved.count) return false;

      const versions = await tx.parseResultVersion.findMany({
        where: { documentId },
        select: { id: true },
      });
      if (versions.length > 0) {
        await tx.fieldEvidence.updateMany({
          where: { parseVersionId: { in: versions.map(({ id }) => id) } },
          data: { parseVersionId: null },
        });
      }
      await tx.sourceMaterial.deleteMany({ where: { documentId, competitionId: null } });
      await tx.sourceMaterial.updateMany({ where: { documentId }, data: { documentId: null } });

      const drafts = await tx.draft.findMany({
        where: { ownerId: actorId, documentIdsJson: { contains: JSON.stringify(documentId) } },
        select: { id: true, documentIdsJson: true },
      });
      for (const draft of drafts) {
        const ids = JSON.parse(draft.documentIdsJson) as string[];
        if (!Array.isArray(ids) || !ids.includes(documentId)) continue;
        await tx.draft.update({
          where: { id: draft.id },
          data: { documentIdsJson: JSON.stringify(ids.filter((id) => id !== documentId)), version: { increment: 1 } },
        });
      }

      await tx.competitionDocument.delete({ where: { id: documentId } });
      return true;
    });

    if (removed) {
      await this.audit.record({ actorId, action: 'document.delete', objectType: 'document', objectId: documentId });
    }
    return { deleted: true };
  }

  async readFile(documentId: string, actorId: string, exp: number, sig: string): Promise<{ fileName: string; buffer: Buffer }> {
    const document = await this.prisma.competitionDocument.findFirst({
      where: { id: documentId, ownerId: actorId, status: 'stored' },
    });
    if (!document) throw new AppException('RESOURCE_NOT_FOUND');
    if (!this.storage.verify(documentId, actorId, exp, sig)) {
      throw new AppException('RESOURCE_NOT_FOUND');
    }
    const buffer = await this.storage.read(document.storageKey);
    return { fileName: decodeMultipartFilename(document.fileName), buffer };
  }
}
