import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogGradeCounts, extractDocumentCatalog } from './document-catalog';

describe('学校竞赛认定目录', () => {
  const text = readFileSync(join(__dirname, 'fixtures/recognition-catalog.txt'), 'utf8');
  it('完整读取真实三页目录的 71 行，分别保留学校 A/B/C 认定等级', () => {
    const result = extractDocumentCatalog(text, [], '目录.pdf')!;
    expect(result.detectedRows).toBe(71);
    expect(result.competitions.map(row => row.sequence)).toEqual(Array.from({ length: 71 }, (_, index) => index + 1));
    expect(catalogGradeCounts(result)).toEqual({ 'A类': 5, 'B类': 14, 'C类': 52 });
    expect(result.recognitionScope).toBe('江苏师范大学科文学院');
    expect(result.warnings).toEqual([]);
    expect(result.competitions[0].name).toBe('中国国际大学生创新大赛');
    expect(result.competitions[70].name).toBe('中国校园戏剧节比赛');
  });
  it('合并跨行名称，保留同序号的所有子赛，不把续页表头当成名称', () => {
    const rows = extractDocumentCatalog(text, [], '目录.pdf')!.competitions;
    expect(rows[15].name).toBe('外研社全国大学生英语系列赛-①英语演讲、②英语辩论、③英语写作、④英语阅读');
    expect(rows[24].name).toBe('中国高校计算机大赛-①大数据挑战赛、②团体程序设计天梯赛、③移动应用创新赛④网络技术挑战赛、⑤人工智能创意赛');
    expect(rows[43].name).toBe('全国高校商业精英挑战赛-①品牌策划竞赛、②会展专业创新创业实践竞赛③国际贸易竞赛、④创新创业竞赛、⑤会计与商业管理案例竞赛');
    expect(rows[32].name).toBe('全国周培源大学生力学竞赛');
  });
  it('保留原文页码与序号，缺失等级或序号时显式提示', () => {
    const result = extractDocumentCatalog('测试学院竞赛认定目录\n1\n第一竞赛\nA类\n3\n第二竞赛', [{ text: '第一竞赛', location: { kind: 'pdf', page: 2 } }], '目录.pdf')!;
    expect(result.competitions[0].evidence.location).toMatchObject({ page: 2, sequence: 1 });
    expect(result.competitions[1].schoolRecognitionLevel).toBeNull();
    expect(result.warnings).toHaveLength(2);
  });
  it('普通单场公告保持原流程', () => {
    expect(extractDocumentCatalog('数学建模竞赛通知\n报名截止：2026年12月1日', [], '公告.txt')).toBeNull();
  });
});
