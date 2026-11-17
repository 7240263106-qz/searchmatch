#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUTPUT = join(ROOT, 'artifacts', 'config-gate', 'same-source-runtime.json');
const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';

async function get(path, roles) {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: {
        Accept: 'application/json',
        'x-actor-id': 'u-same-source',
        'x-actor-roles': roles,
      },
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const bootstrap = await get('/system/client-bootstrap', 'viewer');
  const overview = await get('/system-settings', 'admin');
  const health = await get('/system/configuration-health', 'admin');

  if (bootstrap.status !== 200 || overview.status !== 200 || health.status !== 200) {
    const blocked = {
      status: 'blocked',
      checkedAt: new Date().toISOString(),
      apiBase: API_BASE,
      reason: `API 不可达或鉴权失败：bootstrap=${bootstrap.status}, overview=${overview.status}, health=${health.status}`,
      versions: { page: 0, health: 0, log: 0 },
      fingerprint: '',
      passed: false,
      evidencePath: 'artifacts/config-gate/same-source-runtime.json',
    };
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, `${JSON.stringify(blocked, null, 2)}\n`, 'utf8');
    console.log(`[same-source] 阻塞待补验：${blocked.reason}`);
    process.exit(2);
  }

  const pageVersion = overview.body.data.version;
  const healthVersion = health.body.data.runtimeProvenance?.configVersion ?? 0;
  const logVersion = bootstrap.body.data.configVersion;
  const pageFingerprint = overview.body.data.snapshotFingerprint ?? '';
  const healthFingerprint = health.body.data.runtimeProvenance?.snapshotFingerprint ?? '';
  const logFingerprint = bootstrap.body.data.snapshotFingerprint ?? '';
  const versionsEqual =
    pageVersion === healthVersion && healthVersion === logVersion && pageVersion > 0;
  const fingerprintEqual =
    Boolean(pageFingerprint) &&
    pageFingerprint.slice(0, 12) === healthFingerprint.slice(0, 12) &&
    healthFingerprint.slice(0, 12) === logFingerprint.slice(0, 12);
  const passed = versionsEqual && fingerprintEqual;

  const report = {
    status: passed ? 'verified' : 'failed',
    checkedAt: new Date().toISOString(),
    apiBase: API_BASE,
    versions: { page: pageVersion, health: healthVersion, log: logVersion },
    fingerprint: pageFingerprint,
    fingerprints: { page: pageFingerprint, health: healthFingerprint, log: logFingerprint },
    passed,
    assertion: {
      versionsEqual,
      fingerprintEqual,
      source: 'client-bootstrap / system-settings / configuration-health 同源比对',
    },
    evidencePath: 'artifacts/config-gate/same-source-runtime.json',
  };
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    `[same-source] 页面 v${pageVersion} / 健康 v${healthVersion} / 下发 v${logVersion}；指纹 ${passed ? '一致' : '不一致'}`,
  );
  console.log(`[same-source] 报告：${report.evidencePath}`);
  process.exit(passed ? 0 : 1);
}

void main();