const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const release = path.resolve(process.argv[2] ?? '');
if (!release.startsWith(path.join(root, 'artifacts/deployments') + path.sep)) throw new Error('仅允许验证部署产物');
const api = path.join(release, 'apps/api');
const directory = path.dirname(release);
const database = path.join(directory, `smoke-test-${Date.now()}.db`);
if (fs.existsSync(database)) throw new Error('测试数据库已存在，禁止覆盖');
fs.copyFileSync(path.join(release, 'deployment-data/competition.db'), database, fs.constants.COPYFILE_EXCL);
const { PrismaClient } = require(path.join(api, 'node_modules/@prisma/client'));
const { CONFIG_ITEMS } = require(path.join(api, 'dist/config/config-items'));
const prisma = new PrismaClient({ datasources: { db: { url: `file:${database.replace(/\\/g, '/')}` } } });
const port = 13011;
const base = `http://127.0.0.1:${port}/api/v1`;

async function main() {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
  const version = (await prisma.systemConfigVersion.findFirst({ orderBy: { version: 'desc' } })).version;
  const overrides = {
    'env.profile': 'prod', 'server.listenHost': '127.0.0.1', 'server.port': port,
    'server.publicBaseUrl': `http://127.0.0.1:${port}`, 'model.enabled': false,
    'auth.devIdentityEnabled': false, 'auth.deploymentActorId': 'u-demo',
  };
  for (const [key, value] of Object.entries(overrides)) {
    const definition = CONFIG_ITEMS.find(item => item.key === key);
    if (!definition) throw new Error(`Unknown configuration: ${key}`);
    const { group, scope } = definition;
    const valueJson = JSON.stringify(value);
    await prisma.systemConfigValue.upsert({ where: { versionNo_key_scope: { versionNo: version, key, scope } },
      create: { versionNo: version, key, group, scope, valueJson, source: 'page_saved' },
      update: { valueJson, source: 'page_saved' } });
    await prisma.configApplyState.upsert({ where: { key },
      create: { key, group, versionNo: version, savedValueJson: valueJson, runtimeValueJson: valueJson, applyState: 'applied' },
      update: { versionNo: version, savedValueJson: valueJson, runtimeValueJson: valueJson,
        applyState: 'applied', pendingRestartAt: null, runtimeMismatch: false } });
  }
  await prisma.$disconnect();
  const memory = [];
  let log = '';
  const child = spawn(process.execPath, ['--max-old-space-size=192', '-e',
    "setInterval(()=>console.log('__MEMORY__'+JSON.stringify(process.memoryUsage())),1000).unref();require('./dist/main.js')"],
    { cwd: api, env: { ...process.env, DATABASE_URL: `file:${database.replace(/\\/g, '/')}`, APP_ENV: 'prod', NODE_ENV: 'production' },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const receive = data => {
    const text = data.toString();
    log += text;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('__MEMORY__')) {
        try { memory.push(JSON.parse(line.slice(10))); } catch {}
      }
    }
  };
  child.stdout.on('data', receive);
  child.stderr.on('data', receive);
  const exited = new Promise(resolve => child.once('exit', resolve));
  const started = Date.now();
  async function request(endpoint, body, headers = {}) {
    const response = await fetch(base + endpoint, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (child.exitCode !== null) throw new Error(`API exited ${child.exitCode}`);
      try {
        const result = await request('/healthz');
        if (result.status === 200) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('API startup timeout');
    const startupMs = Date.now() - started;
    const bootstrap = await request('/system/client-bootstrap');
    const workspace = await request('/search/competitions', { scope: 'workspace', includeExpired: true, includeLowCredibility: true, limit: 100 });
    const published = await request('/search/competitions', { scope: 'published', includeExpired: true, includeLowCredibility: true, limit: 100 });
    const documents = await request('/documents');
    const denied = await request('/system/client-bootstrap', null, { 'X-Actor-Id': 'attacker' });
    const checks = {
      profile: bootstrap.body.data?.profile,
      devIdentityAllowed: bootstrap.body.data?.devIdentityAllowed,
      workspaceStatus: workspace.status,
      workspaceRecords: workspace.body.data?.page?.total,
      publishedStatus: published.status,
      publishedRecords: published.body.data?.page?.total,
      documentsStatus: documents.status,
      originalDocuments: documents.body.data?.length,
      identityHeaderStatus: denied.status,
    };
    if (checks.profile !== 'prod' || checks.devIdentityAllowed !== false
      || checks.workspaceRecords !== 72 || checks.publishedRecords !== 64
      || checks.originalDocuments !== 2 || checks.identityHeaderStatus < 400) {
      throw new Error(`Smoke assertions failed: ${JSON.stringify(checks)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 4000));
    const result = { checkedAt: new Date().toISOString(), passed: true, platform: process.platform,
      nodeVersion: process.version, heapLimitMiB: 192, startupMs,
      workspaceRecords: workspace.body.data.page.total, publishedRecords: published.body.data.page.total,
      originalDocuments: documents.body.data.length, productionIdentityHeaderRejected: denied.status,
      runtimeSamples: memory,
      peakRssMiB: memory.length ? Math.max(...memory.map(item => item.rss)) / 1024 ** 2 : null,
      measurementLimit: 'Windows process smoke measurement; not a measurement of Linux server RSS or parser memory',
      originalDatabaseModified: false };
    fs.writeFileSync(path.join(directory, 'lean-smoke-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    child.kill();
    await exited;
    fs.writeFileSync(path.join(directory, 'lean-smoke.log'), log);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
