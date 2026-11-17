import type { ParseTaskView } from './types';

export interface DocumentModelConfiguration {
  capturedAt: string;
  configVersion: number;
  enabled: boolean;
  baseUrl: string;
  model: string;
  modelSource: 'document' | 'default';
  credentialReady: boolean;
  timeoutMs: number;
  textLimit: number;
  missing: string[];
}

export interface DocumentRunLog {
  at: string;
  stage: string;
  level: 'info' | 'warning' | 'error';
  code: string;
  message: string;
}

export interface DocumentExtractionTrace {
  catalog?: { expectedRows: number; returnedRows: number; validatedRows: number; batches: number };
  status: 'used' | 'skipped' | 'failed';
  reason: string | null;
  configuration: DocumentModelConfiguration;
  inputCharacters: number;
  sentCharacters: number;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface DocumentRunTrace {
  trigger: 'auto' | 'user_request' | 'reparse';
  configuration: DocumentModelConfiguration;
  logs: DocumentRunLog[];
  parser?: { source: 'python' | 'fallback'; degraded: boolean; characters: number; blocks: number; pages?: number; durationMs: number };
  extraction?: DocumentExtractionTrace;
}

export interface DocumentRunView extends ParseTaskView {
  attempts: number;
  durationMs: number | null;
  trace: DocumentRunTrace | null;
  result: { versionId: string; versionNo: number; adopted: boolean; source: 'rule' | 'llm' | 'fallback'; fieldCount: number; filledFields: number; textCharacters: number | null;
    catalog?: { count: number; detectedRows: number; gradeCounts: Record<string, number>; warnings: string[] } } | null;
}

export interface DocumentRunsView {
  document: { id: string; fileName: string; detectedType: string; size: number; deletionPending: boolean };
  currentConfiguration: DocumentModelConfiguration;
  workflow: string;
  runs: DocumentRunView[];
}
