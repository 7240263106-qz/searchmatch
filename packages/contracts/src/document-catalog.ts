import type { EvidenceView } from './types';

export type SchoolRecognitionLevel = 'A类' | 'B类' | 'C类';

export interface CatalogCompetition {
  sequence: number;
  name: string;
  schoolRecognitionLevel: SchoolRecognitionLevel | null;
  evidence: EvidenceView;
}

export interface DocumentCatalog {
  title: string;
  recognitionScope: string;
  detectedRows: number;
  competitions: CatalogCompetition[];
  warnings: string[];
}

export interface CatalogConfirmInput {
  resultVersionId: string;
  publish?: boolean;
  items: Array<{ sequence: number; name: string; schoolRecognitionLevel: SchoolRecognitionLevel }>;
}

export interface CatalogConfirmResult {
  count: number;
  items: Array<{ id: string; name: string; schoolRecognitionLevel: string | null }>;
}
