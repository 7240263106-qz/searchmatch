#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DIR = join(ROOT, 'artifacts', 'config-gate');
const OUTPUT = join(DIR, 'summary-report.json');

function read(name) {
  const path = join(DIR, name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const gate = read('last-report.json');
const sameSource = read('same-source-runtime.json');
const network = read('network-report.json');
const concurrency = read('concurrency-report.json');
const gateSelfcheck = read('gate-selfcheck.json');
const bootstrapLog = read('client-bootstrap-log.jsonl') ? null : null;

const checks = [];

checks.push({
  id: '37.1-gate-static',
  status: gate ? (gate.passed ? 'verified' : 'failed') : 'blocked',
  detail: gate
    ? `违规 ${gate.violations.length} 处；报告 ${gate.evidencePath}`
    : '无门禁报告，需执行 pnpm gate:env',
});

checks.push({
  id: '37.5-same-source-runtime',
  status: sameSource
    ? sameSource.status === 'verified'
      ? 'verified'
      : sameSource.status === 'blocked'
        ? 'blocked'
        : 'failed'
    : 'blocked',
  detail: sameSource
    ? `页面 v${sameSource.versions?.page ?? 0} / 健康 v${sameSource.versions?.health ?? 0} / 下发 v${sameSource.versions?.log ?? 0}`
    : '需 API 运行后执行 node scripts/check-config-same-source.mjs',
});

checks.push({
  id: '37.6-gate-non-degradable',
  status: gateSelfcheck ? (gateSelfcheck.passed ? 'verified' : 'failed') : 'blocked',
  detail: gateSelfcheck
    ? `${gateSelfcheck.cases.filter((entry) => entry.passed).length}/${gateSelfcheck.cases.length} 类违规被阻断；未构造项 ${gateSelfcheck.notConstructed.length}`
    : '需执行 node scripts/config-gate-selfcheck.mjs',
});

if (concurrency) {
  const scenarios = concurrency.scenarios ?? [];
  const executed = scenarios.filter((entry) => entry.passed !== null);
  checks.push({
    id: '39.1/39.4-concurrency',
    status:
      concurrency.status === 'verified'
        ? 'verified'
        : concurrency.status === 'blocked'
          ? 'blocked'
          : executed.some((entry) => entry.passed === false)
            ? 'failed'
            : 'partial',
    detail: `${executed.filter((entry) => entry.passed === true).length}/${executed.length} 场景通过；阻塞 ${scenarios.filter((entry) => entry.passed === null).length} 项`,
  });
} else {
  checks.push({ id: '39.1/39.4-concurrency', status: 'blocked', detail: '需 API 运行后执行并发脚本' });
}

if (network) {
  checks.push({
    id: '39.3-network',
    status:
      network.status === 'blocked'
        ? 'blocked'
        : network.results?.some((entry) => entry.status === 'verified')
          ? 'partial'
          : 'blocked',
    detail: network.results
      ?.map((entry) => `${entry.target}:${entry.status}${entry.result ? `(${entry.result})` : ''}`)
      .join('；') ?? '无结果',
  });
} else {
  checks.push({ id: '39.3-network', status: 'blocked', detail: '需 API 运行后执行网络检查脚本' });
}

checks.push({
  id: '38.4-remote-storage',
  status: 'blocked',
  detail: '本机无 MinIO/S3 与真实网络，远端对象存储桶切换未实测；已实现 S3 兼容适配器并保留降级状态。',
});

checks.push({
  id: '38.5-artifact-availability',
  status: 'partial',
  detail: '已实现逐项 availability 派生与不可访问原因；真实切换后的迁移状态无真实桶可验。',
});

checks.push({
  id: '38.6-postgres-tls-rotation',
  status: 'blocked',
  detail: '本机为 SQLite，PostgreSQL 库名切换、TLS 强制与真实凭据轮换未实测。',
});

checks.push({
  id: '36.4/36.5-browser-runtime',
  status: 'blocked',
  detail: '无 Playwright 浏览器环境，断网/503/超时与缓存过期未在真实浏览器实测；接口侧 200/304/503 已验。',
});

const failed = checks.filter((entry) => entry.status === 'failed');
const blocked = checks.filter((entry) => entry.status === 'blocked');
const partial = checks.filter((entry) => entry.status === 'partial');
const verified = checks.filter((entry) => entry.status === 'verified');

const report = {
  status: failed.length > 0 ? 'failed' : blocked.length > 0 || partial.length > 0 ? 'partial' : 'verified',
  generatedAt: new Date().toISOString(),
  summary: {
    verified: verified.length,
    partial: partial.length,
    blocked: blocked.length,
    failed: failed.length,
  },
  checks,
  evidence: {
    gate: 'artifacts/config-gate/last-report.json',
    sameSource: 'artifacts/config-gate/same-source-runtime.json',
    gateSelfcheck: 'artifacts/config-gate/gate-selfcheck.json',
    network: 'artifacts/config-gate/network-report.json',
    concurrency: 'artifacts/config-gate/concurrency-report.json',
    bootstrapLog: 'artifacts/config-gate/client-bootstrap-log.jsonl',
  },
  acceptance: 'tests/acceptance/REQ-CONF-23-26.yaml',
  note:
    '存在 blocked/partial 时不得输出“全部通过”；真实联网、远端存储、PostgreSQL 与浏览器场景需在对应环境补验。',
};
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(
  `[config-verify] verified=${report.summary.verified} partial=${report.summary.partial} blocked=${report.summary.blocked} failed=${report.summary.failed} → ${report.status}`,
);
for (const check of checks) {
  console.log(`[config-verify] ${check.status.padEnd(8)} ${check.id}：${check.detail}`);
}
console.log(`[config-verify] 报告：artifacts/config-gate/summary-report.json`);
process.exit(failed.length > 0 ? 1 : 0);