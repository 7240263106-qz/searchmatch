const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

const workspace = path.resolve(__dirname, '..');
const apiRoot = path.join(workspace, 'apps/api');
const apiRequire = createRequire(path.join(apiRoot, 'package.json'));
const stage = path.join(workspace, 'artifacts/catalog-http-check', randomUUID());
fs.mkdirSync(stage, { recursive: true });
const databasePath = path.join(stage, 'test.db');
fs.writeFileSync(databasePath, '');
process.env.DATABASE_URL = `file:${databasePath.split(path.sep).join('/')}`;
let app;

async function main() {
  const actual = JSON.parse(fs.readFileSync(path.join(workspace, 'artifacts/document-catalog-live-check.json'), 'utf8'));
  assert.equal(actual.checks.modelValidatedRows, 71);
  execFileSync(process.execPath, [apiRequire.resolve('prisma/build/index.js'), 'db', 'push', '--schema', path.join(apiRoot, 'prisma/schema.prisma'), '--skip-generate'], {
    cwd: apiRoot, env: process.env, stdio: 'pipe', timeout: 30000,
  });
  process.chdir(stage);
  apiRequire('reflect-metadata');
  const { NestFactory } = apiRequire('@nestjs/core');
  const { AppModule } = apiRequire('./dist/app.module.js');
  const { PrismaService } = apiRequire('./dist/platform/prisma.module.js');
  const { ApiExceptionFilter } = apiRequire('./dist/platform/api-exception.filter.js');
  const { TransformInterceptor } = apiRequire('./dist/platform/transform.interceptor.js');
  app = await NestFactory.create(AppModule, { logger: ['warn', 'error'] });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  await app.listen(0, '127.0.0.1');
  const prisma = app.get(PrismaService);
  const base = `${await app.getUrl()}/api/v1`;
  const owner = 'catalog-http-owner';
  const doc = await prisma.competitionDocument.create({ data: { fileName: '目录验证.pdf', mimeType: 'application/pdf', detectedType: 'pdf',
    ownerId: owner, fingerprint: randomUUID(), storageKey: 'isolated-catalog.pdf', size: 100, expiresAt: new Date('2027-01-01'), parseStatus: 'succeeded' } });
  const task = await prisma.parseTask.create({ data: { documentId: doc.id, status: 'succeeded', stage: 'done', progress: 100 } });
  const catalog = actual.preview.catalog;
  const version = await prisma.parseResultVersion.create({ data: { documentId: doc.id, taskId: task.id, versionNo: 1,
    adopted: true, modelVersion: 'llm-v1', resultJson: JSON.stringify({ extraction: { catalog, fields: [], conflicts: [], missing: [], competitionName: null, summary: '', textPreview: '目录' },
      fileName: doc.fileName, textPreview: '目录', source: 'llm', degraded: false }) } });
  const body = { resultVersionId: version.id, items: catalog.competitions.map(({ sequence, name, schoolRecognitionLevel }) => ({ sequence, name, schoolRecognitionLevel })) };
  async function request(route, data, actor = owner) {
    const response = await fetch(base + route, { method: data ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-actor-id': actor, 'x-actor-roles': 'admin,editor,viewer' }, body: data ? JSON.stringify(data) : undefined });
    return { status: response.status, ...(await response.json()) };
  }
  const route = `/parse-tasks/${task.id}/catalog/confirm`;
  assert.equal((await request(route, body, 'other-owner')).status, 404);
  assert.equal((await request(route, { ...body, resultVersionId: 'stale' })).status, 409);
  assert.equal((await request(route, { ...body, items: [body.items[0], { ...body.items[1], schoolRecognitionLevel: '国家级' }] })).status, 400);
  assert.equal(await prisma.competition.count(), 0);
  const saved = await request(route, body);
  assert.equal(saved.status, 201); assert.equal(saved.data.count, 71);
  const again = await request(route, body);
  assert.deepEqual(again.data.items.map(item => item.id), saved.data.items.map(item => item.id));
  assert.equal(await prisma.competition.count(), 71);
  const detail = await request(`/competitions/${saved.data.items[0].id}`);
  assert.equal(detail.data.schoolRecognitionLevel, 'A类');
  assert.equal(detail.data.schoolRecognitionScope, '江苏师范大学科文学院');
  assert.equal(detail.data.level, null); assert.deepEqual(detail.data.entries, []);
  const evidence = await prisma.fieldEvidence.findMany({ where: { fieldName: 'schoolRecognitionLevel' } });
  assert.equal(evidence.length, 71);
  const counts = Object.fromEntries(['A类', 'B类', 'C类'].map(grade => [grade, evidence.filter(item => item.fieldValue === grade).length]));
  assert.deepEqual(counts, { 'A类': 5, 'B类': 14, 'C类': 52 });
  const report = { checkedAt: new Date().toISOString(), isolatedDatabase: path.relative(workspace, databasePath), productionDatabaseModified: false,
    checks: { httpBatchSave: true, ownerGuard: true, staleVersionGuard: true, invalidGradeAtomic: true, repeatSaveIdempotent: true,
      persistedRows: saved.data.count, persistedGradeCounts: counts, schoolScopePreserved: true, missingSignupNotInvented: true } };
  fs.writeFileSync(path.join(workspace, 'artifacts/document-catalog-http-check.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (app) await app.close(); process.chdir(workspace); });
