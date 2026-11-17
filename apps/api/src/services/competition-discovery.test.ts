import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../platform/prisma.module';
import type { RateLimiterService } from '../platform/rate-limiter.service';
import type { RawFetchResult, SafeEgressService } from '../platform/safe-fetch';
import type { LlmService } from './llm.service';
import type { ExtractionService } from './extraction.service';
import type { ParserClient } from './parser-client.service';
import { currentDiscoveryYear } from '../domain/competition-discovery';
import { LANQIAO_NOTICE_LIST, lanqiaoDetailFeed, lanqiaoNoticeFeed } from '../domain/lanqiao-notices';
import { CompetitionDiscoveryService } from './competition-discovery.service';

describe('竞赛采集运行日志', () => {
  it('用当年总通知核对官网赛道，翻页整理赛题供保存', async () => {
    const year = currentDiscoveryYear();
    const name = '校园算法精英大赛';
    const home = 'https://contest.example.org/';
    const notice = home + 'news/annual.html';
    const notices = home + 'news';
    const scheduleNotice = home + 'news/schedule.html';
    const schedulePdf = home + 'files/schedule.pdf';
    const groups = ['算法挑战赛', '算法创新赛', '校园邀请赛'];
    const paths = groups.map((_, index) => home + 'categories/' + index);
    const reply = (url: string, body: string) =>
      ({ ok: true, status: 200, finalUrl: url, buffer: Buffer.from(body), contentType: 'text/html' }) as RawFetchResult;
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith('https://search.brave.com/')) {
        return reply(url, `<a href="${home}"><div class="search-snippet-title">${name}官网</div></a>`);
      }
      if (url.startsWith('https://www.sogou.com/')) return reply(url, '');
      if (url === home) return reply(url, `<title>${name}</title><a href="${paths[0]}">赛题规则</a><a href="${notices}">国赛通知</a>
        ${groups.map((group, index) => `<a href="${paths[index]}"><h3>${group}</h3><p>查看赛题</p></a>`).join('')}
        <a href="${notice}">关于举办${year}年第八届${name}的通知</a>`);
      if (url === notice) return reply(url, `<article><h1>关于举办${year}年第八届${name}的通知</h1>
        <p>参赛对象：在校学生。</p><h4>五、赛道设置</h4><p>本届设算法挑战赛、算法创新赛。</p></article>`);
      if (url === notices) return reply(url, `<a href="${scheduleNotice}">${year}年算法挑战赛复赛日程通知</a>`);
      if (url === scheduleNotice) return reply(url, `<article><h1>第八届${name}算法挑战赛复赛日程</h1>
        <a href="${schedulePdf}">附件：算法挑战赛复赛日程表</a></article>`);
      if (url === schedulePdf) return { ...reply(url, '%PDF-1.7'), contentType: 'application/pdf' };
      const entry = (parent: string, title: string, group: string, slug: string) =>
        `<a href="${parent}/${slug}.html"><h5>${title}</h5><p><label>${group}</label></p></a>`;
      if (url === paths[0]) return reply(url, entry(url, `${year}AIC·视觉理解`, groups[0], 'vision') +
        entry(url, `${year - 1}AIC·旧届赛题`, groups[0], 'old') +
        entry(url, '赛题一览', groups[0], 'index') + '<a href="' + url + '/page/2">下一页</a>');
      if (url === paths[0] + '/page/2') return reply(url, entry(home + 'categories', '图像识别', groups[0], 'image'));
      if (url === paths[1]) return reply(url, entry(url, '模型创新', groups[1], 'model'));
      throw new Error('unexpected_url');
    });
    const prisma = {
      sourceDefinition: { findMany: vi.fn().mockResolvedValue([]) },
      competition: { findFirst: vi.fn().mockResolvedValue({ name, versionNo: 4 }) },
    } as unknown as PrismaService;
    const parse = vi.fn().mockResolvedValue({ ok: true, text: '', tables: [[
      ['赛题名称', '初赛报名\n截止时间', '复赛作品\n提交截止时间'],
      ['视觉理解', '9 月 20 日\n18:00', '10月7日23:59'],
      ['图像识别', '9月20日18:00', '10月11日23:59'],
      ['无关赛题', '9月20日18:00', '10月11日23:59'],
    ]] });
    const service = new CompetitionDiscoveryService(prisma, { fetch } as unknown as SafeEgressService, null!,
      { waitForDomain: vi.fn() } as unknown as RateLimiterService,
      { extract: vi.fn().mockResolvedValue({ fields: [] }) } as unknown as ExtractionService,
      { configured: false } as LlmService, { parse } as unknown as ParserClient);
    const result = await service.discoverForCompetition('fixture', 'owner');
    const selected = service.selectedFields('fixture', 'owner', { runId: result.runId!, pageUrl: home, keys: ['discoveryTracks'] });
    expect(selected.page.tracks).toMatchObject([
      { title: groups[0], edition: '第八届', subjects: ['视觉理解', '图像识别'], guide: { url: paths[0] } },
      { title: groups[1], edition: '第八届', subjects: ['模型创新'] },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain(paths[2]);
    expect(parse).toHaveBeenCalledWith('competition-notice.pdf', 'pdf', Buffer.from('%PDF-1.7'), true);
    expect(selected.page.tracks?.[0].schedule).toHaveLength(4);
    expect(selected.page.tracks?.[0].schedule).toMatchObject([
      { subject: '视觉理解', time: `${year}年9月20日18:00`, label: '初赛报名截止时间', source: { url: schedulePdf } },
      { subject: '视觉理解', time: `${year}年10月7日23:59` },
      { subject: '图像识别', time: `${year}年9月20日18:00` },
      { subject: '图像识别', time: `${year}年10月11日23:59` },
    ]);
  });

  it.each([false, true])('从搜索结果定位百度之星官网（第一官网候选无法打开：%s）', async (blocked) => {
    const year = currentDiscoveryYear();
    const home = 'https://contest.example.org/';
    const alternate = 'https://organizer.example.net/';
    const official = `${home}#/events/${year}?tab=1`;
    const notice = `${blocked ? alternate : home}news/registration`;
    const school = 'https://www.cuit.edu.cn/notice';
    const mirror = 'https://www.example.com/notice';
    const title = `${year}年第22届百度之星程序设计大赛报名通知`;
    const reply = (url: string, body: string) =>
      ({ ok: true, status: 200, finalUrl: url, buffer: Buffer.from(body), contentType: 'text/html' }) as RawFetchResult;
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith('https://search.brave.com/')) {
        return reply(url, `<a href="${school}"><div class="search-snippet-title">${title}（校内选拔）</div></a>
          <a href="${mirror}"><div class="search-snippet-title">${title}</div></a>
          <a href="${home}"><div class="search-snippet-title">百度之星程序设计大赛官网</div></a>
          <a href="${alternate}"><div class="search-snippet-title">百度之星程序设计大赛官网</div></a>`);
      }
      if (url.startsWith('https://www.sogou.com/')) return reply(url, '');
      if (url === alternate) return reply(url, `<title>百度之星程序设计大赛</title><a href="${notice}">${title}</a>`);
      if (url === home) {
        if (blocked) throw new Error('robots_unknown');
        if (fetch.mock.calls.filter(([address]) => address === home).length === 1) {
          return reply(url, `<title>百度之星程序设计大赛</title><nav><a href="#/events/${year}?tab=1">${year}年赛事介绍</a></nav>`);
        }
        return reply(url, `<title>百度之星程序设计大赛</title><article><h1>${year}年百度之星程序设计大赛</h1>
          <p>报名时间：${year}年7月1日。</p><p>比赛内容：算法设计。</p><a href="https://registration.example.org/">立即报名</a>
          <a href="${notice}">${title}</a></article>`);
      }
      if (url === notice) return reply(url, `<article><h1>${title}</h1><p>报名截止时间：${year}年8月3日。</p></article>`);
      throw new Error('unexpected_url');
    });
    const prisma = { sourceDefinition: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    const rates = { waitForDomain: vi.fn().mockResolvedValue(undefined) } as unknown as RateLimiterService;
    const extract = vi.fn().mockResolvedValue({ fields: [] });
    const decisions = vi.fn(async (_task: string, _system: string, input: string) => {
      const { candidates, evidence } = JSON.parse(input);
      if (evidence.some((page: { fields: string[] }) => page.fields.includes('报名截止时间'))) {
        return { success: true, data: { action: 'stop', ids: [] } };
      }
      return { success: true, data: { action: 'visit', ids: [0] } };
    });
    const service = new CompetitionDiscoveryService(prisma, { fetch } as unknown as SafeEgressService, null!,
      rates, { extract } as unknown as ExtractionService, { configured: true, completeJson: decisions } as unknown as LlmService, null!);
    const logs: Array<{ url?: string; message: string }> = [];
    const result = await service.discover('百度之星', 'owner', log => logs.push(log));
    const requests = fetch.mock.calls.map(([url]) => url);
    expect(requests.filter(url => !url.startsWith('https://search.brave.com/') && !url.startsWith('https://www.sogou.com/')))
      .toEqual(blocked ? [home, alternate, notice] : [home, home, notice]);
    expect(result.matching).toBe('model_assisted');
    expect(result.sites.map(site => site.url)).toEqual([blocked ? alternate : home]);
    expect(logs).toContainEqual(expect.objectContaining({ message: expect.stringContaining('已过滤 1 条校赛') }));
    if (blocked) {
      expect(result.issues).toEqual([{ url: home, reason: 'robots_unknown' }]);
      expect(extract).toHaveBeenCalledTimes(1);
    } else {
      expect(result.pages.find(page => page.url === official)?.fields).toContainEqual(expect.objectContaining({
        key: 'signupUrl', value: 'https://registration.example.org/',
      }));
    }
    expect(result.pages.find(page => page.url === notice)?.fields).toContainEqual(expect.objectContaining({
      key: 'nearestDeadline', value: `${year}年8月3日`,
    }));
  });

  it('未从搜索引擎找到候选时不访问预设网址或资料库地址', async () => {
    const fetch = vi.fn(async (url: string) =>
      ({ ok: true, status: 200, finalUrl: url, buffer: Buffer.alloc(0), contentType: 'text/html' }) as RawFetchResult);
    const prisma = { sourceDefinition: { findMany: vi.fn().mockResolvedValue([
      { name: '百度之星', address: 'https://saved.example.org/' },
    ]) } } as unknown as PrismaService;
    const rates = { waitForDomain: vi.fn().mockResolvedValue(undefined) } as unknown as RateLimiterService;
    const service = new CompetitionDiscoveryService(prisma, { fetch } as unknown as SafeEgressService, null!,
      rates, null!, { configured: false } as LlmService, null!);
    const result = await service.discover('百度之星', 'owner');
    expect(fetch.mock.calls.map(([url]) => new URL(url).hostname)).toEqual([
      'search.brave.com', 'www.sogou.com', 'search.brave.com', 'www.sogou.com', 'www.bing.com', 'www.bing.com',
    ]);
    expect(result.sites).toEqual([]);
    expect(result.pages).toEqual([]);
  });

  it('其他搜索源未找到官网时，从必应补查不带网址的赛事简称', async () => {
    const official = 'https://new-host.example.org/';
    const older = `https://contest${currentDiscoveryYear() - 1}.example.org/`;
    const fetch = vi.fn(async (url: string) => {
      const address = new URL(url);
      const body = address.hostname === 'www.bing.com'
        ? `<rss><channel><item><title>百度之星大赛</title><link>${official}</link></item>
            <item><title>百度之星大赛</title><link>${older}</link></item></channel></rss>`
        : url === official ? '<title>百度之星大赛</title>' : '';
      return { ok: true, status: 200, finalUrl: url, buffer: Buffer.from(body), contentType: 'text/html' } as RawFetchResult;
    });
    const prisma = { sourceDefinition: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    const rates = { waitForDomain: vi.fn().mockResolvedValue(undefined) } as unknown as RateLimiterService;
    const service = new CompetitionDiscoveryService(prisma, { fetch } as unknown as SafeEgressService, null!,
      rates, null!, { configured: false } as LlmService, null!);
    const result = await service.discover('百度之星', 'owner');
    expect(result.searches.find(search => search.provider === 'bing')).toMatchObject({ query: '"百度之星"' });
    expect(fetch.mock.calls.at(-1)?.[0]).toBe(official);
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain(older);
    expect(result.sites.map(site => site.url)).toEqual([official]);
  });

  it('搜狗存在通知候选时仍用必应补查官网', async () => {
    const name = '全国大学生结构设计竞赛';
    const home = 'http://contest.example.org/';
    const notice = 'https://school.example.edu.cn/notice';
    const fetch = vi.fn(async (url: string) => {
      const address = new URL(url);
      let body = '';
      if (address.hostname === 'www.sogou.com') {
        body = `<h3><a href="${notice}">${currentDiscoveryYear()}年${name}报名通知</a></h3>`;
      } else if (address.hostname === 'www.bing.com') {
        body = `<rss><channel><item><title>${name}</title><link>${home}</link></item></channel></rss>`;
      } else if (url === home) {
        body = `<title>${name}</title>`;
      }
      return { ok: true, status: 200, finalUrl: url, buffer: Buffer.from(body), contentType: 'text/html' } as RawFetchResult;
    });
    const prisma = { sourceDefinition: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    const rates = { waitForDomain: vi.fn().mockResolvedValue(undefined) } as unknown as RateLimiterService;
    const service = new CompetitionDiscoveryService(prisma, { fetch } as unknown as SafeEgressService, null!,
      rates, null!, { configured: false } as LlmService, null!);
    const result = await service.discover(name, 'owner');
    expect(result.searches.some(search => search.provider === 'bing')).toBe(true);
    expect(result.sites.map(site => site.url)).toEqual([home]);
  });

  it('排除标题或正文标明为校内的公告，保留高校主办方原始通知', async () => {
    const year = currentDiscoveryYear();
    const name = '全国高校算法创意大赛';
    const title = `${year}年${name}报名通知`;
    const school = 'https://news.example.edu.cn/notice';
    const repost = 'https://other.example.edu.cn/notice';
    const organizer = 'https://contest.example.edu.cn/notice';
    const reply = (url: string, body: string) =>
      ({ ok: true, status: 200, finalUrl: url, buffer: Buffer.from(body), contentType: 'text/html' }) as RawFetchResult;
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith('https://search.brave.com/')) {
        return reply(url, `<a href="${school}"><div class="search-snippet-title">${title}（校赛）</div></a>
          <a href="${repost}"><div class="search-snippet-title">${title}</div></a>
          <a href="${organizer}"><div class="search-snippet-title">${title}</div></a>`);
      }
      if (url === repost) return reply(url, `<article><h1>${title}</h1><p>我校决定组织报名参加本次竞赛。</p>
        <p>报名截止时间：${year}年8月1日。</p></article>`);
      if (url === organizer) return reply(url, `<article><h1>${title}</h1><p>主办单位：示例大学。</p>
        <p>参赛对象：全国各高校在读学生。</p><p>报名截止时间：${year}年8月10日。</p></article>`);
      return reply(url, '');
    });
    const prisma = { sourceDefinition: { findMany: vi.fn().mockResolvedValue([{ name, address: organizer }]) } } as unknown as PrismaService;
    const rates = { waitForDomain: vi.fn().mockResolvedValue(undefined) } as unknown as RateLimiterService;
    const extract = vi.fn().mockResolvedValue({ fields: [] });
    const service = new CompetitionDiscoveryService(prisma, { fetch } as unknown as SafeEgressService, null!,
      rates, { extract } as unknown as ExtractionService, { configured: false } as LlmService, null!);
    const result = await service.discover(name, 'owner');
    const requests = fetch.mock.calls.map(([url]) => url);
    expect(requests).not.toContain(school);
    expect(requests.indexOf(repost)).toBeGreaterThan(requests.indexOf(organizer));
    expect(extract).toHaveBeenCalledTimes(1);
    expect(result.issues).toContainEqual({ url: repost, reason: 'campus_notice' });
    expect(result.pages.map(page => page.url)).toEqual([organizer]);
  });

  it('并行访问仍在进行时，返回已核验公告的比赛内容和报名截止时间', async () => {
    const year = currentDiscoveryYear();
    const name = '全国大学生数学建模竞赛';
    const title = `${year}年${name}报名通知`;
    const fast = 'https://fast.example.org/notice';
    const slow = 'https://slow.example.org/notice';
    let finishSlow!: (result: RawFetchResult) => void;
    const pending = new Promise<RawFetchResult>(resolve => { finishSlow = resolve; });
    const reply = (url: string, body: string) =>
      ({ ok: true, status: 200, finalUrl: url, buffer: Buffer.from(body), contentType: 'text/html' }) as RawFetchResult;
    const fetch = vi.fn(async (url: string) => {
      if (url === slow) return pending;
      if (url === fast) {
        return reply(url, `<article><h1>${title}</h1><h2>二、比赛内容</h2>
          <p>参赛队需完成建模分析、程序验证与论文撰写。</p>
          <p>报名截止时间：${year}年8月1日。</p></article>`);
      }
      if (url.startsWith('https://search.brave.com/')) {
        return reply(url, [fast, slow].map(link =>
          `<a href="${link}"><div class="search-snippet-title">${title}</div></a>`).join(''));
      }
      return reply(url, '');
    });
    const prisma = { sourceDefinition: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    const rates = { waitForDomain: vi.fn().mockResolvedValue(undefined) } as unknown as RateLimiterService;
    const extraction = { extract: vi.fn().mockResolvedValue({ fields: [] }) } as unknown as ExtractionService;
    const service = new CompetitionDiscoveryService(prisma, { fetch } as unknown as SafeEgressService, null!,
      rates, extraction, { configured: false } as LlmService, null!);
    const { id } = service.startRun({ name }, 'owner');
    try {
      await vi.waitFor(() => expect(service.getRun(id, 'owner').livePages).toHaveLength(1));
      const run = service.getRun(id, 'owner');
      expect(run.status).toBe('running');
      expect(run.result).toBeUndefined();
      expect(run.livePages?.[0]).toMatchObject({ url: fast, year, fields: expect.arrayContaining([
        expect.objectContaining({ key: 'nearestDeadline', value: `${year}年8月1日` }),
        expect.objectContaining({ key: 'competitionContent', value: '参赛队需完成建模分析、程序验证与论文撰写。' }),
      ]) });
    } finally {
      finishSlow(reply(slow, '<article><h1>往届赛事</h1></article>'));
    }
    await vi.waitFor(() => expect(service.getRun(id, 'owner').status).toBe('completed'));
    expect(service.getRun(id, 'owner').result?.pages.map(page => page.url)).toEqual([fast]);
  });

  it('在官网入口上补入同届公告的科目、分项报名截止和跨年省赛时间', async () => {
    const year = currentDiscoveryYear();
    const home = 'https://dasai.lanqiao.cn/';
    const pdf = 'https://x-static.lanqiao.cn/guide.pdf';
    const announcement = '关于举办第十八届蓝桥杯全国大学生软件和信息技术大赛的通知';
    const scheduleTitle = (edition: string) => `关于公布${edition}蓝桥杯大赛省赛比赛时间的通知`;
    const record = { appid: 'dasai', programaId: 20, nstatus: 1, publishTime: `${year}-10-08T00:00:00` };
    const schedule = { ...record, nnid: 406, title: scheduleTitle('第十八届') };
    const previousSchedule = { ...record, nnid: 405, title: scheduleTitle('第十七届') };
    const main = { ...record, nnid: 408, title: announcement };
    const reply = (url: string, body: string, contentType = 'text/html') =>
      ({ ok: true, status: 200, finalUrl: url, buffer: Buffer.from(body), contentType }) as RawFetchResult;
    const json = (url: string, payload: object) => reply(url, JSON.stringify({ succ: true, ...payload }), 'application/json');
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith('https://search.brave.com/')) {
        return reply(url, `<a href="${home}"><div class="search-snippet-title">蓝桥杯大赛官网</div></a>`);
      }
      if (url.startsWith('https://www.sogou.com/')) return reply(url, '');
      if (url === home) {
        return reply(url, '<title>蓝桥杯大赛</title>' + ['软件赛<br>电子赛', '视觉艺术<br>设计赛', '专项赛', '人工智能赛', '数字科技<br>创新赛']
          .map((track, index) => `<div class="race-item"><span class="title">${track}</span><a href="/track-${index}">我要报名</a></div>`).join(''));
      }
      if (url === lanqiaoNoticeFeed(1)) {
        return json(url, { datalist: [previousSchedule, main, schedule] });
      }
      if (url === lanqiaoDetailFeed(previousSchedule.nnid)) {
        return json(url, { news: { ...previousSchedule, content: `<p>比赛时间：${year}年4月10日。</p>` } });
      }
      if (url === lanqiaoDetailFeed(main.nnid)) {
        return json(url, { news: { ...main, content: `<a href="${pdf}">第十八届大赛费用说明.pdf</a>` } });
      }
      if (url === lanqiaoDetailFeed(schedule.nnid)) {
        return json(url, { news: { ...schedule, content: `<table><tr><td>赛项</td><td>科目名称</td><td>省赛时间</td></tr>
          <tr><td rowspan="2">软件赛</td><td>C/C++程序设计</td><td>${year + 1}年4月10日周六<br>9:00—13:00</td></tr>
          <tr><td>Java 软件开发</td><td>${year + 1}年4月10日周六<br>9:00—13:00</td></tr>
          <tr><td>专项赛</td><td>鸿蒙应用开发</td><td>${year + 1}年4月24日周六<br>9:00—13:00</td></tr></table>` } });
      }
      if (url === pdf) return reply(url, '%PDF-1.5', 'application/pdf');
      if (new URL(url).origin === home.slice(0, -1)) {
        return reply(url, '<title>蓝桥杯大赛</title><script src="/site.js"></script><body><div id="app"></div></body>');
      }
      throw new Error('unexpected_url');
    });
    const guide = `第十八届蓝桥杯大赛费用说明
一、收费标准
1.软件赛
(1)C/C++程序设计
(2)Java 软件开发
2.电子赛
(1)单片机设计与开发
3.人工智能赛
(1)AI 模型应用开发
4.数字科技创新赛
(1)智能装备数字化建模
5.视觉艺术设计赛
(1)静态海报设计—命题
6.专项赛（产教融合赛道）
(1)鸿蒙应用开发
(2)蓝桥杯大赛主视觉与赛事IP 文创设计
二、报名时间说明
1.软件赛、电子赛、人工智能、专项赛（鸿蒙应用开发）报名时
间：${year} 年10 月8 日10:00—${year} 年12 月18 日14:00
2.视觉艺术设计赛、数字科技创新赛报名及提交作品时间：${year}
年10 月8 日10:00—${year + 1} 年4 月26 日14:00
3.专项赛（产教融合赛道）
(1)蓝桥杯大赛主视觉与赛事IP 文创设计报名及提交作品时间：
${year} 年9 月8 日14:00—${year} 年11 月30 日14:00
三、备赛系统`;
    let finishGuide!: (result: { ok: true; text: string }) => void;
    const parse = vi.fn(() => new Promise(resolve => { finishGuide = resolve; }));
    const prisma = { sourceDefinition: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    const rates = { waitForDomain: vi.fn().mockResolvedValue(undefined) } as unknown as RateLimiterService;
    const extraction = { extract: vi.fn().mockResolvedValue({ fields: [] }) } as unknown as ExtractionService;
    const service = new CompetitionDiscoveryService(prisma, { fetch } as unknown as SafeEgressService, null!, rates,
      extraction, { configured: false } as LlmService, { parse } as unknown as ParserClient);
    const id = service.startRun({ name: '蓝桥杯' }, 'owner').id;
    await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(1));
    expect(service.getRun(id, 'owner').livePages?.[0]?.tracks?.map(track => track.subjects)).toEqual(Array(5).fill(undefined));
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain(lanqiaoDetailFeed(405));
    finishGuide({ ok: true, text: guide });
    await vi.waitFor(() => expect(service.getRun(id, 'owner').status).toBe('completed'));
    const tracks = service.getRun(id, 'owner').result?.pages.find(page => page.url === home)?.tracks ?? [];
    expect(tracks).toHaveLength(5);
    expect(tracks.every(track => track.edition === '第十八届' && track.subjects?.length && track.registration?.length)).toBe(true);
    expect(tracks[0]).toMatchObject({
      subjects: ['C/C++程序设计', 'Java 软件开发', '单片机设计与开发'],
      registration: [{ end: `${year}年12月18日14:00`, includesSubmission: false }],
      schedule: [{ time: `${year + 1}年4月10日周六 9:00—13:00` }, { subject: 'Java 软件开发' }],
      guide: { url: pdf }, scheduleNotice: { url: home + 'notices/406' },
    });
    expect(tracks[2].registration).toMatchObject([
      { subject: '鸿蒙应用开发', end: `${year}年12月18日14:00` },
      { subject: '蓝桥杯大赛主视觉与赛事IP 文创设计', end: `${year}年11月30日14:00` },
    ]);
    expect(tracks[1].registration).toMatchObject([{ end: `${year + 1}年4月26日14:00`, includesSubmission: true }]);
    expect(tracks[4].schedule).toBeUndefined();
    expect(fetch.mock.calls.filter(([url]) => url === lanqiaoNoticeFeed(1))).toHaveLength(1);
    expect(service.getRun(id, 'owner').result?.issues).toContainEqual({
      url: home + 'notices/405', reason: 'edition_mismatch',
    });
  });

  it.each(['规则', '模型', '无效模型响应'])('%s从搜索找到官网并翻页，打开第二页的当年公告', async (mode) => {
    const year = currentDiscoveryYear();
    const home = 'https://dasai.lanqiao.cn/';
    const officialNotice = home + 'notices/301';
    const title = `${year}年蓝桥杯大赛报名通知`;
    const shell = '<title>蓝桥杯大赛 — 全国大学生TMT行业赛事</title><script src="/site.js"></script><body><div id="app"></div></body>';
    const trackCards = `<div class="race-item software flex"><span class="title">软件赛<br data-v-fixture="">电子赛</span><a href="/joined">我要报名</a></div>
      <div class="race-item vision"><span class="title">视觉艺术<br data-v-fixture="">设计赛</span><a href="https://design.lanqiao.cn">我要报名</a></div>
      <div class="race-item special"><span class="title">专项赛</span><a href="/special">我要报名</a></div>
      <div class="race-item ai"><span class="title">人工智能赛</span><a href="/ai">我要报名</a></div>
      <div class="race-item digital"><span class="title">数字科技<br>创新赛</span><a href="/digital">我要报名</a></div>
      <div class="race-item"><span class="title">站外入口</span><a href="https://third-party.example.org/">我要报名</a></div>`;
    const reply = (url: string, body: string, contentType = 'text/html'): RawFetchResult => ({
      ok: true, status: 200, buffer: Buffer.from(body), url, finalUrl: url, contentType,
      redirectChain: [], bytes: Buffer.byteLength(body), fingerprint: '', truncated: false,
    });
    const json = (url: string, payload: unknown) => reply(url, JSON.stringify(payload), 'application/json');
    const record = { nnid: 301, appid: 'dasai', programaId: 20, nstatus: 1, title, publishTime: `${year}-01-03T00:00:00` };
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith('https://search.brave.com/')) {
        return reply(url, `<a href="${home}?from=search"><div class="search-snippet-title">蓝桥杯大赛官网</div></a>
          <a href="${home}"><div class="search-snippet-title">蓝桥杯大赛官网</div></a>`);
      }
      if (url.startsWith('https://www.sogou.com/')) return reply(url, '');
      if (url === home) return reply(url, `<title>蓝桥杯大赛</title><body>${trackCards}</body>`);
      if ([LANQIAO_NOTICE_LIST, officialNotice].includes(url)) return reply(url, shell);
      if (url === lanqiaoNoticeFeed(1)) return json(url, { succ: true, total: 31, datalist: [
        { ...record, nnid: 304, title: '关于公布蓝桥杯大赛比赛时间的通知' },
        ...Array.from({ length: 9 }, (_, index) => ({ ...record, nnid: 400 + index, title: '蓝桥杯获奖名单' })),
      ] });
      if (url === lanqiaoNoticeFeed(2)) return json(url, { succ: true, total: 31, datalist: [
        record, { ...record, nnid: 302, title: '蓝桥杯往年通知', publishTime: `${year - 1}-12-01T00:00:00` },
        ...Array.from({ length: 8 }, (_, index) => ({ ...record, nnid: 500 + index, title: '蓝桥杯获奖名单' })),
      ] });
      if (url === lanqiaoNoticeFeed(3)) return json(url, { succ: true, total: 31, datalist:
        Array.from({ length: 10 }, (_, index) => ({ ...record, nnid: 600 + index, title: '蓝桥杯获奖名单' })),
      });
      if (url === lanqiaoNoticeFeed(4)) return json(url, { succ: true, total: 31, datalist: [
        { ...record, nnid: 303, title: '蓝桥杯获奖名单' },
      ] });
      if (url === lanqiaoDetailFeed(301)) return json(url, { succ: true, news: {
        ...record, content: `<p>报名截止时间：${year}年11月20日。</p>`,
      } });
      if (url === home + 'notices/304') return reply(url, shell);
      if (url === lanqiaoDetailFeed(304)) return json(url, { succ: true, news: {
        ...record, nnid: 304, title: '关于公布蓝桥杯大赛比赛时间的通知', content: `<p>比赛时间：${year + 1}年4月10日。</p>`,
      } });
      throw new Error('unexpected_url');
    });
    const prisma = { sourceDefinition: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    const rates = { waitForDomain: vi.fn().mockResolvedValue(undefined) } as unknown as RateLimiterService;
    const extraction = { extract: vi.fn().mockResolvedValue({ fields: [] }) } as unknown as ExtractionService;
    const decisions = vi.fn(async (_task: string, _system: string, input: string) => {
      const { candidates, evidence } = JSON.parse(input);
      const find = (text: string) => candidates.find((candidate: { title: string }) => candidate.title.includes(text))?.id;
      const skipped = find('第 3 页');
      const skipPaginationIds = skipped === undefined ? [] : [skipped];
      if (mode === '无效模型响应') return { success: true, data: { action: 'visit', ids: [999] } };
      if (evidence.length) {
        return { success: true, data: { action: 'stop', ids: [], reason: '第二页公告已核实' } };
      }
      return { success: true, data: {
        action: 'visit', ids: [find('第 2 页') ?? find(title) ?? 0], skipPaginationIds, reason: '核对官方资料',
      } };
    });
    const service = new CompetitionDiscoveryService(prisma, { fetch } as unknown as SafeEgressService, null!,
      rates, extraction, { configured: mode !== '规则', completeJson: decisions } as unknown as LlmService, null!);
    const logs: Array<{ url?: string; message: string }> = [];
    const livePages: Array<{ url: string }> = [];
    const result = await service.discover('蓝桥杯', 'owner', log => logs.push(log), page => livePages.push(page));
    expect(result.sites.map(site => site.url)).toEqual([home]);
    const tracks = [
      { title: '软件赛／电子赛', url: home + 'joined' }, { title: '视觉艺术设计赛', url: 'https://design.lanqiao.cn/' },
      { title: '专项赛', url: home + 'special' }, { title: '人工智能赛', url: home + 'ai' },
      { title: '数字科技创新赛', url: home + 'digital' },
    ];
    expect(livePages[0]).toMatchObject({ kind: 'site', url: home, tracks });
    expect(result.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'site', url: home, tracks, fields: [] }),
      expect.objectContaining({ kind: 'listing', url: LANQIAO_NOTICE_LIST, fields: [] }),
      expect.objectContaining({ kind: 'notice', url: officialNotice, year }),
    ]));
    const requests = fetch.mock.calls.map(([url]) => url);
    expect(requests.filter(url => url.startsWith(home) && new URL(url).pathname === '/')).toEqual([home]);
    expect(requests.filter(url => url.includes('/api/news/find'))).toEqual(mode === '模型'
      ? [lanqiaoNoticeFeed(1), lanqiaoNoticeFeed(2)]
      : [lanqiaoNoticeFeed(1), lanqiaoNoticeFeed(2), lanqiaoNoticeFeed(3), lanqiaoNoticeFeed(4)]);
    expect(requests.indexOf(officialNotice)).toBeGreaterThan(requests.indexOf(lanqiaoNoticeFeed(2)));
    if (mode === '模型') {
      expect(result.matching).toBe('model_assisted');
      expect(requests).not.toContain(home + 'notices/304');
      expect(logs.map(log => log.message)).toEqual(expect.arrayContaining([
        expect.stringContaining('停止翻页：蓝桥杯大赛通知 · 第 3 页'),
        expect.stringContaining('智能体结束网页采集。 第二页公告已核实'),
      ]));
    } else {
      expect(result.issues).toContainEqual({ url: home + 'notices/304', reason: 'year_mismatch' });
      expect(logs).toContainEqual(expect.objectContaining({ url: LANQIAO_NOTICE_LIST, message: expect.stringContaining('已到列表末页') }));
    }
    if (mode === '无效模型响应') expect(decisions).toHaveBeenCalledTimes(1);
    expect(logs).toContainEqual(expect.objectContaining({ url: LANQIAO_NOTICE_LIST, message: expect.stringContaining('蓝桥杯大赛') }));
    expect(logs).toContainEqual(expect.objectContaining({ url: officialNotice, message: expect.stringContaining('从「蓝桥杯大赛通知」发现') }));
  });

  it.each(['继续访问', '过早停止'])('模型%s时仍能找到第十七个网页上的公告，并按结果结束', async (mode) => {
    const year = currentDiscoveryYear();
    const name = '全国大学生数学建模竞赛';
    const site = 'https://contest.example.org';
    const title = `${year}年${name}报名通知`;
    const candidates = Array.from({ length: 18 }, (_, index) => `${site}/notice-${index + 1}`);
    const fetch = vi.fn(async (url: string) => {
      let body = '';
      if (url.startsWith('https://search.brave.com/')) {
        body = candidates.map(link => `<a href="${link}"><div class="search-snippet-title">${title}</div></a>`).join('');
      } else if (url === candidates[16]) {
        body = `<article><h1>${title}</h1><p>报名截止时间：${year}年11月20日。</p></article>`;
      }
      return { ok: true, status: 200, buffer: Buffer.from(body), finalUrl: url, contentType: 'text/html' } as RawFetchResult;
    });
    const decisions = vi.fn(async (_task: string, _system: string, input: string) => {
      const { evidence } = JSON.parse(input);
      const stop = mode === '过早停止' || evidence.some((page: { fields: string[] }) => page.fields.length);
      return { success: true, data: stop ? { action: 'stop', ids: [] } : { action: 'visit', ids: [0] } };
    });
    const prisma = { sourceDefinition: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    const rates = { waitForDomain: vi.fn().mockResolvedValue(undefined) } as unknown as RateLimiterService;
    const extraction = { extract: vi.fn().mockResolvedValue({ fields: [] }) } as unknown as ExtractionService;
    const service = new CompetitionDiscoveryService(prisma, { fetch } as unknown as SafeEgressService, null!,
      rates, extraction, { configured: true, completeJson: decisions } as unknown as LlmService, null!);
    const logs: string[] = [];
    const result = await service.discover(name, 'owner', log => logs.push(log.message));

    expect(result.pages).toContainEqual(expect.objectContaining({
      url: candidates[16], year,
      fields: expect.arrayContaining([expect.objectContaining({ key: 'nearestDeadline' })]),
    }));
    expect(fetch.mock.calls.map(([url]) => url).filter(url => url.startsWith(site))).toEqual(candidates.slice(0, 17));
    expect(logs).toContain('智能体结束网页采集。');
    if (mode === '过早停止') expect(logs.some(message => message.startsWith('尚未取得可录入字段'))).toBe(true);
  });

  it('沿普通网站的下一页找到只出现在第四页的公告，跳过站外链接和已访问的分页', async () => {
    const year = currentDiscoveryYear();
    const name = '全国大学生数学建模竞赛';
    const site = 'https://contest.example.org/';
    const fetch = vi.fn(async (url: string) => {
      let body: string;
      if (url.startsWith('https://search.brave.com/')) {
        body = `<a href="${site}"><div class="search-snippet-title">${name}官网</div></a>`;
      } else if (url.startsWith('https://www.sogou.com/')) body = '';
      else if (url === site) body = `<title>${name}</title><a href="/news">竞赛通知</a>`;
      else if (url === site + 'news') body = `<title>通知公告 - ${name}</title><h1>通知公告 - ${name}</h1>
        <a href="/regional"><h2>${year}年${name}（赛区）报名通知</h2><p>报名截止：${year}年7月1日。</p></a>
        <a href="https://other.example.org/">下一页</a><a href="?page=2" title="下一页"><svg></svg></a>`;
      else if (url === site + 'news?page=2') body = '<title>通知列表</title><link rel="next" href="?page=3">';
      else if (url === site + 'news?page=3') body = '<title>通知列表</title><link rel="next" href="?page=4">';
      else if (url === site + 'news?page=4') body = `<title>通知列表</title><a href="/notice">${year}年${name}报名通知</a><a href="?page=2">下一页</a>`;
      else if (url === site + 'regional') body = `<article><h1>${year}年${name}（赛区）报名通知</h1><p>报名截止：${year}年7月1日。</p></article>`;
      else if (url === site + 'notice') body = `<article><h1>${year}年${name}报名通知</h1>
        <p>（一）报名及作品提交</p><p>赛程时间：截至${year}年8月1日23:59:59</p>
        <p>（二）赛区选拔赛</p><p>赛程时间：截至${year}年9月2日23:59:59</p></article>`;
      else throw new Error('unexpected_url');
      return { ok: true, status: 200, buffer: Buffer.from(body), finalUrl: url, contentType: 'text/html' } as RawFetchResult;
    });
    const prisma = { sourceDefinition: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    const rates = { waitForDomain: vi.fn().mockResolvedValue(undefined) } as unknown as RateLimiterService;
    const extraction = { extract: vi.fn().mockResolvedValue({ fields: [] }) } as unknown as ExtractionService;
    const service = new CompetitionDiscoveryService(prisma, { fetch } as unknown as SafeEgressService, null!,
      rates, extraction, { configured: false } as LlmService, null!);
    const result = await service.discover(name, 'owner');
    expect(result.pages[0]).toMatchObject({ url: site + 'notice', kind: 'notice', scope: 'general', fields: [
      expect.objectContaining({ key: 'nearestDeadline', value: `${year}年8月1日23:59:59` }),
    ] });
    expect(result.pages.find(page => page.url === site + 'news')).toMatchObject({ kind: 'listing', fields: [] });
    expect(result.pages.map(page => page.url)).toHaveLength(3);
    expect(extraction.extract).toHaveBeenCalledTimes(2);
    const requests = fetch.mock.calls.map(([url]) => url).filter(url => !/brave|sogou/.test(url));
    expect(requests.filter(url => url.startsWith(site + 'news'))).toEqual([
      site + 'news', site + 'news?page=2', site + 'news?page=3', site + 'news?page=4',
    ]);
    expect(requests).not.toContain('https://other.example.org/');
  });

  it('无新增证据的分页链按无进展时限结束', async () => {
    const name = '全国大学生数学建模竞赛';
    const site = 'https://contest.example.org/';
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const fetch = vi.fn(async (url: string) => {
        const address = new URL(url);
        let body = '';
        if (address.hostname === 'search.brave.com') {
          body = `<a href="${site}"><div class="search-snippet-title">${name}官网</div></a>`;
        } else if (address.origin === new URL(site).origin) {
          now += 31_000;
          const page = Number(address.searchParams.get('page') ?? '1');
          body = `<title>${name}</title><a href="?page=${page + 1}">下一页</a>`;
        }
        return { ok: true, status: 200, buffer: Buffer.from(body), finalUrl: url, contentType: 'text/html' } as RawFetchResult;
      });
      const prisma = { sourceDefinition: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaService;
      const rates = { waitForDomain: vi.fn().mockResolvedValue(undefined) } as unknown as RateLimiterService;
      const service = new CompetitionDiscoveryService(prisma, { fetch } as unknown as SafeEgressService, null!,
        rates, null!, { configured: false } as LlmService, null!);
      const logs: string[] = [];
      await service.discover(name, 'owner', log => logs.push(log.message));

      expect(fetch.mock.calls.map(([url]) => url).filter(url => url.startsWith(site))).toEqual([
        site, site + '?page=2', site + '?page=3',
      ]);
      expect(logs.some(message => message.includes('近期没有新增相关线索或可录入字段'))).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('搜索请求未结束时即可读取日志，拒绝其他用户读取并合并重复启动', async () => {
    const prisma = {
      sourceDefinition: { findMany: vi.fn().mockResolvedValue([]) },
      competition: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    let finishRequest!: (result: RawFetchResult) => void;
    const pending = new Promise<RawFetchResult>(resolve => { finishRequest = resolve; });
    const egress = { fetch: vi.fn().mockReturnValue(pending) } as unknown as SafeEgressService;
    const rates = { waitForDomain: vi.fn().mockResolvedValue(undefined), noteRateLimited: vi.fn() } as unknown as RateLimiterService;
    const service = new CompetitionDiscoveryService(
      prisma, egress, null!, rates, null!, { configured: false } as LlmService, null!,
    );

    const input = { name: '全国大学生数学建模竞赛' };
    const { id } = service.startRun(input, 'owner');
    expect(service.startRun(input, 'owner').id).toBe(id);
    expect(() => service.getRun(id, 'another-user')).toThrow(expect.objectContaining({ code: 'RESOURCE_NOT_FOUND' }));
    expect(service.getRun(id, 'owner')).toMatchObject({ status: 'running' });
    expect(service.getRun(id, 'owner').logs).toContainEqual(expect.objectContaining({ stage: 'search', level: 'info' }));

    finishRequest({ ok: false, status: 429 } as RawFetchResult);
    await vi.waitFor(() => expect(service.getRun(id, 'owner').status).toBe('completed'));
    const finished = service.getRun(id, 'owner');
    expect(finished.result?.searches.map(search => search.provider)).toEqual(['brave', 'sogou', 'bing']);
    expect(finished.finishedAt).toBeTruthy();
    expect(finished.logs).toContainEqual(expect.objectContaining({ stage: 'search', level: 'warning', reason: 'http_429' }));
    const searchLogs = finished.logs.filter(log => log.stage === 'search');
    const started = searchLogs.filter(log => log.operation?.phase === 'start');
    expect(new Set(started.map(log => log.operation?.id)).size).toBe(3);
    for (const log of started) {
      expect(searchLogs).toContainEqual(expect.objectContaining({
        operation: { ...log.operation, phase: 'end' }, reason: 'http_429',
      }));
    }
    expect(finished.logs.at(-1)).toMatchObject({ stage: 'task', level: 'success' });

    const failed = service.startRun({ competitionId: 'missing-competition' }, 'owner');
    await vi.waitFor(() => expect(service.getRun(failed.id, 'owner').status).toBe('failed'));
    expect(service.getRun(failed.id, 'owner').logs.at(-1)).toMatchObject({ level: 'error', reason: 'RESOURCE_NOT_FOUND' });
  });

  it('各搜索词限定当年，跳过已知旧链接并在提取前拦截其他年份和未确认资料', async () => {
    const year = currentDiscoveryYear();
    const name = '全国大学生数学建模竞赛';
    const base = 'https://contest.example.org/';
    const links = [
      [base, name],
      [base + 'old', `${year - 1}年${name}报名通知`],
      [base + 'redirect', `${name}报名通知`],
      [base + 'unknown', `第十九届${name}报名通知`],
      [base + 'current', `${year}年第十七届${name}报名通知`],
    ];
    const html = (title: string, body: string) => `<title>${title}</title><article><h1>${title}</h1>${body}</article>`;
    const reply = (url: string, body: string, contentType = 'text/html') => ({
      ok: true, status: 200, buffer: Buffer.from(body), finalUrl: url, contentType,
    } as RawFetchResult);
    const fetch = vi.fn(async (url: string) => {
      const address = new URL(url);
      if (address.hostname === 'search.brave.com') return reply(url, links.map(([href, title]) =>
        `<a href="${href}"><div class="search-snippet-title">${title}</div></a>`).join(''));
      if (address.hostname === 'www.sogou.com') return reply(url, '');
      if (url === base) return reply(url, `<title>${name}</title><a href="/current">${links[4][1]}</a>`);
      if (url === base + 'redirect') return reply(base + 'redirected-old',
        html(`${year - 1}年${name}报名通知`, '<p>主办单位：测试主办机构</p>'));
      if (url === base + 'unknown') return reply(url, html(links[3][1], '<p>主办单位：测试主办机构</p>'));
      if (url === base + 'current') return reply(url, html(links[4][1],
        `<p>报名截止时间：${year}年8月1日。</p><a href="/old-title.pdf">${year - 1}年章程.pdf</a><a href="/mismatch.pdf">${year}年章程.pdf</a><a href="/current.pdf">第十七届章程.pdf</a>`));
      if (url.endsWith('.pdf')) return reply(url, '%PDF-fixture', 'application/pdf');
      throw new Error('unexpected_url');
    });
    const prisma = { sourceDefinition: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    const rates = { waitForDomain: vi.fn().mockResolvedValue(undefined) } as unknown as RateLimiterService;
    const extract = vi.fn().mockResolvedValue({ fields: [] });
    const parser = { parse: vi.fn()
      .mockResolvedValueOnce({ ok: true, text: `${year - 1}年${name}章程`, blocks: [] })
      .mockResolvedValueOnce({ ok: true, text: `第十七届${name}章程\n参赛对象：大学生`, blocks: [] }) } as unknown as ParserClient;
    const service = new CompetitionDiscoveryService(prisma, { fetch } as unknown as SafeEgressService, null!,
      rates, { extract } as unknown as ExtractionService, { configured: false } as LlmService, parser);
    const result = await service.discover(`${year - 1}年${name}`, 'owner');

    expect(result.targetYear).toBe(year);
    expect(result.searches.every(row => row.query.startsWith(`${year} ${name}`))).toBe(true);
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain(base + 'old');
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain(base + 'old-title.pdf');
    expect(result.sites.map(site => site.url)).toEqual([base]);
    expect(result.pages.map(page => [page.url, page.year])).toEqual([[base + 'current', year], [base + 'current.pdf', year]]);
    expect(result.pages[0].attachments.map(link => link.url)).toEqual([base + 'current.pdf']);
    expect(result.issues).toEqual(expect.arrayContaining([
      { url: base + 'redirect', reason: 'year_mismatch' },
      { url: base + 'unknown', reason: 'year_unconfirmed' },
      { url: base + 'mismatch.pdf', reason: 'year_unconfirmed' },
    ]));
    expect(extract).toHaveBeenCalledTimes(2);
  });
});
