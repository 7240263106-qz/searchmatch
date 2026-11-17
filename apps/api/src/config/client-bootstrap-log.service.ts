import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';

export interface ClientBootstrapLogEntry {
  issuedAt: string;
  apiBaseUrl: string;
  apiBaseSource: 'configured' | 'same_origin';
  configVersion: number;
  profile: string;
  cacheMaxAgeSeconds: number;
  served: true;
}

export interface ClientBootstrapLogSummary {
  total: number;
  byVersion: Record<string, number>;
  bySource: Record<string, number>;
  logPath: string;
}

@Injectable()
export class ClientBootstrapLogService {
  private readonly paths = [
    resolve(process.cwd(), 'artifacts', 'config-gate', 'client-bootstrap-log.jsonl'),
    resolve(process.cwd(), '..', '..', 'artifacts', 'config-gate', 'client-bootstrap-log.jsonl'),
  ];

  private path(): string {
    const existing = this.paths.find((candidate) => existsSync(candidate));
    return existing ?? this.paths[1];
  }

  record(entry: ClientBootstrapLogEntry): void {
    const target = this.path();
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8');
    globalThis.__COMPETITION_CLIENT_BOOTSTRAP_COUNT__ =
      (globalThis.__COMPETITION_CLIENT_BOOTSTRAP_COUNT__ ?? 0) + 1;
  }

  summarize(): ClientBootstrapLogSummary {
    const target = this.path();
    const byVersion: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let total = 0;
    if (existsSync(target)) {
      for (const line of readFileSync(target, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as ClientBootstrapLogEntry;
          total += 1;
          byVersion[String(entry.configVersion)] = (byVersion[String(entry.configVersion)] ?? 0) + 1;
          bySource[entry.apiBaseSource] = (bySource[entry.apiBaseSource] ?? 0) + 1;
        } catch {
          // 忽略单行损坏，保持聚合可读
        }
      }
    }
    return { total, byVersion, bySource, logPath: target };
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __COMPETITION_CLIENT_BOOTSTRAP_COUNT__: number | undefined;
}