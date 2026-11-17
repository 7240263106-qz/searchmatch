const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const candidate = path.resolve(process.argv[2] ?? '');
const output = path.resolve(process.argv[3] ?? '');
const source = path.join(root, 'artifacts/deployments/server-20261117-02/competition-sj');
const boundary = path.join(root, 'artifacts/deployments') + path.sep;
if (!candidate.startsWith(boundary) || !output.startsWith(boundary) || fs.existsSync(output)) {
  throw new Error('仅允许在部署产物目录中创建新的精简包');
}
const app = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json')));
if (app.name !== '@competition/api') throw new Error('输入不是独立生产依赖目录');
const packages = new Map();

function resolvePackage(name, from) {
  const resolver = Module.createRequire(path.join(from, 'package.json'));
  for (const directory of resolver.resolve.paths(name) ?? []) {
    const file = path.join(directory, name, 'package.json');
    if (fs.existsSync(file)) {
      const found = fs.realpathSync(path.dirname(file));
      if (!found.startsWith(candidate + path.sep)) throw new Error(`依赖越界：${name}`);
      return found;
    }
  }
  return null;
}

function trace(directory) {
  if (packages.has(directory)) return;
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
  const edges = new Map();
  packages.set(directory, { manifest, edges });
  const required = new Set(Object.keys(manifest.dependencies ?? {}));
  const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (manifest.peerDependenciesMeta?.[name]?.optional !== true) required.add(name);
  }
  for (const name of new Set([...required, ...optional])) {
    const target = resolvePackage(name, directory);
    if (!target) {
      if (optional.has(name)) continue;
      throw new Error(`运行依赖缺失：${manifest.name} -> ${name}`);
    }
    edges.set(name, target);
    trace(target);
  }
}

const roots = new Map();
for (const name of Object.keys(app.dependencies)) {
  const directory = resolvePackage(name, candidate);
  if (!directory) throw new Error(`根依赖缺失：${name}`);
  roots.set(name, directory);
  trace(directory);
}

const api = path.join(output, 'apps/api');
fs.mkdirSync(api, { recursive: true });
const locations = new Map();
for (const directory of packages.keys()) {
  locations.set(directory, path.join(api, path.relative(candidate, directory)));
}

function copyRuntime(directory, destination, name) {
  fs.cpSync(directory, destination, { recursive: true, filter(file) {
    const relative = path.relative(directory, file).replace(/\\/g, '/');
    if (/\.(?:map|d\.ts|md|tsbuildinfo)$/.test(relative)) return false;
    if (name === '@prisma/client') {
      if (JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))).version !== '6.19.3') {
        throw new Error('Prisma版本改变，需重新验证引擎裁剪规则');
      }
      if (relative.startsWith('runtime/') && /(?:query_engine_bg|query_compiler_bg|\.wasm)/.test(relative)) return false;
      if (/^(?:generator-build|scripts)(?:\/|$)/.test(relative)) return false;
    }
    return true;
  } });
}

function link(name, parent, target) {
  const destination = path.join(parent, 'node_modules', name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
}

for (const [directory, item] of packages) copyRuntime(directory, locations.get(directory), item.manifest.name);
for (const [directory, item] of packages) {
  for (const [name, target] of item.edges) link(name, locations.get(directory), locations.get(target));
}
for (const [name, directory] of roots) link(name, api, locations.get(directory));

fs.cpSync(path.join(source, 'apps/api/dist'), path.join(api, 'dist'), { recursive: true,
  filter: file => !/\.(?:map|tsbuildinfo)$|\.test\.js$/.test(file) });
fs.writeFileSync(path.join(api, 'package.json'), JSON.stringify({ name: app.name, version: app.version,
  private: true, scripts: { start: 'node dist/main.js' }, dependencies: app.dependencies }, null, 2));
for (const entry of ['apps/web/dist', 'apps/parser/app', 'apps/parser/pyproject.toml', 'deployment-data', 'deploy']) {
  fs.cpSync(path.join(source, entry), path.join(output, entry), { recursive: true });
}
fs.cpSync(path.join(root, 'deploy'), path.join(output, 'deploy'), { recursive: true });

const schemaDirectory = path.join(candidate, 'prisma-lean-build');
fs.mkdirSync(schemaDirectory, { recursive: true });
const generated = path.join(api, 'node_modules/.prisma/client').replace(/\\/g, '/');
const schema = fs.readFileSync(path.join(source, 'apps/api/prisma/schema.prisma'), 'utf8')
  .replace('provider = "prisma-client-js"', `provider = "prisma-client-js"\n  output = "${generated}"\n  binaryTargets = ["native", "debian-openssl-3.0.x"]`);
const schemaFile = path.join(schemaDirectory, 'schema.prisma');
fs.writeFileSync(schemaFile, schema);
execFileSync(process.execPath, [path.join(root, 'apps/api/node_modules/prisma/build/index.js'),
  'generate', '--schema', schemaFile], { cwd: root, stdio: 'inherit',
  env: { ...process.env, PRISMA_GENERATE_SKIP_AUTOINSTALL: 'true' } });
if (!fs.existsSync(path.join(generated, 'libquery_engine-debian-openssl-3.0.x.so.node'))) {
  throw new Error('缺少Linux NAPI引擎');
}
const result = { target: 'Ubuntu 22.04 x86_64 / OpenSSL 3 / Node 22 / SQLite',
  output, runtimePackageCount: packages.size, originalProductionPackages: 140,
  removedOptionalBuildPeers: ['prisma', 'typescript'],
  excludedPrismaTargets: 'WASM query engine/compiler assets; native NAPI library retained',
  linuxEngineIncluded: true, credentialsIncluded: false,
  packages: [...packages.values()].map(item => ({ name: item.manifest.name, version: item.manifest.version })) };
fs.writeFileSync(path.join(path.dirname(output), 'lean-build.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, packages: undefined }, null, 2));
