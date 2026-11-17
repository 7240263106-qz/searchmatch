#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUTPUT = join(ROOT, 'artifacts', 'config-gate', 'concurrency-report.json');
const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const ADMIN_HEADERS = {
  'content-type': 'application/json',
  'x-actor-id': 'u-concurrency',
  'x-actor-roles': 'admin',
};

async function request(path, init) {
  try {
    const response = await fetch(`${API_BASE}${path}`, init);
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const overview = await request('/system-settings', { headers: ADMIN_HEADERS });
  if (overview.status !== 200) {
    const blocked = {
      status: 'blocked',
      startedAt,
      apiBase: API_BASE,
      reason: `API 不可达或未鉴权：status=${overview.status}`,
      scenarios: [],
      evidencePath: 'artifacts/config-gate/concurrency-report.json',
      note: '受限环境无法真实联网时标注为阻塞待补验，不记为通过。',
    };
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, `${JSON.stringify(blocked, null, 2)}\n`, 'utf8');
    console.log(`[config-concurrency] 阻塞待补验：${blocked.reason}`);
    process.exit(2);
  }

  const baseVersion = overview.body?.data?.version ?? 0;
  const scenarios = [];

  const tests = await Promise.all(
    Array.from({ length: 10 }, () =>
      request('/system-settings/tests', {
        method: 'POST',
        headers: ADMIN_HEADERS,
        body: JSON.stringify({ target: 'python_parser', address: 'http://127.0.0.1:8000' }),
      }),
    ),
  );
  const testStatuses = tests.map((entry) => entry.status);
  const externalCount = tests.filter(
    (entry) => entry.status === 200 && entry.body?.data?.evidence?.realOutbound === true,
  ).length;
  scenarios.push({
    name: 'concurrent_test_same_target',
    total: 10,
    ok: testStatuses.filter((status) => status === 200).length,
    throttled: testStatuses.filter((status) => status === 429).length,
    externalCount,
    statuses: testStatuses,
    passed:
      testStatuses.filter((status) => status === 200).length === 1 &&
      testStatuses.filter((status) => status === 429).length === 9 &&
      externalCount === 1,
  });

  const saves = await Promise.all(
    Array.from({ length: 2 }, (_, index) =>
      request('/system-settings/groups/crawl_runtime', {
        method: 'PUT',
        headers: { ...ADMIN_HEADERS, 'If-Match': `"${baseVersion}"` },
        body: JSON.stringify({
          baseVersion,
          changes: [{ key: 'crawl.maxDetailPerRun', value: 12 + index }],
          reason: '并发保存验证',
        }),
      }),
    ),
  );
  const saveStatuses = saves.map((entry) => entry.status);
  const saveOk = saveStatuses.filter((status) => status === 200).length;
  const conflicts = saveStatuses.filter((status) => status === 409).length;
  scenarios.push({
    name: 'concurrent_two_admins_save',
    total: 2,
    ok: saveOk,
    conflicts,
    statuses: saveStatuses,
    conflictCodes: saves.map((entry) => entry.body?.error?.code ?? null),
    passed: saveOk === 1 && conflicts === 1,
  });

  const versionAfterSave = saves.find((entry) => entry.status === 200)?.body?.data?.version ?? baseVersion;

  const rollbacks = await Promise.all(
    Array.from({ length: 2 }, () =>
      request('/system-settings/rollback', {
        method: 'POST',
        headers: ADMIN_HEADERS,
        body: JSON.stringify({
          targetVersion: baseVersion,
          baseVersion: versionAfterSave,
          confirmed: true,
        }),
      }),
    ),
  );
  const rollbackStatuses = rollbacks.map((entry) => entry.status);
  const rollbackOk = rollbackStatuses.filter((status) => status === 200).length;
  const rollbackConflicts = rollbackStatuses.filter((status) => status === 409).length;
  scenarios.push({
    name: 'concurrent_save_and_rollback',
    total: 2,
    ok: rollbackOk,
    conflicts: rollbackConflicts,
    statuses: rollbackStatuses,
    passed: rollbackOk === 1 && rollbackConflicts === 1,
  });

  const credentialWrites = await Promise.all(
    Array.from({ length: 2 }, () =>
      request('/system-settings/credentials/new', {
        method: 'PUT',
        headers: ADMIN_HEADERS,
        body: JSON.stringify({ plaintext: `sk-concurrency-${Math.random().toString(36).slice(2, 10)}`, purpose: 'concurrency' }),
      }),
    ),
  );
  const refIds = credentialWrites
    .filter((entry) => entry.status === 200)
    .map((entry) => entry.body?.data?.secretRefId)
    .filter(Boolean);
  const plaintextLeaked = JSON.stringify(credentialWrites).includes('sk-concurrency-');
  const revokeResults = await Promise.all(
    refIds.map((refId) =>
      request(`/system-settings/credentials/${encodeURIComponent(refId)}`, {
        method: 'DELETE',
        headers: ADMIN_HEADERS,
      }),
    ),
  );
  scenarios.push({
    name: 'concurrent_credential_rotation',
    total: 2,
    ok: refIds.length,
    uniqueRefs: new Set(refIds).size,
    plaintextLeaked,
    revokeStatuses: revokeResults.map((entry) => entry.status),
    statuses: credentialWrites.map((entry) => entry.status),
    passed:
      refIds.length === 2 &&
      new Set(refIds).size === 2 &&
      !plaintextLeaked &&
      revokeResults.every((entry) => entry.status === 200),
  });

  const readiness = await Promise.all(
    Array.from({ length: 10 }, () =>
      request('/system-settings/readiness/recompute', {
        method: 'POST',
        headers: ADMIN_HEADERS,
      }),
    ),
  );
  const readinessTimes = readiness
    .filter((entry) => entry.status === 200)
    .map((entry) => entry.body?.data?.computedAt)
    .filter(Boolean);
  scenarios.push({
    name: 'concurrent_readiness_recompute',
    total: 10,
    ok: readiness.filter((entry) => entry.status === 200).length,
    distinctComputedAt: new Set(readinessTimes).size,
    statuses: readiness.map((entry) => entry.status),
    passed:
      readiness.every((entry) => entry.status === 200) &&
      new Set(readinessTimes).size <= 2,
  });

  scenarios.push({
    name: 'config_change_during_crawl',
    total: 0,
    status: 'blocked',
    reason: '需要运行中的采集任务与任务编排入口；本轮未构造真实进行中任务，标 blocked。',
    passed: null,
  });

  const versions = [baseVersion, versionAfterSave, ...rollbacks.map((entry) => entry.body?.data?.version).filter(Boolean)];
  const monotonic = versions.every((value, index) => index === 0 || value > versions[index - 1]);

  const report = {
    status: scenarios.every((entry) => entry.passed === true) ? 'verified' : 'partial',
    startedAt,
    finishedAt: new Date().toISOString(),
    apiBase: API_BASE,
    baseVersion,
    scenarios,
    assertions: {
      versionMonotonic: monotonic,
      versions,
      noPartialApply: scenarios
        .filter((entry) => entry.statuses)
        .every((entry) => entry.statuses.every((status) => status === 200 || status === 409 || status === 429)),
      noDuplicateVersions: new Set(versions).size === versions.length,
    },
    evidencePath: 'artifacts/config-gate/concurrency-report.json',
    note:
      '冷却为进程内单实例口径；采集运行中修改与多实例共享冷却标 blocked。真实联网五类目标见 network-report.json。',
  };
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const passedScenarios = scenarios.filter((entry) => entry.passed === true).length;
  console.log(`[config-concurrency] 场景 ${passedScenarios}/${scenarios.length} 通过；版本 ${versions.join(' → ')}`);
  console.log(`[config-concurrency] 报告：${report.evidencePath}`);
  process.exit(report.status === 'verified' ? 0 : 1);
}

void main();