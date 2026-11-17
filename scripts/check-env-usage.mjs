#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ALLOWLIST_PATH = join(ROOT, 'config.env-allowlist.json');
const REPORT_PATH = join(ROOT, 'artifacts', 'config-gate', 'last-report.json');
const SCAN_ROOTS = ['apps/api/src', 'apps/web/src'];
const SCAN_FILES = ['apps/web/vite.config.ts', 'apps/web/vite.config.js'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_DURATION_MS = 120_000;

const ENV_PATTERNS = [
  { type: 'config_env_read', regex: /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g },
  { type: 'config_env_read_dynamic', regex: /process\.env\[([^\]]+)\]/g },
  { type: 'build_time_env_read', regex: /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g },
];

function walk(directory) {
  const files = [];
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(full));
    else if (EXTENSIONS.has(extname(entry))) files.push(full);
  }
  return files;
}

function loadAllowlist() {
  try {
    return JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  } catch (error) {
    console.error(`[config-gate] 无法读取白名单：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function allowed(entries, file, variable) {
  return entries.some(
    (entry) =>
      entry.file === file && (entry.variable === '*' || entry.variable === variable),
  );
}

function scan() {
  const allowlist = loadAllowlist();
  const files = [
    ...SCAN_ROOTS.flatMap((root) => walk(join(ROOT, root))),
    ...SCAN_FILES.map((file) => join(ROOT, file)).filter((file) => existsSync(file)),
  ];
  const violations = [];
  let scannedLines = 0;

  for (const file of files) {
    const relativePath = relative(ROOT, file).replace(/\\/g, '/');
    const content = readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);
    scannedLines += lines.length;
    lines.forEach((line, index) => {
      for (const pattern of ENV_PATTERNS) {
        pattern.regex.lastIndex = 0;
        let match;
        while ((match = pattern.regex.exec(line)) !== null) {
          const raw = match[1].trim();
          const variable = raw.includes('[') || raw.includes('.') ? '<dynamic>' : raw.replace(/['"]/g, '');
          if (!allowed(allowlist.entries ?? [], relativePath, variable)) {
            violations.push({
              file: relativePath,
              line: index + 1,
              variable,
              type: pattern.type,
            });
          }
        }
      }
    });
  }

  const sameSource = checkSameSource();
  return { allowlist, files, violations, scannedLines, sameSource };
}

function checkSameSource() {
  const pageService = readFileSync(join(ROOT, 'apps/api/src/config/config.service.ts'), 'utf8');
  const health = readFileSync(join(ROOT, 'apps/api/src/controllers/health.controller.ts'), 'utf8');
  const resolver = readFileSync(join(ROOT, 'apps/api/src/config/config-resolver.service.ts'), 'utf8');
  const staticChecks = [
    pageService.includes('this.resolver'),
    pageService.includes('snapshotFingerprint'),
    health.includes('this.resolver'),
    resolver.includes('snapshotFingerprint'),
    resolver.includes('fingerprint'),
  ];
  const runtimePath = join(ROOT, 'artifacts', 'config-gate', 'same-source-runtime.json');
  if (existsSync(runtimePath)) {
    try {
      const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'));
      const runtimePassed = runtime.passed === true && runtime.status !== 'blocked';
      return {
        passed: staticChecks.every(Boolean) && runtimePassed,
        versions: runtime.versions ?? { page: 0, health: 0, log: 0 },
        fingerprint: runtime.fingerprint ?? '',
        runtimeProof: true,
        runtimeStatus: runtime.status ?? 'unknown',
        checks: staticChecks,
      };
    } catch {
      return {
        passed: false,
        versions: { page: 0, health: 0, log: 0 },
        fingerprint: '',
        runtimeProof: true,
        runtimeStatus: 'unreadable',
        checks: staticChecks,
      };
    }
  }
  return {
    passed: staticChecks.every(Boolean),
    versions: { page: 0, health: 0, log: 0 },
    fingerprint: '',
    runtimeProof: false,
    runtimeStatus: 'static_only',
    checks: staticChecks,
  };
}

const startedAt = Date.now();
const scanned = scan();
const durationMs = Date.now() - startedAt;
const passed =
  scanned.violations.length === 0 && scanned.sameSource.passed && durationMs <= MAX_DURATION_MS;

const report = {
  scannedAt: new Date().toISOString(),
  scope: [
    ...SCAN_ROOTS,
    ...SCAN_FILES.map((file) => file.replace(/\\/g, '/')),
  ],
  durationMs,
  whitelist: scanned.allowlist.entries ?? [],
  violations: scanned.violations,
  sameSourceAssertion: {
    passed: scanned.sameSource.passed,
    versions: scanned.sameSource.versions,
    fingerprint: scanned.sameSource.fingerprint,
    runtimeProof: scanned.sameSource.runtimeProof === true,
    runtimeStatus: scanned.sameSource.runtimeStatus ?? 'unknown',
  },
  evidencePath: relative(ROOT, REPORT_PATH).replace(/\\/g, '/'),
  passed,
};

mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`[config-gate] 扫描 ${scanned.files.length} 个文件 / ${scanned.scannedLines} 行，用时 ${durationMs}ms`);
console.log(`[config-gate] 白名单 ${report.whitelist.length} 条，违规 ${report.violations.length} 处`);
console.log(`[config-gate] 同源断言：${report.sameSourceAssertion.passed ? '通过' : '失败'}`);
if (!passed) {
  for (const violation of report.violations) {
    console.error(
      `[config-gate] ${violation.file}:${violation.line} ${violation.variable} (${violation.type})`,
    );
  }
  if (!report.sameSourceAssertion.passed) {
    console.error('[config-gate] 配置页、健康检查与运行快照未证明同源');
  }
  console.error(`[config-gate] 报告：${report.evidencePath}`);
  process.exit(1);
}
console.log(`[config-gate] 通过；报告：${report.evidencePath}`);