const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const path = require('node:path');

const workspace = path.resolve(__dirname, '..');
const apiRoot = path.join(workspace, 'apps/api');
const apiRequire = createRequire(path.join(apiRoot, 'package.json'));
const stage = fs.mkdtempSync(path.join(tmpdir(), 'competition-delete-browser-'));
const databasePath = path.join(stage, 'test.db');
fs.writeFileSync(databasePath, '');
process.env.DATABASE_URL = `file:${databasePath.split(path.sep).join('/')}`;
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:43841';
const reportPath = path.join(workspace, 'artifacts/document-deletion-check.json');
let app;
let prisma;
let server;
let closing;

async function close() {
  if (closing) return closing;
  closing = (async () => {
    if (server) await new Promise((done) => server.close(done));
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
    process.chdir(workspace);
    fs.rmSync(stage, { recursive: true, force: true });
  })();
  return closing;
}

async function main() {
  execFileSync(process.execPath, [apiRequire.resolve('prisma/build/index.js'), 'db', 'push',
    '--schema', path.join(apiRoot, 'prisma/schema.prisma'), '--skip-generate'], {
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
  prisma = app.get(PrismaService);
  const apiBase = `${await app.getUrl()}/api/v1`;
  const owner = 'u-demo';
  const request = async (route, init = {}, actor = owner) => {
    const headers = { 'x-actor-id': actor, 'x-actor-roles': 'admin,editor,viewer', ...init.headers };
    const response = await fetch(apiBase + route, { ...init, headers });
    const payload = await response.json();
    return { status: response.status, ...payload };
  };
  const text = '2026年文档删除验证竞赛通知\n主办单位：测试大学\n参赛对象：在校大学生\n报名截止：2026年12月1日\n报名网址：https://example.org/register';
  async function upload(name) {
    const form = new FormData();
    form.append('files', new Blob([text], { type: 'text/plain' }), name);
    const uploaded = await request('/documents', { method: 'POST', body: form });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.data.accepted, 1);
    const id = uploaded.data.results[0].documentId;
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = await prisma.competitionDocument.findUniqueOrThrow({ where: { id } });
      if (row.parseStatus === 'succeeded') return row;
      assert.notEqual(row.parseStatus, 'failed');
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('Document parsing timed out');
  }
  const first = await upload('删除功能验证通知.txt');
  const task = await prisma.parseTask.findFirstOrThrow({ where: { documentId: first.id } });
  const preview = await request(`/parse-tasks/${task.id}/preview`);
  assert.equal(preview.status, 200);
  const confirmed = await request(`/parse-tasks/${task.id}/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resultVersionId: preview.data.resultVersionId, fields: { name: '2026年文档删除验证竞赛' } }),
  });
  assert.equal(confirmed.status, 201);
  const competitionId = confirmed.data.id;
  const evidenceBefore = await prisma.fieldEvidence.count({ where: { competitionId } });
  assert.ok(evidenceBefore > 0);
  assert.equal((await request(`/documents/${first.id}`, { method: 'DELETE' }, 'another-user')).status, 404);
  const downloadUrl = (await request('/documents')).data.find(({ id }) => id === first.id).fileUrl;
  assert.equal((await request(`/documents/${first.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(await prisma.competitionDocument.findUnique({ where: { id: first.id } }), null);
  assert.equal(fs.existsSync(path.join(stage, 'uploads', first.storageKey)), false);
  assert.equal(await prisma.fieldEvidence.count({ where: { competitionId } }), evidenceBefore);
  assert.equal((await request(`/competitions/${competitionId}`)).status, 200);
  assert.equal((await request(downloadUrl.replace('/api/v1', ''))).status, 404);
  const replacement = await upload('删除功能验证通知.txt');
  assert.notEqual(replacement.id, first.id);
  const replacementTask = await prisma.parseTask.findFirstOrThrow({ where: { documentId: replacement.id } });
  await prisma.documentCompetitionLink.create({ data: { documentId: replacement.id, competitionId } });
  for (const [label, status] of [['解析失败验证', 'failed'], ['解析中验证', 'processing']]) {
    const key = `${randomUUID()}.txt`;
    const content = Buffer.from(label, 'utf8');
    fs.writeFileSync(path.join(stage, 'uploads', key), content);
    const row = await prisma.competitionDocument.create({ data: {
      ownerId: owner, fileName: `${label}.txt`, mimeType: 'text/plain', detectedType: 'text', size: content.length,
      fingerprint: createHash('sha256').update(content).digest('hex'), storageKey: key,
      expiresAt: new Date('2027-01-01'), parseStatus: status,
    } });
    await prisma.parseTask.create({ data: { documentId: row.id, status, stage: 'extract', progress: 70,
      ...(status === 'failed' ? { errorCode: 'FILE_UNREADABLE', errorMessage: '测试文件解析失败，可删除或重新解析。' } : {}),
    } });
  }
  const webRoot = path.join(workspace, 'apps/web/dist');
  server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/')) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const headers = { ...req.headers };
        delete headers.host;
        delete headers['content-length'];
        const upstream = await fetch(`${await app.getUrl()}${req.url}`, { method: req.method, headers,
          ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }),
        });
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
        res.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let file = path.resolve(webRoot, '.' + pathname);
      if (!file.startsWith(webRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(webRoot, 'index.html');
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise((done) => server.listen(43841, '127.0.0.1', done));
  const report = { checkedAt: new Date().toISOString(), isolation: 'temporary SQLite and upload directory',
    api: { upload: true, parse: true, confirm: true, otherOwnerRejected: true, delete: true,
      originalRemoved: true, oldDownloadRejected: true, competitionPreserved: true, evidencePreserved: true, reupload: true },
    browserUrl: 'http://127.0.0.1:43841/documents', documentId: replacement.id,
    taskId: replacementTask.id, competitionId, evidenceCount: evidenceBefore,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes('--serve')) {
    console.log('Press Enter to stop the isolated browser check server.');
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      void close();
    });
  } else {
    await close();
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void close().then(() => process.exit(0)));
main().catch(async (error) => { console.error(error); await close(); process.exitCode = 1; });
