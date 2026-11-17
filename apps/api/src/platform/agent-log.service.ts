import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { DiscoveryLog } from '@competition/contracts';
import { FALLBACK_TIMEZONE } from '../domain/time';
import { AppException } from './app-exception';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 7;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const LOG_FILE = /^agent-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: FALLBACK_TIMEZONE });

function safeText(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"'，。；）]+/gi, value => {
    const url = URL.parse(value);
    return url ? `${url.origin}${url.pathname}` : '[链接]';
  }).replace(/((?:authorization|bearer|api[-_ ]?key|access[-_ ]?token|cookie|password|密钥)\s*(?:[:=：]\s*|\s+))(?:(?:bearer|basic)\s+)?[^\s,，;；]+/gi, '$1[已隐藏]')
    .replace(/\b(?:sk-|sk_)[A-Za-z0-9_-]{8,}/g, '[已隐藏]');
}

@Injectable()
export class AgentLogService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AgentLogService.name);
  private pending = Promise.resolve();
  private cleanupTimer?: NodeJS.Timeout;
  private lastWarning = -Infinity;

  constructor(private readonly directory = resolve(__dirname, '../../../..', 'artifacts/runtime/agent-logs')) {}

  onModuleInit(): void {
    this.cleanup();
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS).unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await this.pending;
  }

  record(runId: string, event: DiscoveryLog): void {
    const date = dateFormat.format(new Date(event.at));
    const url = event.url ? URL.parse(event.url) : null;
    const { at, stage, level, message, reason, durationMs, operation } = event;
    const line = JSON.stringify({ runId, at, stage, level, message: safeText(message),
      url: url ? `${url.origin}${url.pathname}${url.hash.split('?')[0]}` : undefined,
      reason, durationMs, operation: operation && { ...operation, label: safeText(operation.label) },
    });
    this.queue(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await appendFile(join(this.directory, `agent-${date}.jsonl`), line + '\n', { encoding: 'utf8', mode: 0o600 });
    });
  }

  async track<T>(label: string, work: (record: (event: DiscoveryLog) => void) => Promise<T>): Promise<T> {
    const id = randomUUID();
    const started = Date.now();
    const record = (event: DiscoveryLog) => this.record(id, event);
    record({ at: new Date(started).toISOString(), stage: 'task', level: 'info', message: `开始${label}。`,
      operation: { id: 'task', label, phase: 'start' } });
    const finish = (level: 'success' | 'error', reason?: string) => record({ at: new Date().toISOString(),
      stage: 'task', level, message: `${label}${level === 'success' ? '完成' : '失败'}。`, reason,
      durationMs: Date.now() - started, operation: { id: 'task', label, phase: 'end' } });
    try {
      const result = await work(record);
      finish('success');
      return result;
    } catch (error) {
      finish('error', error instanceof AppException ? error.code : 'unknown_error');
      throw error;
    }
  }

  private cleanup(): void {
    const earliest = dateFormat.format(Date.now() - (RETENTION_DAYS - 1) * DAY_MS);
    this.queue(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      for (const entry of await readdir(this.directory, { withFileTypes: true })) {
        const day = LOG_FILE.exec(entry.name)?.[1];
        if (entry.isFile() && day && day < earliest) {
          await unlink(join(this.directory, entry.name)).catch(error => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      }
    });
  }

  private queue(work: () => Promise<void>): void {
    this.pending = this.pending.then(work).catch((error: NodeJS.ErrnoException) => {
      if (Date.now() - this.lastWarning < 60_000) return;
      this.lastWarning = Date.now();
      this.logger.warn(`本地智能体日志写入或清理失败（${error.code ?? 'unknown_error'}）。`);
    });
  }
}
