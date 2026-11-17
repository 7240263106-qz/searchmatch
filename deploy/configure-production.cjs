const { PrismaClient } = require('../apps/api/node_modules/@prisma/client');
const { CONFIG_ITEMS } = require('../apps/api/dist/config/config-items');

const database = process.env.DATABASE_URL;
if (database !== 'file:/opt/competition-sj/shared/competition.db') {
  throw new Error('仅允许修改服务器持久化数据库');
}
const publicBaseUrl = (process.env.COMPETITION_PUBLIC_BASE_URL || '').replace(/\/$/, '');
if (!publicBaseUrl) throw new Error('必须通过 COMPETITION_PUBLIC_BASE_URL 指定对外访问地址');
const publicOrigin = new URL(publicBaseUrl).origin;
const corsOrigins = Array.from(new Set([
  publicOrigin,
  ...(process.env.COMPETITION_CORS_ORIGINS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
]));
const prisma = new PrismaClient();
const overrides = {
  'env.profile': 'prod',
  'server.listenHost': '127.0.0.1',
  'server.port': 3011,
  'server.publicBaseUrl': publicBaseUrl,
  'server.corsOrigins': corsOrigins,
  'parser.baseUrl': 'http://127.0.0.1:8011',
  'auth.devIdentityEnabled': false,
  'auth.deploymentActorId': 'u-demo',
  'model.enabled': false,
  'model.baseUrl': '',
};

async function main() {
  const latest = await prisma.systemConfigVersion.findFirst({ orderBy: { version: 'desc' } });
  if (!latest) throw new Error('缺少审核数据库配置，禁止创建空库');
  const previous = await prisma.systemConfigValue.findMany({ where: { versionNo: latest.version } });
  if (Object.entries(overrides).every(([key, value]) => previous.some(row => row.key === key && row.valueJson === JSON.stringify(value)))) {
    console.log(JSON.stringify({ version: latest.version, unchanged: true }));
    return;
  }
  const version = latest.version + 1;
  const values = previous.map(({ id, createdAt, ...row }) => ({ ...row, versionNo: version }));
  for (const [key, value] of Object.entries(overrides)) {
    const definition = CONFIG_ITEMS.find(item => item.key === key);
    if (!definition) throw new Error(`未知配置 ${key}`);
    let row = values.find(item => item.key === key && item.scope === definition.scope);
    if (!row) {
      row = { versionNo: version, key, group: definition.group, scope: definition.scope,
        valueJson: null, source: 'page_saved', secretRefId: null, maskedTail: null, configured: false };
      values.push(row);
    }
    row.valueJson = JSON.stringify(value);
    row.source = 'page_saved';
  }
  await prisma.$transaction(async transaction => {
    await transaction.systemConfigVersion.create({ data: { version, baseVersion: latest.version,
      actorId: 'deployment', actorRole: 'system', reason: 'HTTPS登录网关下的独立单用户生产部署',
      applyState: 'applied', changeCount: Object.keys(overrides).length } });
    await transaction.systemConfigValue.createMany({ data: values });
    for (const [key, value] of Object.entries(overrides)) {
      const definition = CONFIG_ITEMS.find(item => item.key === key);
      const valueJson = JSON.stringify(value);
      await transaction.configApplyState.upsert({ where: { key },
        create: { key, group: definition.group, versionNo: version, savedValueJson: valueJson,
          runtimeValueJson: valueJson, applyState: 'applied' },
        update: { versionNo: version, savedValueJson: valueJson, runtimeValueJson: valueJson,
          applyState: 'applied', pendingRestartAt: null, runtimeMismatch: false } });
      await transaction.configChangeRecord.create({ data: { versionNo: version, key,
        group: definition.group, scope: definition.scope,
        beforeValueJson: previous.find(row => row.key === key)?.valueJson ?? null,
        afterValueJson: valueJson, applyMode: definition.applyMode, actorId: 'deployment' } });
    }
  });
  console.log(JSON.stringify({ version, profile: 'prod', modelEnabled: false, deploymentActor: 'u-demo' }));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
