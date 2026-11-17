const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('../apps/api/node_modules/@prisma/client');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'catalog-review-20261116');
const prisma = new PrismaClient();
const datePattern = /(?:20\d{2}\s*[年./-]\s*)?\d{1,2}\s*[月./-]\s*\d{1,2}\s*(?:日|号|[./-])|20\d{2}\s*年\s*\d{1,2}\s*(?:[-—至～~]\s*\d{1,2})?\s*月/;
const substantiveFields = ['description', 'organizer', 'eligibility', 'schedule', 'nearestDeadline', 'signupUrl', 'discoveryTracks'];

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : null;
}

async function inspect() {
  fs.mkdirSync(output, { recursive: true });
  const rows = await prisma.competition.findMany({
    where: { deletedAt: null, dataOrigin: 'formal', demoFlag: false, parentId: null,
      OR: [{ publishStatus: 'published' }, { publishStatus: 'draft', createdBy: 'u-demo' }, { publishStatus: 'pending_review' }] },
    include: { sources: true, fieldEvidence: true, stages: true, organizers: { include: { organizer: true } }, reviews: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const snapshotFile = path.join(output, 'before.json');
  if (!fs.existsSync(snapshotFile)) fs.writeFileSync(snapshotFile, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
  const audit = rows.map((row, index) => {
    const previous = readJson(path.join(root, 'artifacts', 'catalog-completion-20261116', `${row.id}.json`));
    const pages = previous?.result?.pages ?? [];
    const dateEvidence = row.fieldEvidence.filter(field => ['schedule', 'nearestDeadline', 'discoveryTracks'].includes(field.fieldName));
    const dateText = [row.scheduleNote, ...row.stages.flatMap(stage => [stage.startRawText, stage.endRawText]),
      ...dateEvidence.map(field => field.fieldValue)].filter(Boolean).join('\n');
    const hasDates = Boolean(row.nearestDeadline || row.stages.some(stage => stage.startAt || stage.endAt) || datePattern.test(dateText));
    const verified = row.fieldEvidence.filter(field => substantiveFields.includes(field.fieldName) && field.sourceId
      && (field.snippet || field.fieldName === 'discoveryTracks'));
    const logIssues = previous?.warnings ?? [];
    return {
      index: index + 1, id: row.id, name: row.name, schoolRecognitionLevel: row.schoolRecognitionLevel,
      publishStatus: row.publishStatus, versionNo: row.versionNo, hasDates, nearestDeadline: row.nearestDeadline,
      scheduleNote: row.scheduleNote, dateText, dateEvidence: dateEvidence.map(field => ({ field: field.fieldName, value: field.fieldValue, quote: field.snippet, sourceId: field.sourceId })),
      substantiveEvidenceFields: [...new Set(verified.map(field => field.fieldName))],
      sources: row.sources.filter(source => source.url).map(source => ({ id: source.id, title: source.title, url: source.url, type: source.type })),
      previousRunId: previous?.runId ?? null,
      previousDateCandidates: pages.flatMap(page => page.fields.filter(field => ['nearestDeadline', 'scheduleNote'].includes(field.key))
        .map(field => ({ pageUrl: page.url, title: page.title, scope: page.scope, year: page.year, ...field }))),
      previousPageCount: pages.length,
      skipReasons: [...new Set(logIssues.map(issue => issue.reason || issue.message).filter(Boolean))],
      skippedDatePages: logIssues.filter(issue => /year|identity|campus|date|scope|timeout|robots|403|404|412|pdf/i.test(`${issue.reason} ${issue.message}`)),
    };
  });
  const summary = {
    at: new Date().toISOString(), total: rows.length, withDates: audit.filter(row => row.hasDates).length,
    withoutDates: audit.filter(row => !row.hasDates).length,
    withEvidence: audit.filter(row => row.substantiveEvidenceFields.length).length,
    withSources: audit.filter(row => row.sources.length).length,
    statusCounts: Object.fromEntries(['draft', 'pending_review', 'published'].map(status => [status, audit.filter(row => row.publishStatus === status).length])),
    rows: audit,
  };
  fs.writeFileSync(path.join(output, 'audit.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, rows: audit.map(({ index, id, name, publishStatus, hasDates, substantiveEvidenceFields, previousPageCount, previousDateCandidates, skipReasons }) => ({ index, id, name, publishStatus, hasDates, fields: substantiveEvidenceFields.join(','), pages: previousPageCount, dateCandidates: previousDateCandidates.length, reasons: skipReasons.slice(0, 6) })) }, null, 2));
}

inspect().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
