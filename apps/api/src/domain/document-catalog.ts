import type { DocumentCatalog, SchoolRecognitionLevel } from '@competition/contracts';
import type { TextBlock } from './rule-extractor';

const HEADER = /^(序号|竞赛名称|认定|等级|认定等级|备注)$/;
const GRADE = /^[ABC]\s*类$/;
export const comparableCatalogName = (value: string): string => value.replace(/\s+/g, '');

/** Preserve source rows and combined subevents; a school catalog is not one event notice. */
export function extractDocumentCatalog(text: string, blocks: TextBlock[], fileName: string): DocumentCatalog | null {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const title = lines.find(line => /竞赛.*(认定|目录|名单)/.test(line));
  if (!title || !lines.some(line => GRADE.test(line))) return null;
  const starts = lines.flatMap((line, index) => /^\d{1,4}$/.test(line) ? [{ index, sequence: Number(line) }] : []);
  if (starts.length < 2) return null;
  const warnings: string[] = [];
  const competitions: DocumentCatalog['competitions'] = [];
  for (let i = 0; i < starts.length; i++) {
    const { index, sequence } = starts[i];
    const content = lines.slice(index + 1, starts[i + 1]?.index ?? lines.length).filter(line => !HEADER.test(line));
    const gradeIndex = content.findIndex(line => GRADE.test(line));
    const name = content.slice(0, gradeIndex < 0 ? content.length : gradeIndex).join('');
    if (!name) { warnings.push(`序号 ${sequence} 未读到竞赛名称。`); continue; }
    const grade = gradeIndex < 0 ? null : content[gradeIndex].replace(/\s+/g, '') as SchoolRecognitionLevel;
    if (!grade) warnings.push(`序号 ${sequence} 未读到 A/B/C 认定等级，需核对。`);
    if (i > 0 && sequence !== starts[i - 1].sequence + 1) warnings.push(`目录序号 ${starts[i - 1].sequence} 至 ${sequence} 不连续，请核对原件。`);
    const firstNameLine = content[0];
    const block = blocks.find(item => item.text.trim() === firstNameLine);
    const snippet = [String(sequence), ...content.slice(0, gradeIndex < 0 ? content.length : gradeIndex + 1)].join('\n');
    competitions.push({ sequence, name, schoolRecognitionLevel: grade,
      evidence: { sourceTitle: fileName, snippet, location: { ...(block?.location ?? { kind: 'text' }), sequence },
        extractMethod: 'rule', confidence: grade ? 'high' : 'low', manuallyCorrected: false, locatable: true } });
  }
  return { title, recognitionScope: title.replace(/(?:学科)?竞赛.*$/, '').trim() || title,
    detectedRows: starts.length, competitions, warnings };
}

export function catalogGradeCounts(catalog: DocumentCatalog): Record<string, number> {
  const counts: Record<string, number> = { 'A类': 0, 'B类': 0, 'C类': 0 };
  for (const item of catalog.competitions) if (item.schoolRecognitionLevel) counts[item.schoolRecognitionLevel]++;
  return counts;
}
