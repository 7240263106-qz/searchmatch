#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUTPUT = join(ROOT, 'artifacts', 'config-gate', 'gate-selfcheck.json');
const VIOLATION_FILE = join(ROOT, 'apps', 'api', 'src', 'config', '__gate_violation__.ts');
const SAME_SOURCE = join(ROOT, 'artifacts', 'config-gate', 'same-source-runtime.json');

function runGate() {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-env-usage.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return { exit: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

const cases = [];
const sameSourceBackup = existsSync(SAME_SOURCE) ? readFileSync(SAME_SOURCE, 'utf8') : null;

try {
  writeFileSync(VIOLATION_FILE, 'export const leaked = process.env.UNREGISTERED_SECRET;\n');
  const envRead = runGate();
  cases.push({
    name: 'env_read_violation',
    expectedExit: 1,
    actualExit: envRead.exit,
    passed: envRead.exit === 1,
    evidence: envRead.output.split(/\r?\n/).slice(0, 4).join(' | '),
  });

  writeFileSync(
    VIOLATION_FILE,
    "const dynamicKey = 'SECRET_' + 'X';\nexport const leaked = process.env[dynamicKey];\n",
  );
  const dynamicKey = runGate();
  cases.push({
    name: 'dynamic_key_violation',
    expectedExit: 1,
    actualExit: dynamicKey.exit,
    passed: dynamicKey.exit === 1,
    evidence: dynamicKey.output.split(/\r?\n/).slice(0, 4).join(' | '),
  });
} finally {
  if (existsSync(VIOLATION_FILE)) unlinkSync(VIOLATION_FILE);
}

try {
  writeFileSync(
    SAME_SOURCE,
    `${JSON.stringify(
      {
        status: 'failed',
        passed: false,
        versions: { page: 10, health: 9, log: 8 },
        fingerprint: 'inconsistent',
      },
      null,
      2,
    )}\n`,
  );
  const sameSource = runGate();
  cases.push({
    name: 'same_source_inconsistent',
    expectedExit: 1,
    actualExit: sameSource.exit,
    passed: sameSource.exit === 1,
    evidence: sameSource.output.split(/\r?\n/).slice(0, 4).join(' | '),
  });
} finally {
  if (sameSourceBackup !== null) writeFileSync(SAME_SOURCE, sameSourceBackup, 'utf8');
  else if (existsSync(SAME_SOURCE)) unlinkSync(SAME_SOURCE);
}

const report = {
  checkedAt: new Date().toISOString(),
  cases,
  passed: cases.every((entry) => entry.passed),
  notConstructed: [
    {
      name: 'scan_timeout',
      reason: '脚本执行 51ms，未达到 120s 上限；超时分支以代码审查替代，未构造真实超时。',
      status: 'partial',
    },
    {
      name: 'unregistered_config_item',
      reason: '新增配置项必须先登记定义；本轮未新增配置项，无法在不改配置清单的前提下构造。',
      status: 'blocked',
    },
  ],
  evidencePath: 'artifacts/config-gate/gate-selfcheck.json',
};
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`[gate-selfcheck] ${cases.filter((entry) => entry.passed).length}/${cases.length} 类违规被阻断`);
console.log(`[gate-selfcheck] 报告：${report.evidencePath}`);
process.exit(report.passed ? 0 : 1);