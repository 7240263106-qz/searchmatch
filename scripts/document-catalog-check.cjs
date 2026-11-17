const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const documentId = process.argv.find(value => value.startsWith('--document='))?.slice('--document='.length);
  assert.ok(documentId, 'Pass --document=<id>; add --reparse to make actual configured model requests.');
  const base = 'http://127.0.0.1:3000/api/v1';
  const headers = { 'x-actor-id': 'u-demo', 'x-actor-roles': 'admin,viewer', 'content-type': 'application/json' };
  async function request(url, body) {
    const response = await fetch(base + url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json();
    assert.ok(response.ok, `${url}: HTTP ${response.status} ${payload.error?.message ?? ''}`);
    return payload.data;
  }
  let taskId;
  if (process.argv.includes('--reparse')) taskId = (await request(`/documents/${documentId}/parse`, { trigger: 'reparse' })).taskId;
  let run;
  let state = '';
  for (let attempt = 0; attempt < 120; attempt++) {
    const data = await request(`/documents/${documentId}/runs`);
    run = taskId ? data.runs.find(item => item.id === taskId) : data.runs[0];
    assert.ok(run, 'No document task');
    taskId = run.id;
    const next = `${run.status}; logs=${run.trace?.logs.length ?? 0}`;
    if (next !== state) { console.log(`${taskId}: ${next}`); state = next; }
    if (!['queued', 'processing'].includes(run.status)) break;
    await new Promise(done => setTimeout(done, 1000));
  }
  assert.equal(run.status, 'succeeded');
  const preview = await request(`/parse-tasks/${taskId}/preview`);
  const source = fs.readFileSync(path.join(__dirname, '../apps/api/src/domain/fixtures/recognition-catalog.txt'), 'utf8');
  const expected = [...source.matchAll(/^(\d+)\n([\s\S]*?)\n([ABC]类)(?=\n|$)/gm)].map(match => ({ sequence: Number(match[1]), name: match[2].replace(/\s+/g, ''), grade: match[3] }));
  const items = preview.catalog?.competitions ?? [];
  const checks = { expectedRows: expected.length, actualRows: items.length, matchedRows: expected.filter(row => items.some(item => item.sequence === row.sequence && item.name.replace(/\s+/g, '') === row.name && item.schoolRecognitionLevel === row.grade)).length,
    modelUsed: run.trace?.extraction?.status === 'used', modelValidatedRows: run.trace?.extraction?.catalog?.validatedRows ?? 0 };
  const output = { checkedAt: new Date().toISOString(), documentId, taskId, checks, run, preview };
  fs.writeFileSync(path.join(__dirname, '../artifacts/document-catalog-live-check.json'), JSON.stringify(output, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(__dirname, '../artifacts/document-catalog-competitions.json'), JSON.stringify(preview.catalog, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ checks, result: run.result?.catalog, durationMs: run.durationMs, model: run.trace?.extraction }, null, 2));
  assert.equal(checks.expectedRows, 71); assert.equal(checks.actualRows, 71); assert.equal(checks.matchedRows, 71);
  assert.equal(checks.modelUsed, true); assert.equal(checks.modelValidatedRows, 71);
  assert.deepEqual(run.result.catalog.gradeCounts, { 'A类': 5, 'B类': 14, 'C类': 52 });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
