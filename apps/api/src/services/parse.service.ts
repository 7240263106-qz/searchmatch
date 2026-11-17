import { Injectable, Logger } from '@nestjs/common';
import type {
  ConflictGroup,
  DocumentRunTrace,
  DocumentRunsView,
  DocumentRunLog,
  EvidenceView,
  ParsePreview,
  ParseTaskStatus,
  PreviewField,
  UploadBatchResult,
  UploadFileResult,
} from '@competition/contracts';
import { PrismaService } from '../platform/prisma.module';
import { StorageService } from '../platform/storage.module';
import { ParserClient } from './parser-client.service';
import { ExtractionService } from './extraction.service';
import { AppException } from '../platform/app-exception';
import { detectDocumentType, decodeMultipartFilename } from '../domain/file-security';
import type { ExtractionResult } from '../domain/rule-extractor';
import { catalogGradeCounts } from '../domain/document-catalog';

interface StoredExtraction {
  extraction: ExtractionResult;
  textPreview: string;
  source: 'rule' | 'llm' | 'fallback';
  degraded: boolean;
  fileName: string;
  documentType: string;
  pageCount?: number;
}

@Injectable()
export class ParseService {
  private readonly logger = new Logger(ParseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly parser: ParserClient,
    private readonly extraction: ExtractionService,
  ) {}

  async enqueue(
    documentId: string,
    trigger: 'auto' | 'user_request' | 'reparse' = 'auto',
    actorId?: string,
  ): Promise<{ taskId: string; reused: boolean }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const reserved = await tx.competitionDocument.updateMany({
        where: { id: documentId, ownerId: actorId, status: 'stored' },
        data: { status: 'stored' },
      });
      if (!reserved.count) throw new AppException('RESOURCE_NOT_FOUND');

      const existing = await tx.parseTask.findFirst({
        where: { documentId, status: { in: ['queued', 'processing'] } },
      });
      if (existing) return { taskId: existing.id, reused: true };

      const task = await tx.parseTask.create({
        data: {
          documentId,
          status: 'queued',
          stage: 'fetch',
          progress: 0,
          idempotencyKey: `${documentId}:${trigger === 'reparse' ? Date.now() : 'v1'}`,
          traceJson: JSON.stringify({ trigger, configuration: this.extraction.configuration(), logs: [{
            at: new Date().toISOString(), stage: 'queued', level: 'info', code: 'task.queued',
            message: trigger === 'reparse' ? '用户提交重新识别，已创建新任务。' : '已创建文档识别任务。',
          }] } satisfies DocumentRunTrace),
        },
      });
      await tx.competitionDocument.update({
        where: { id: documentId },
        data: { parseStatus: 'queued' },
      });
      return { taskId: task.id, reused: false };
    });
    if (!result.reused) {
      void this.run(result.taskId, documentId).catch((error: unknown) => {
        this.logger.error(`parse ${result.taskId} failed: ${(error as Error).message}`);
      });
    }
    return result;
  }

  private async run(taskId: string, documentId: string): Promise<void> {
    const document = await this.prisma.competitionDocument.findUnique({ where: { id: documentId } });
    if (!document) return;
    const task = await this.prisma.parseTask.findUniqueOrThrow({ where: { id: taskId } });
    const trace = JSON.parse(task.traceJson) as DocumentRunTrace;

    await this.prisma.parseTask.update({
      where: { id: taskId },
      data: { status: 'processing', startedAt: new Date(), stage: 'fetch', progress: 10, attempts: { increment: 1 } },
    });

    try {
      await this.log(taskId, trace, 'fetch', 10, 'info', 'file.read', '开始读取上传原件。');
      const buffer = await this.storage.read(document.storageKey);
      await this.log(taskId, trace, 'text', 35, 'info', 'parser.started', `原件读取完成（${buffer.length} 字节），开始提取文字。`);

      const parseStarted = Date.now();
      const parsed = await this.parser.parse(document.fileName, detectDocumentType(document.fileName, buffer).type, buffer);
      trace.parser = { source: parsed.source, degraded: parsed.degraded, characters: parsed.text.length,
        blocks: parsed.blocks.length, pages: parsed.pageCount, durationMs: Date.now() - parseStarted };

      if (!parsed.ok) {
        await this.finishFailed(taskId, documentId, parsed.errorCode ?? 'FILE_UNREADABLE', parsed.message ?? '解析失败', trace);
        return;
      }

      await this.log(taskId, trace, 'extract', 70, parsed.degraded ? 'warning' : 'info', 'parser.completed',
        `已读取 ${parsed.text.length} 字符、${parsed.blocks.length} 个文本块${parsed.pageCount ? `、${parsed.pageCount} 页` : ''}。${parsed.degraded ? '解析服务不可用，已使用文本直读。' : '文字由解析服务读取。'}`);
      const result = await this.extraction.extract(parsed.text, parsed.blocks, document.fileName,
        event => this.log(taskId, trace, 'extract', 70, event.level, event.code, event.message));
      trace.extraction = result.trace;

      await this.log(taskId, trace, 'validate', 90, 'info', 'result.validate', '正在整理字段依据并保存新的识别版本。');

      const stored: StoredExtraction = {
        extraction: result,
        textPreview: result.textPreview,
        source: parsed.degraded ? 'fallback' : result.source,
        degraded: parsed.degraded,
        fileName: document.fileName,
        documentType: document.detectedType,
        pageCount: parsed.pageCount,
      };

      const latest = await this.prisma.parseResultVersion.findFirst({
        where: { documentId },
        orderBy: { versionNo: 'desc' },
      });
      const versionNo = (latest?.versionNo ?? 0) + 1;
      trace.logs.push({ at: new Date().toISOString(), stage: 'done', level: 'info', code: 'task.completed',
        message: `识别完成，已保存第 ${versionNo} 版结果；${result.catalog ? `目录 ${result.catalog.competitions.length} 项，${result.source === 'llm' ? '模型逐项核验通过' : '保留原文逐行提取结果'}` : result.source === 'llm' ? '模型已参与字段分析' : '使用规则提取'}，等待核对。` });

      await this.prisma.$transaction([
        this.prisma.parseResultVersion.updateMany({
          where: { documentId, adopted: true },
          data: { adopted: false },
        }),
        this.prisma.parseResultVersion.create({
          data: {
            documentId,
            taskId,
            versionNo,
            modelVersion: result.source === 'llm' ? 'llm-v1' : 'rule-v1',
            configVersion: 'parse-config-v1',
            resultJson: JSON.stringify(stored),
            adopted: true,
            adoptedAt: new Date(),
          },
        }),
        this.prisma.parseTask.update({
          where: { id: taskId },
          data: {
            status: 'succeeded',
            stage: 'done',
            progress: 100,
            finishedAt: new Date(),
            traceJson: JSON.stringify(trace),
          },
        }),
        this.prisma.competitionDocument.update({
          where: { id: documentId },
          data: { parseStatus: 'succeeded' },
        }),
      ]);
    } catch (error) {
      await this.finishFailed(taskId, documentId, error instanceof AppException ? error.code : 'FILE_UNREADABLE',
        error instanceof AppException ? error.message : '文档处理失败，请检查原件和解析服务。', trace);
    }
  }

  private async log(taskId: string, trace: DocumentRunTrace, stage: string, progress: number,
    level: DocumentRunLog['level'], code: string, message: string): Promise<void> {
    trace.logs.push({ at: new Date().toISOString(), stage, level, code, message });
    await this.prisma.parseTask.update({ where: { id: taskId }, data: { stage, progress, traceJson: JSON.stringify(trace) } });
  }

  private async finishFailed(taskId: string, documentId: string, code: string, message: string, trace: DocumentRunTrace): Promise<void> {
    trace.logs.push({ at: new Date().toISOString(), stage: 'failed', level: 'error', code, message });
    await this.prisma.$transaction([
      this.prisma.parseTask.update({
        where: { id: taskId },
        data: {
          status: 'failed',
          errorCode: code,
          errorMessage: message,
          finishedAt: new Date(),
          traceJson: JSON.stringify(trace),
        },
      }),
      this.prisma.competitionDocument.update({
        where: { id: documentId },
        data: { parseStatus: 'failed' },
      }),
    ]);
  }

  async runs(documentId: string, actorId: string): Promise<DocumentRunsView> {
    const document = await this.prisma.competitionDocument.findFirst({
      where: { id: documentId, ownerId: actorId },
      include: { parseTasks: { orderBy: { createdAt: 'desc' }, take: 100,
        include: { resultVersions: { orderBy: { versionNo: 'desc' }, take: 1 } } } },
    });
    if (!document) throw new AppException('RESOURCE_NOT_FOUND');
    return {
      document: { id: document.id, fileName: decodeMultipartFilename(document.fileName), detectedType: document.detectedType,
        size: document.size, deletionPending: document.status === 'deleting' },
      currentConfiguration: this.extraction.configuration(),
      workflow: '读取原件 → 提取文字 → 识别文档类型 → 目录逐项提取并分批模型核验，或单场公告字段补充 → 保存结果 → 人工核对入库。目录保留原序号、完整名称和学校认定等级；原文未载明的信息保持为空。',
      runs: document.parseTasks.map(task => {
        const storedTrace = JSON.parse(task.traceJson) as Partial<DocumentRunTrace>;
        const version = task.resultVersions[0];
        const stored = version ? JSON.parse(version.resultJson) as Partial<StoredExtraction> : null;
        const fields = stored?.extraction?.fields ?? [];
        return { id: task.id, documentId, documentName: decodeMultipartFilename(document.fileName),
          status: task.status as ParseTaskStatus, stage: task.stage, progress: task.progress, attempts: task.attempts,
          errorCode: task.errorCode, errorMessage: task.errorMessage, createdAt: task.createdAt.toISOString(),
          startedAt: task.startedAt?.toISOString() ?? null, finishedAt: task.finishedAt?.toISOString() ?? null,
          durationMs: task.startedAt ? (task.finishedAt?.getTime() ?? Date.now()) - task.startedAt.getTime() : null,
          trace: storedTrace.configuration && Array.isArray(storedTrace.logs) ? storedTrace as DocumentRunTrace : null,
          result: version ? { versionId: version.id, versionNo: version.versionNo, adopted: version.adopted,
            ...(stored?.extraction?.catalog ? { catalog: { count: stored.extraction.catalog.competitions.length,
              detectedRows: stored.extraction.catalog.detectedRows, gradeCounts: catalogGradeCounts(stored.extraction.catalog), warnings: stored.extraction.catalog.warnings } } : {}),
            source: version.modelVersion === 'llm-v1' ? 'llm' as const : stored?.source ?? 'rule' as const,
            fieldCount: fields.length, filledFields: fields.filter(field => field.value).length,
            textCharacters: stored?.textPreview?.length ?? null } : null,
        };
      }),
    };
  }

  async preview(taskId: string, actorId?: string): Promise<ParsePreview> {
    const task = await this.prisma.parseTask.findFirst({
      where: { id: taskId, document: { ownerId: actorId, status: 'stored' } },
      include: { document: true },
    });
    if (!task) throw new AppException('PARSE_TASK_NOT_FOUND');

    const resultVersion = await this.prisma.parseResultVersion.findFirst({
      where: { documentId: task.documentId, adopted: true },
      orderBy: { versionNo: 'desc' },
    });
    if (!resultVersion) {
      throw new AppException('PARSE_TASK_NOT_FOUND', { reason: '尚无解析结果' });
    }

    const stored = JSON.parse(resultVersion.resultJson) as StoredExtraction;
    const extraction = stored.extraction;

    const fields: PreviewField[] = extraction.fields.map((field) => ({
      key: field.key,
      label: field.label,
      value: field.value,
      state: field.state,
      confidence: field.confidence,
      time: field.time,
      manuallyCorrected: false,
      evidence: field.evidence
        ? ({
            sourceTitle: decodeMultipartFilename(stored.fileName),
            snippet: field.evidence.snippet,
            location: field.evidence.location,
            extractMethod: field.evidence.extractMethod,
            confidence: field.evidence.confidence,
            manuallyCorrected: false,
            locatable: Boolean(field.evidence.snippet),
          } satisfies EvidenceView)
        : null,
    }));

    const conflicts: ConflictGroup[] = extraction.conflicts;

    return {
      taskId,
      catalog: extraction.catalog,
      documentId: task.documentId,
      resultVersionId: resultVersion.id,
      documentName: decodeMultipartFilename(stored.fileName),
      documentType: task.document.detectedType as ParsePreview['documentType'],
      status: task.status as ParseTaskStatus,
      source: resultVersion.modelVersion === 'llm-v1' ? 'llm' : stored.source,
      hasText: Boolean(stored.textPreview?.trim()),
      competitionId: null,
      competitionName: extraction.competitionName,
      fields,
      conflicts,
      missing: extraction.missing,
      duplicates: [],
      truncatedFrom: extraction.truncatedFrom,
      summary: extraction.summary,
    };
  }

  async getResultVersion(taskId: string, actorId?: string): Promise<{ versionId: string; stored: StoredExtraction } | null> {
    const task = await this.prisma.parseTask.findFirst({
      where: { id: taskId, document: { ownerId: actorId, status: 'stored' } },
    });
    if (!task) return null;
    const version = await this.prisma.parseResultVersion.findFirst({
      where: { documentId: task.documentId, adopted: true },
      orderBy: { versionNo: 'desc' },
    });
    if (!version) return null;
    return { versionId: version.id, stored: JSON.parse(version.resultJson) as StoredExtraction };
  }

  async listTasks(status?: string, actorId?: string): Promise<unknown[]> {
    const rows = await this.prisma.parseTask.findMany({
      where: { status, document: { ownerId: actorId, status: 'stored' } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { document: true },
    });
    return rows.map((row) => ({
      id: row.id,
      documentId: row.documentId,
      documentName: row.document.fileName,
      status: row.status,
      stage: row.stage,
      progress: row.progress,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async uploadResultToBatch(results: UploadFileResult[]): Promise<UploadBatchResult> {
    return {
      results,
      accepted: results.filter((item) => item.accepted).length,
      rejected: results.filter((item) => !item.accepted).length,
    };
  }
}
