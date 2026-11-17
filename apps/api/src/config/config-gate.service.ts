import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { ConfigGateReport } from '@competition/contracts';

@Injectable()
export class ConfigGateService {
  private readonly candidates = [
    resolve(process.cwd(), 'artifacts', 'config-gate', 'last-report.json'),
    resolve(process.cwd(), '..', '..', 'artifacts', 'config-gate', 'last-report.json'),
  ];

  private reportPath(): string | null {
    return this.candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  read(): ConfigGateReport | null {
    const path = this.reportPath();
    if (!path) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as ConfigGateReport;
    } catch {
      return null;
    }
  }

  path(): string | null {
    return this.reportPath();
  }
}