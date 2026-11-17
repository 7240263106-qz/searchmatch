const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('../apps/api/node_modules/@prisma/client');

const root = path.resolve(__dirname, '..');
const releaseId = process.argv[2];
const withBuild = process.argv.includes('--with-build');
if (!releaseId || !/^[a-z0-9][a-z0-9-]{0,70}$/.test(releaseId)) {
  throw new Error('请提供唯一发布标识，例如 server-20261117-01');
}
const output = path.join(root, 'artifacts', 'deployments', releaseId);
if (fs.existsSync(output)) throw new Error('发布目录已存在，禁止覆盖已有快照');
const staging = path.join(output, 'competition-sj');
const prisma = new PrismaClient();
const excluded = new Set(['node_modules', '.pnpm-store', '.credentials', '__pycache__', '.venv',
  '.pytest_cache', 'dist', 'uploads', 'storage', 'artifacts', '.git', '.codeartsdoer']);
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function include(source) {
  const parts = path.relative(root, source).split(path.sep);
  const name = path.basename(source);
  return !parts.some(part => excluded.has(part))
    && (!name.startsWith('.env') || name === '.env.example')
    && !/\.(?:db(?:-wal|-shm|-journal)?|log|pyc)$/i.test(name);
}

function inventory(directory, base = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('发布包中不允许符号链接');
    if (entry.isDirectory()) return inventory(file, base);
    return [{ path: path.relative(base, file).replace(/\\/g, '/'), bytes: fs.statSync(file).size, sha256: digest(file) }];
  });
}

async function main() {
  fs.mkdirSync(staging, { recursive: true });
  for (const entry of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc',
    'config.env-allowlist.json', 'apps', 'packages', 'scripts', 'tests', 'deploy']) {
    fs.cpSync(path.join(root, entry), path.join(staging, entry), { recursive: true, filter: include });
  }
  if (withBuild) {
    for (const entry of ['apps/api/dist', 'apps/web/dist', 'packages/contracts/dist']) {
      if (!fs.existsSync(path.join(root, entry))) throw new Error(`构建产物缺失：${entry}`);
      fs.cpSync(path.join(root, entry), path.join(staging, entry), { recursive: true });
    }
  }
  const data = path.join(staging, 'deployment-data');
  fs.mkdirSync(path.join(data, 'uploads'), { recursive: true });
  const database = path.join(data, 'competition.db');
  await prisma.$executeRawUnsafe(`VACUUM INTO '${database.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  const snapshot = new PrismaClient({ datasources: { db: { url: `file:${database.replace(/\\/g, '/')}` } } });
  let catalog;
  try {
    const integrity = await snapshot.$queryRawUnsafe('PRAGMA integrity_check');
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('SQLite快照完整性检查失败');
    const where = { deletedAt: null, dataOrigin: 'formal', demoFlag: false, parentId: null };
    const rows = await snapshot.competition.findMany({ where, select: { id: true, name: true, publishStatus: true, versionNo: true } });
    const documents = await snapshot.competitionDocument.findMany({ select: { id: true, fileName: true, storageKey: true } });
    for (const document of documents) {
      if (!/^[a-zA-Z0-9._-]+$/.test(document.storageKey) || document.storageKey.includes('..')) {
        throw new Error('文档存储路径不安全');
      }
      const source = path.join(root, 'apps', 'api', 'uploads', document.storageKey);
      if (!fs.existsSync(source)) throw new Error(`原件缺失：${document.fileName}`);
      fs.copyFileSync(source, path.join(data, 'uploads', document.storageKey));
    }
    catalog = { total: rows.length, published: rows.filter(row => row.publishStatus === 'published').length,
      draft: rows.filter(row => row.publishStatus === 'draft').length, documents: documents.length,
      integrity: 'ok', rows };
    if (catalog.total !== 72 || catalog.published !== 64 || catalog.draft !== 8) {
      throw new Error('竞赛数量已变化，请重新审核部署范围');
    }
  } finally {
    await snapshot.$disconnect();
  }
  fs.writeFileSync(path.join(data, 'catalog-counts.json'), JSON.stringify(catalog, null, 2));
  fs.copyFileSync(path.join(root, 'artifacts', 'catalog-review-20261116', '竞赛逐项审核报告-20261117.md'),
    path.join(data, '竞赛逐项审核报告-20261117.md'));
  const files = inventory(staging);
    if (files.some(file => file.path.split('/').some(part => excluded.has(part) && part !== 'uploads' && !(withBuild && part === 'dist'))
    || /(?:^|\/)\.env(?!\.example$)|vault\.(?:key|enc\.json)$/.test(file.path))) {
    throw new Error('发布包包含不允许的本机运行文件');
  }
  const manifest = { releaseId, preparedAt: new Date().toISOString(), target: '47.116.143.62',
    state: 'prepared_not_uploaded', built: withBuild, catalog, credentialsIncluded: false, files };
  fs.writeFileSync(path.join(staging, 'RELEASE-MANIFEST.json'), JSON.stringify(manifest, null, 2));
  const archive = path.join(output, `${releaseId}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', output, 'competition-sj'], { stdio: 'pipe' });
  const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  if (!listing.includes('competition-sj/deployment-data/competition.db')
    || !listing.includes('competition-sj/RELEASE-MANIFEST.json')) throw new Error('归档缺少数据库或清单');
  const result = { releaseId, archive, sha256: digest(archive), bytes: fs.statSync(archive).size,
    files: files.length, catalog: { total: catalog.total, published: catalog.published,
      draft: catalog.draft, documents: catalog.documents }, state: manifest.state };
  fs.writeFileSync(path.join(output, 'preparation-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
