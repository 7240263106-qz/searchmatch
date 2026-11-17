import { describe, expect, it } from 'vitest';
import { availabilityFromStat } from './artifact.service';

const createdAt = new Date('2026-11-01T00:00:00Z');
const changedAt = new Date('2026-11-08T00:00:00Z');

describe('历史原件可用性派生', () => {
  it('对象存在且早于存储切换时标可用并说明旧目标回退', () => {
    const result = availabilityFromStat({ exists: true, size: 128 }, createdAt, changedAt);
    expect(result.availability).toBe('available');
    expect(result.reason).toContain('旧存储目标仍可只读回退');
  });

  it('对象存在且晚于切换时间时标可用且无告警原因', () => {
    const result = availabilityFromStat(
      { exists: true, size: 128 },
      new Date('2026-11-09T00:00:00Z'),
      changedAt,
    );
    expect(result.availability).toBe('available');
    expect(result.reason).toBeNull();
  });

  it('对象不存在且发生存储切换时标不可访问并给出固定原因', () => {
    const result = availabilityFromStat({ exists: false, size: 0 }, createdAt, changedAt);
    expect(result.availability).toBe('inaccessible');
    expect(result.reason).toBe('存储目标已变更');
  });

  it('无存储切换记录时对象缺失标原件不可读，不虚标已迁移', () => {
    const result = availabilityFromStat({ exists: false, size: 0 }, createdAt, null);
    expect(result.availability).toBe('inaccessible');
    expect(result.reason).toBe('原件不可读');
    expect(result.availability).not.toBe('migrated');
  });
});