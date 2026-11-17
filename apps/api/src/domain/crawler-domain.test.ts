import { describe, expect, it } from 'vitest';
import {
  detectTracks,
  inferSeriesName,
  inferEdition,
  fourElementKey,
} from '../services/track-split.service';
import { extractLinks, findAttachmentLinks, htmlToText } from './html';

describe('赛道与组别识别', () => {
  it('识别蓝桥杯软件类与电子类赛道', () => {
    const text = '第十八届蓝桥杯大赛软件赛与电子赛报名通知，软件类包含 Java 软件开发。';
    const tracks = detectTracks(text);
    expect(tracks.some((item) => item.name === '软件类' && item.kind === 'track')).toBe(true);
    expect(tracks.some((item) => item.name === '电子类' && item.kind === 'track')).toBe(true);
  });

  it('组别与赛道区分', () => {
    const text = '本届竞赛设研究生组、本科组、高职高专组。';
    const tracks = detectTracks(text);
    expect(tracks.every((item) => item.kind === 'group')).toBe(true);
    expect(tracks.some((item) => item.name === '研究生组')).toBe(true);
  });

  it('系列与届次推断', () => {
    expect(inferSeriesName('第十八届蓝桥杯大赛报名指南', '')).toContain('蓝桥杯');
    const edition = inferEdition('关于举办第十八届蓝桥杯大赛的通知');
    expect(edition.ordinal).toBe(18);
    expect(edition.year).toBeGreaterThan(2000);
  });

  it('四要素去重键不同赛道不同键', () => {
    const a = fourElementKey('s1', 'e1', 't1');
    const b = fourElementKey('s1', 'e1', 't2');
    const c = fourElementKey('s1', 'e1', 't1');
    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });
});

describe('HTML 解析', () => {
  const html = `
    <html><head><title>蓝桥杯公告</title><script>var x=1;</script></head>
    <body>
      <a href="/notices/3531">第十八届蓝桥杯大赛报名指南</a>
      <a href="https://x-static.lanqiao.cn/upload/a.pdf">竞赛规程附件.pdf</a>
      <p>报名时间：2026年11月10日至2026年12月15日</p>
    </body></html>`;

  it('提取真实公告链接并忽略脚本', () => {
    const links = extractLinks(html, 'https://dasai.lanqiao.cn/');
    expect(links.length).toBe(2);
    expect(links[0]?.url).toContain('/notices/3531');
  });

  it('正文去除标签并保留文本', () => {
    const text = htmlToText(html);
    expect(text).toContain('报名时间');
    expect(text).not.toContain('var x=1');
  });

  it('发现附件链接', () => {
    const attachments = findAttachmentLinks(html, 'https://dasai.lanqiao.cn/');
    expect(attachments.length).toBe(1);
    expect(attachments[0]?.url).toContain('.pdf');
  });
});