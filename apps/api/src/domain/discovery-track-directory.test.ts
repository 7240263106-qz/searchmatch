import { describe, expect, it } from 'vitest';
import { trackNoticeSchedule, trackScheduleDirectories, trackScheduleRows } from './discovery-track-directory';

const url = 'https://contest.example.org/notice/123.html';
const year = 2026;

describe('official track schedules', () => {
  it('follows both same-origin notice directories', () => {
    const home = 'https://contest.example.org/';
    expect(trackScheduleDirectories(`
      <a href="/national">国赛通知</a><a href="https://other.example.org/topics">赛题通知</a>
      <a href="/topics">赛题通知</a><a href="/regions">赛区通知</a>`, home)).toEqual([home + 'national', home + 'topics']);
  });

  it('limits shared dates to the enumerated topics and omits provisional and out-of-range dates', () => {
    const track = { title: '算法主题赛', url, subjects: ['AI＋心理健康', '智能驾驶', '室内农业'] };
    const source = { title: '算法主题赛全国半决赛的通知', url };
    const rows = trackNoticeSchedule(`<article>
      <p>举办算法主题赛（AI+心理健康、智能驾驶）赛题全国半决赛。其余赛题另行通知。</p>
      <h3>一、赛程安排</h3><p>（一）全国半决赛</p>
      <p>材料提交截止时间：2026年11月19日23:59</p><p>比赛时间：2026年11月20-22日</p>
      <p>（二）全国总决赛</p><p>比赛时间拟定为12月4-6日。</p>
      <p>比赛时间：11月31日</p><p>比赛时间：2025年12月5日</p>
      <h3>二、半决赛比赛安排</h3><p>提交截止日期为11月19日23:59。</p>
      </article>`, track, year, source);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map(item => item.subject))).toEqual(new Set(['AI＋心理健康', '智能驾驶']));
    expect(rows).toContainEqual({ subject: '智能驾驶', label: '全国半决赛 · 比赛时间', time: '2026年11月20日 至 2026年11月22日', source });
  });

  it('uses each row’s evaluation date from an HTML table and retains the shared submission deadline', () => {
    const track = { title: '算法应用赛', url, subjects: ['【赛区制】赛项甲', '【赛区制】赛项乙', '赛项丙'] };
    const source = { url, title: '算法应用赛总决赛预选赛的通知' };
    const rows = trackNoticeSchedule(`<article>
      <p>赛项甲、赛项乙设置总决赛预选赛。</p><h3>一、赛程安排</h3>
      <p>参赛材料提交截止日期：11月19日23:30</p>
      <table><tr><td>赛项</td><td>评审时间</td></tr>
      <tr><td>赛项甲</td><td>11月21-22日</td></tr><tr><td>赛项乙</td><td>11月24日至25日</td></tr></table>
      </article>`, track, year, source);
    expect(rows).toHaveLength(4);
    expect(rows).toContainEqual({ subject: '【赛区制】赛项乙', label: '总决赛预选赛 · 评审时间', time: '2026年11月24日 至 2026年11月25日', source });
    expect(rows.filter(item => item.time === '2026年11月19日23:30')).toHaveLength(2);
  });

  it('includes published shared dates when the organizer expressly includes all eligible teams', () => {
    const track = { title: '算法创新赛', url, subjects: ['软件创新', '硬件创新'] };
    const source = { url, title: '算法创新赛总决赛预选赛的通知' };
    const html = '<article><h3>一、参赛对象</h3><p>所有获得晋级总决赛资格的算法创新赛参赛团队。</p>' +
      '<h3>二、总决赛预选赛赛程安排</h3><p>提交截止日期为11月18日23:30。</p></article>';
    expect(trackNoticeSchedule(html, track, year, source)).toHaveLength(2);
    expect(trackNoticeSchedule(html.replace('所有', '部分'), track, year, source)).toEqual([]);
  });

  it('matches a redundant topic suffix and ignores malformed table cells', () => {
    const source = { url, title: '复赛赛程附件' };
    const tables = [[['赛题名称', '报名截止时间', '复赛比赛时间'],
      ['赛题1：项目甲赛项', '9月20日18:00', '12月30日至1月2日'], ['项目乙', '9月31日', '11月8日25:00']]];
    expect(trackScheduleRows(tables, ['项目甲', '项目乙'], year, source)).toEqual([
      { subject: '项目甲', label: '报名截止时间', time: '2026年9月20日18:00', source },
      { subject: '项目甲', label: '复赛比赛时间', time: '2026年12月30日 至 2027年1月2日', source },
    ]);
  });

  it('uses the verified roster of a named subgroup and distinguishes code and document deadlines', () => {
    const track = { title: '产业命题赛', url, subjects: ['“主题甲”赛题甲', '“主题甲”赛题乙', '其他赛题'] };
    const source = { url, title: '关于举办产业命题赛（主题甲）复赛的通知' };
    const rows = trackNoticeSchedule(`<article>
      <p>主题甲赛题报名将于9月20日19:00截止。</p><h3>一、赛程安排</h3>
      <p>复赛结果文档提交截止时间：10月5日20:00</p><p>复赛代码截止提交时间：10月7日23:59</p>
      <table><tr><td>赛题名称</td><td>复赛基准线</td></tr><tr><td>赛题甲</td><td>60</td></tr>
      <tr><td>赛题乙</td><td>80</td></tr></table></article>`, track, year, source);
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map(item => item.label))).toEqual(new Set(['报名截止', '复赛 · 文档提交截止', '复赛 · 代码提交截止']));
    expect(rows.every(item => item.subject.startsWith('“主题甲”'))).toBe(true);
  });
});
