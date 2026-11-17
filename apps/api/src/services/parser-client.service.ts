import { Injectable, Logger } from '@nestjs/common';
import type { DocumentType } from '@competition/contracts';
import type { TextBlock } from '../domain/rule-extractor';
import { AppException } from '../platform/app-exception';
import { ConfigResolverService } from '../config/config-resolver.service';

export interface ParserResult {
  ok: boolean;
  text: string;
  blocks: TextBlock[];
  source: 'python' | 'fallback';
  degraded: boolean;
  errorCode?: string;
  message?: string;
  pageCount?: number;
  tables?: Array<Array<Array<string | null>>>;
}

interface ParserPayload {
  ok?: boolean;
  text?: string;
  blocks?: TextBlock[];
  pageCount?: number;
  tables?: ParserResult['tables'];
  errorCode?: string;
  message?: string;
}

@Injectable()
export class ParserClient {
  private readonly logger = new Logger(ParserClient.name);

  constructor(private readonly resolver: ConfigResolverService) {}

  private get baseUrl(): string {
    return this.resolver.getString('parser.baseUrl', 'http://127.0.0.1:8000');
  }

  private get enabled(): boolean {
    return Boolean(this.baseUrl);
  }

  private get timeoutMs(): number {
    return this.resolver.getNumber('parser.readTimeoutMs', 15000);
  }

  async parse(fileName: string, type: DocumentType, buffer: Buffer, extractTables = false): Promise<ParserResult> {
    if (this.enabled) {
      try {
        const response = await fetch(`${this.baseUrl}/v1/parse`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            fileName,
            declaredType: type,
            contentBase64: buffer.toString('base64'),
            ...(extractTables ? { extractTables } : {}),
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          if (response.status === 422 || response.status === 415) {
            const body = (await response.json().catch(() => null)) as (ParserPayload & { detail?: ParserPayload }) | null;
            const payload = body?.detail ?? body ?? {};
            throw new AppException(
              payload.errorCode ?? 'FILE_UNREADABLE',
              payload,
              payload.message,
            );
          }
          throw new Error(`parser http ${response.status}`);
        }
        const payload = (await response.json()) as ParserPayload;
        return {
          ok: payload.ok !== false,
          text: payload.text ?? '',
          blocks: payload.blocks ?? [],
          source: 'python',
          degraded: false,
          pageCount: payload.pageCount,
          ...(extractTables ? { tables: payload.tables } : {}),
        };
      } catch (error) {
        if (error instanceof AppException) throw error;
        this.logger.warn(`parser unavailable: ${(error as Error).message}`);
      }
    }

    return this.fallback(fileName, type, buffer);
  }

  private fallback(fileName: string, type: DocumentType, buffer: Buffer): ParserResult {
    if (type === 'text' || type === 'csv') {
      const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
      return {
        ok: true,
        text,
        blocks: text.split(/\r?\n/).map((line, index) => ({
          text: line,
          location: { kind: 'text', line: index + 1, start: 0, end: line.length },
        })),
        source: 'fallback',
        degraded: true,
        message: '解析服务未启用，已使用文本直读模式',
      };
    }

    return {
      ok: false,
      text: '',
      blocks: [],
      source: 'fallback',
      degraded: true,
      errorCode: 'FILE_UNREADABLE',
      message: `当前未连接文档解析服务，无法解析 ${type.toUpperCase()} 文件。请启动 apps/parser，或改用文本/CSV、手工录入。`,
    };
  }
}
