import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLogService } from './agent-log.service';
import { AppException } from './app-exception';

describe('本地智能体运行日志', () => {
  let directory: string;

  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'competition-agent-log-')); });
  afterEach(async () => {
    vi.useRealTimers();
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  });

  it('北京时间跨日滚动，按任务保留有序事件并去掉凭据和 URL 查询参数', async () => {
    const first = new AgentLogService(directory);
    first.record('run-id', { at: '2026-06-18T15:59:59.000Z', stage: 'task', level: 'info', message: '开始采集。' });
    first.record('run-id', { at: '2026-06-18T16:00:00.000Z', stage: 'page', level: 'warning',
      message: 'robots.txt 返回 HTTP 500。 Authorization: Bearer example-credential',
      url: 'https://user:example-password@example.org/robots.txt?token=secret#/news?token=secret',
      reason: 'robots_unknown', durationMs: 42,
      operation: { id: '1', label: '网页 https://example.org/?api_key=other-secret', phase: 'end' } });
    await first.onApplicationShutdown();

    const next = new AgentLogService(directory);
    next.record('another-run', { at: '2026-06-18T16:05:00.000Z', stage: 'task', level: 'info', message: '服务重启后开始新任务。' });
    await next.onApplicationShutdown();
    expect(await readdir(directory)).toEqual(['agent-2026-06-18.jsonl', 'agent-2026-06-19.jsonl']);
    const raw = await readFile(join(directory, 'agent-2026-06-19.jsonl'), 'utf8');
    expect(raw).not.toMatch(/example-credential|example-password|token=|other-secret/);
    const entries = raw.trim().split('\n').map(line => JSON.parse(line));
    expect(entries.map(entry => entry.runId)).toEqual(['run-id', 'another-run']);
    expect(entries[0]).toMatchObject({ url: 'https://example.org/robots.txt#/news', reason: 'robots_unknown', durationMs: 42,
      message: expect.stringContaining('HTTP 500') });
  });

  it('启动和定时清理只移除七个北京时间日期以外的本服务日志', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-06-19T15:30:00Z'));
    const log = new AgentLogService(directory);
    await Promise.all(['agent-2026-06-12.jsonl', 'agent-2026-06-13.jsonl', 'agent-2026-06-19.jsonl', 'other.log']
      .map(file => writeFile(join(directory, file), '', 'utf8')));
    log.onModuleInit();
    try {
      await vi.waitFor(async () => expect(await readdir(directory)).toEqual([
        'agent-2026-06-13.jsonl', 'agent-2026-06-19.jsonl', 'other.log',
      ]));
      vi.advanceTimersByTime(60 * 60 * 1000);
    } finally {
      await log.onApplicationShutdown();
    }
    expect(await readdir(directory)).toEqual(['agent-2026-06-19.jsonl', 'other.log']);
  });

  it('记录成功、失败和耗时，保留原返回值及异常', async () => {
    const log = new AgentLogService(directory);
    await expect(log.track('智能体对话', async () => '聊天正文')).resolves.toBe('聊天正文');
    const failure = new AppException('RESOURCE_NOT_FOUND');
    await expect(log.track('智能体操作确认', async () => { throw failure; })).rejects.toBe(failure);
    await log.onApplicationShutdown();
    const [file] = await readdir(directory);
    const raw = await readFile(join(directory, file), 'utf8');
    expect(raw).not.toContain('聊天正文');
    const entries = raw.trim().split('\n').map(line => JSON.parse(line));
    expect(entries.map(entry => entry.level)).toEqual(['info', 'success', 'info', 'error']);
    expect(entries[3]).toMatchObject({ reason: 'RESOURCE_NOT_FOUND', durationMs: expect.any(Number) });
  });
});
