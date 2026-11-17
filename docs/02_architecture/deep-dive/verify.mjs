// Documentation verification and isolated pure-function probes; no application startup.
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const outputRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(outputRoot, '../../..');
const { parseDateTime, deriveRegistrationStatus, endOfDayIfNeeded } = await import(
  pathToFileURL(resolve(projectRoot, 'apps/api/src/domain/time.ts')).href
);
const { extractDocumentCatalog, catalogGradeCounts } = await import(
  pathToFileURL(resolve(projectRoot, 'apps/api/src/domain/document-catalog.ts')).href
);
const markdownFiles = (await readdir(outputRoot)).filter(name => name.endsWith('.md'));
const broken = [];
const sourcePaths = new Set();
let checkedLinks = 0;
for (const name of markdownFiles) {
  const text = await readFile(resolve(outputRoot, name), 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(?:https?:|#)/.test(target)) continue;
    const file = resolve(outputRoot, decodeURIComponent(target.split('#')[0]));
    // This report is written at the end of this run.
    if (file === resolve(outputRoot, 'verification.json')) continue;
    checkedLinks++;
    try {
      if (!(await stat(file)).isFile()) throw new Error('not_file');
      if (relative(projectRoot, file).replaceAll('\\', '/').startsWith('apps/')) sourcePaths.add(file);
    } catch {
      broken.push({ document: name, target });
    }
  }
}
const sourceBaseline = [];
for (const file of [...sourcePaths].sort()) {
  const content = await readFile(file);
  sourceBaseline.push({ path: relative(projectRoot, file).replaceAll('\\', '/'),
    sha256: createHash('sha256').update(content).digest('hex') });
}
const fixture = await readFile(resolve(projectRoot, 'apps/api/src/domain/fixtures/recognition-catalog.txt'), 'utf8');
const catalog = extractDocumentCatalog(fixture, [], 'recognition-catalog.txt');
const referenceTime = new Date('2026-11-17T04:00:00Z');
const day = parseDateTime('2026年11月17日');
const future = deriveRegistrationStatus({ startAt: parseDateTime('2026年11月19日'),
  endAt: parseDateTime('2026年11月20日') }, referenceTime);
const invalid = parseDateTime('2026年2月30日');
const probes = [
  { id: 'catalog_fixture', expected: 71, observed: catalog?.competitions.length,
    verified: catalog?.competitions.length === 71,
    gradeCounts: catalog ? catalogGradeCounts(catalog) : null,
    meaning: 'Existing fixture rows are preserved by the current pure parser; not an accuracy benchmark.' },
  { id: 'day_precision', expected: '2026-11-17T15:59:59.000Z',
    observed: endOfDayIfNeeded(day)?.toISOString(),
    verified: endOfDayIfNeeded(day)?.toISOString() === '2026-11-17T15:59:59.000Z' },
  { id: 'future_start_boundary', expectedCurrentBehavior: 'closing_soon', observed: future,
    verified: future === 'closing_soon',
    issue: 'Current branch order labels a future-start stage as closing soon; proposed rule is not_started.' },
  { id: 'invalid_calendar_date', expectedCurrentBehavior: '2026-03-01T16:00:00.000Z', observed: invalid.at,
    verified: invalid.at === '2026-03-01T16:00:00.000Z',
    issue: 'February 30 is normalized into March rather than rejected.' },
];
const report = {
  generatedAt: new Date().toISOString(),
  userTimezone: 'Asia/Shanghai',
  scope: 'Local static source/document review plus isolated pure functions; no credentials, network, database or full test suite.',
  runtime: process.version,
  command: 'node --experimental-strip-types docs/02_architecture/deep-dive/verify.mjs',
  linkCheck: { markdownFiles: markdownFiles.length, checkedLinks, broken },
  sourceBaseline,
  probes,
  historicalResults: { source: 'DEPLOYMENT_STATUS.md, 2026-11-17', rerunThisSession: false,
    recordedApiTests: 141, recordedHttpsChecks: 26, recordedParserChecks: 6 },
  complete: broken.length === 0 && probes.every(probe => probe.verified),
};
await writeFile(resolve(outputRoot, 'verification.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ complete: report.complete, ...report.linkCheck,
  sourceFiles: sourceBaseline.length, probes }, null, 2));
if (!report.complete) process.exitCode = 1;
