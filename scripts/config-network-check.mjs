#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUTPUT = join(ROOT, 'artifacts', 'config-gate', 'network-report.json');
const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';

const TARGETS = [
  { target: 'database', address: undefined, requirement: 'PostgreSQL/SQLite 受控驱动查询' },
  { target: 'object_storage', address: undefined, requirement: '远端对象存储需 38.4 适配器；本地存储为替代验证' },
  { target: 'python_parser', address: 'http://127.0.0.1:8000', requirement: '解析服务真实外发' },
  { target: 'model_service', address: undefined, requirement: '模型服务需已配置地址与凭据' },
  { target: 'public_base_url', address: 'http://127.0.0.1:3000', requirement: '对外访问基地址真实外发' },
];

async function request(path, init) {
  try {
    const response = await fetch(`${API_BASE}${path}`, init);
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const overview = await request('/system-settings', {
    headers: { 'x-actor-id': 'u-network', 'x-actor-roles': 'admin' },
  });
  if (overview.status !== 200) {
    const blocked = {
      status: 'blocked',
      startedAt,
      apiBase: API_BASE,
      reason: `API 不可达或未鉴权：status=${overview.status}`,
      results: [],
      evidencePath: 'artifacts/config-gate/network-report.json',
      note: '受限环境无法真实联网时标注阻塞待补验，不记为通过。',
    };
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, `${JSON.stringify(blocked, null, 2)}\n`, 'utf8');
    console.log(`[config-network] 阻塞待补验：${blocked.reason}`);
    process.exit(2);
  }

  const results = [];
  for (const item of TARGETS) {
    const response = await request('/system-settings/tests', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'u-network',
        'x-actor-roles': 'admin',
      },
      body: JSON.stringify({
        target: item.target,
        address: item.address,
        realNetworkRequired: true,
      }),
    });
    if (response.status !== 200) {
      results.push({
        target: item.target,
        requirement: item.requirement,
        status: 'blocked',
        httpStatus: response.status,
        result: response.body?.error?.code ?? response.error ?? 'unknown',
        testedAt: new Date().toISOString(),
        evidencePath: 'artifacts/config-gate/network-report.json',
      });
      continue;
    }
    const data = response.body.data;
    const substituted =
      data.evidence?.realOutbound === false ||
      (item.target === 'object_storage' && data.maskedAddress === '本地文件存储');
    results.push({
      target: item.target,
      requirement: item.requirement,
      status: substituted ? 'partial' : 'verified',
      maskedAddress: data.maskedAddress,
      result: data.result,
      suggestion: data.suggestion,
      durationMs: data.durationMs,
      testedAt: data.testedAt,
      validUntil: data.validUntil,
      realOutbound: data.evidence?.realOutbound ?? null,
      egressRoute: data.evidence?.egressRoute ?? null,
      evidencePath: 'artifacts/config-gate/network-report.json',
    });
  }

  const report = {
    status: results.some((entry) => entry.status === 'verified') ? 'partial' : 'blocked',
    startedAt,
    finishedAt: new Date().toISOString(),
    apiBase: API_BASE,
    results,
    summary: {
      verified: results.filter((entry) => entry.status === 'verified').length,
      partial: results.filter((entry) => entry.status === 'partial').length,
      blocked: results.filter((entry) => entry.status === 'blocked').length,
      realOutboundCount: results.filter((entry) => entry.realOutbound === true).length,
    },
    note:
      '数据库在 SQLite 本地为受控驱动查询；对象存储本地为替代验证；模型服务未配置时按 blocked/失败分类记录，不伪造成功。',
    evidencePath: 'artifacts/config-gate/network-report.json',
  };
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    `[config-network] verified=${report.summary.verified} partial=${report.summary.partial} blocked=${report.summary.blocked} outbound=${report.summary.realOutboundCount}`,
  );
  console.log(`[config-network] 报告：${report.evidencePath}`);
  process.exit(report.status === 'blocked' ? 2 : 0);
}

void main();