import { describe, expect, it } from 'vitest';
import {
  currentDiscoveryYear, discoveryFields, discoveryTarget, discoveryUrl, identityScore,
  discoverySearches, inspectDiscoveryPage, isDiscoverySiteCandidate, noticeYear, parseSearchResults, scoreDiscoveryLink,
} from './competition-discovery';
import { extractFields } from './rule-extractor';

const target = discoveryTarget('2026 数模国赛', 2026);
const site = 'https://example.org/';

describe('competition discovery', () => {
  it('does not replace a registration cutoff with a later competition-completion date', () => {
    const body = '省赛报名截止时间为2026年10月15日20:00，省赛具体时间由各赛区组委会决定，但最迟应在11月1日之前完成。';
    const page = { url: site + 'notice', title: '2026年全国大学生数学建模竞赛通知',
      kind: 'notice' as const, scope: 'general' as const, year: 2026, edition: null, excerpt: body, attachments: [], fields: [] };
    const fields = discoveryFields(page, body, [], extractFields(body, [], page.title));
    expect(fields.filter(field => field.key === 'nearestDeadline').map(field => field.value)).toEqual(['2026年10月15日20:00']);
  });

  it('recognizes university selection and school-level competition notices as campus scope', () => {
    for (const title of [
      '关于开展“2026年中国大学生机械工程创新创意大赛”文华学院校级竞赛的通知',
      '关于举办2026年长春工程学院第十一届大学生力学竞赛暨全国周培源大学生力学竞赛选拔赛的通知',
    ]) {
      const name = title.includes('机械') ? '中国大学生机械工程创新创意大赛' : '全国周培源大学生力学竞赛';
      const data = inspectDiscoveryPage(discoveryTarget(name, 2026), `<article><h1>${title}</h1><p>报名时间：2026年11月14日—11月25日。</p></article>`, 'https://jwc.example.edu.cn/notice');
      expect(data.campusNotice).toBe(true);
    }
  });

  it('expands a name alias while distinguishing similarly named contests', () => {
    expect(target.name).toBe('全国大学生数学建模竞赛');
    expect(target.year).toBe(2026);
    expect(identityScore(target, '2026年高教社杯全国大学生数学建模竞赛第一次通知')).toBeGreaterThanOrEqual(80);
    expect(identityScore(target, '2026年“科创杯”全国大学生数学建模竞赛')).toBeLessThan(80);
    expect(identityScore(target, '数维杯全国大学生数学建模挑战赛官网')).toBeLessThan(80);
    expect(isDiscoverySiteCandidate(target, { url: 'https://competition.example.edu.cn/',
      title: 'MCM - 全国大学生数学建模竞赛' })).toBe(true);
    expect(identityScore(discoveryTarget('全国大学生艺术展演'), '教育部关于举办全国第八届大学生艺术展演活动的通知'))
      .toBeGreaterThanOrEqual(80);
    expect(identityScore(discoveryTarget('两岸新锐设计竞赛·华灿奖'), '关于举办2026新锐设计竞赛·华灿奖的通知'))
      .toBeGreaterThanOrEqual(80);
    expect(identityScore(discoveryTarget('“挑战杯”中国大学生创业计划大赛'), '第十五届“挑战杯”中国大学生创业计划竞赛'))
      .toBeGreaterThanOrEqual(80);
    expect(discoveryTarget('全国大学生机器人大赛-①RoboMaster、②RoboCon').aliases)
      .toContain('RoboMaster');
    expect(identityScore(discoveryTarget('全国大学生结构设计竞赛'), '第十九届全国大学生结构设计信息技术大赛')).toBe(0);
    expect(discoverySearches(discoveryTarget('中国高校计算机大赛-①大数据挑战赛、②团体程序设计天梯赛、③移动应用创新赛④网络技术挑战赛、⑤人工智能创意赛')))
      .toContain('中国高校计算机大赛');
    expect(discoverySearches(discoveryTarget('外研社全国大学生英语系列赛-①英语演讲、②英语辩论、③英语写作、④英语阅读')))
      .toContain('外研社国才杯全国大学生外语能力大赛');
  });

  it('keeps a verified year for yearless registration dates and ignores the article publication date', () => {
    const title = '2026年全国大学生数学建模竞赛第一次通知';
    const data = inspectDiscoveryPage(target, `<h1>${title}</h1><p>来源：竞赛 | 发布时间：2026-03-24</p>
      <p>2026年竞赛时间定为9月10日（周四）18时至9月13日（周日）20时。</p>
      <p>向全国组委会报名的截止时间为9月7日（周一）20时。</p>
      <p>通过竞赛管理系统报名（网址：https://signup.example.org/）。</p>`, site + 'notice');
    const fields = discoveryFields(data.page, data.body, data.links, extractFields(data.body, [], title));
    expect(fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'nearestDeadline', value: '2026年9月7日20:00' }),
      expect.objectContaining({ key: 'scheduleNote', value: expect.stringContaining('9月10日') }),
      expect.objectContaining({ key: 'signupUrl', value: 'https://signup.example.org/' }),
    ]));
    expect(fields.some(field => field.quote.includes('发布时间'))).toBe(false);
  });

  it('uses the first event stage for a cross-year exhibition and preserves distinct track deadlines', () => {
    const exhibition = discoveryTarget('全国大学生艺术展演', 2026);
    const exhibitTitle = '教育部关于举办全国第八届大学生艺术展演活动的通知';
    const notice = inspectDiscoveryPage(exhibition, `<h1>${exhibitTitle}</h1><p>四、展演项目</p><p>包含艺术表演、艺术作品和工作坊。</p>
      <p>五、参加人员</p><p>艺术表演参加人员为全国普通高校全日制在籍学生。</p><p>各高校须面向人人开展艺术实践活动。</p>
      <p>（三）全国汇演阶段（2027年1—6月）</p><p>（一）校级展演阶段（2026年4—7月）</p>`, site + 'exhibition');
    expect(notice.page).toMatchObject({ kind: 'notice', year: 2026 });
    const fields = discoveryFields(notice.page, notice.body, [], extractFields(notice.body, [], exhibitTitle));
    expect(fields.find(field => field.key === 'scheduleNote')?.value).toContain('2027年1—6月');
    expect(fields.find(field => field.key === 'eligibility')?.value).toContain('全日制在籍学生');
    expect(fields.some(field => field.key === 'nearestDeadline')).toBe(false);
    const olderHome = inspectDiscoveryPage(exhibition, '<title>全国第六届大学生艺术展演活动</title><p>全国汇演资料</p>', site);
    expect(olderHome.siteIdentity).toBe(false);
    const design = discoveryTarget('两岸新锐设计竞赛·华灿奖', 2026);
    const designTitle = '关于举办2026新锐设计竞赛·华灿奖的通知';
    const awards = inspectDiscoveryPage(design, `<h1>${designTitle}</h1>
      <p>主办单位：中国高等教育学会、中华中山文化交流协会</p>
      <p>各高校负责校内选拔，按时保质完成作品推荐工作。</p><p>决赛时间：2027年3月5日。</p>
      <p>创意赛道作品征集截止时间：2026年11月27日17:00</p><p>定向主题作品征集截止时间：2027年3月5日17:00</p>`, site + 'design');
    expect(awards.page.scope).toBe('general');
    const awardFields = discoveryFields(awards.page, awards.body, [], extractFields(awards.body, [], designTitle));
    expect(awardFields.find(field => field.key === 'scheduleNote')?.value).toContain('2027年3月5日17:00');
    expect(awardFields.find(field => field.key === 'scheduleNote')?.value).toContain('2026年11月27日17:00');
    expect(awardFields.some(field => field.key === 'nearestDeadline')).toBe(false);
  });

  it('identifies track sites and query-based articles separately', () => {
    const systems = discoveryTarget('全国大学生计算机系统能力大赛', 2026);
    const title = '2026年全国大学生计算机系统能力大赛 CPU设计赛（龙芯杯）';
    expect(inspectDiscoveryPage(systems, `<title>${title}</title><h1>${title}</h1>`, site).page.scope).toBe('track');
    const detail = inspectDiscoveryPage(systems, `<title>第十届“龙芯杯”全国大学生计算机系统能力培养大赛章程 – NSCSCC 2026</title>
      <article><h1>第十届“龙芯杯”全国大学生计算机系统能力培养大赛章程</h1><p>主办单位：全国高等学校计算机教育研究会</p></article>`, site + '?p=844');
    expect(detail.page).toMatchObject({ kind: 'notice', scope: 'track', year: 2026 });
  });

  it('uses the Shanghai calendar and replaces the catalog title year with the requested year', () => {
    expect(currentDiscoveryYear(new Date('2026-12-31T15:59:59Z'))).toBe(2026);
    expect(currentDiscoveryYear(new Date('2026-12-31T16:00:00Z'))).toBe(2027);
    expect(discoveryTarget('2025年第十六届蓝桥杯', 2026)).toMatchObject({ name: '蓝桥杯全国软件和信息技术专业人才大赛', year: 2026 });
    expect(scoreDiscoveryLink(target, { title: '2025年全国大学生数学建模竞赛报名通知', url: site + 'old' })).toBe(0);
  });

  it('identifies the event year without trusting publication dates, footers or earlier editions', () => {
    const title = '全国大学生数学建模竞赛报名通知';
    const article = (body: string) => inspectDiscoveryPage(target,
      `<title>${title}</title><article><h1>${title}</h1>${body}</article><footer>版权所有 2026</footer>`,
      site + '2025/1234');
    const crossYear = article('<p>报名截止时间：2025年12月28日。</p><p>竞赛时间：2026年2月1日。</p>');
    expect(crossYear.page.year).toBe(2026);
    expect(discoveryFields(crossYear.page, crossYear.body, [], extractFields(crossYear.body, [], title)))
      .toContainEqual(expect.objectContaining({ key: 'nearestDeadline', value: '2025年12月28日' }));
    expect(article('<p>发布时间：2026年3月1日</p><p>去年报名截止时间：2025年8月30日。</p><p>参赛对象：全日制本科生。</p>').page.year).toBeNull();
    expect(article('<p>报名截止时间：2025年8月30日。</p>').page.year).toBe(2025);
  });

  it('inherits the confirmed year only for an attachment with a matching edition', () => {
    const parent = inspectDiscoveryPage(target, '<article><h1>2026年第十七届全国大学生数学建模竞赛报名通知</h1><p>报名截止时间：2026年8月30日。</p></article>', site + 'notice').page;
    expect(noticeYear(target, '第十七届竞赛章程.pdf', '参赛对象：全日制本科生。', parent)).toBe(2026);
    expect(noticeYear(target, '第十六届竞赛章程.pdf', '参赛对象：全日制本科生。', parent)).toBeNull();
    expect(noticeYear(target, '2026年竞赛章程.pdf', '2025年全国大学生数学建模竞赛章程', parent)).toBeNull();
  });

  it('uses an official document number to confirm a numbered edition year', () => {
    const classic = discoveryTarget('中华经典诵写讲大赛', 2026);
    const data = inspectDiscoveryPage(classic, '<article><h1>教育部 国家语委关于举办第八届中华经典诵写讲大赛的通知</h1><p>教语用函〔2026〕1号</p><p>三、大赛赛项</p><p>本届大赛分四个赛项：“诵读中国”诵读大赛、“诗教中国”讲解大赛、“笔墨中国”书写大赛、“印记中国”篆刻大赛。</p></article>', site + 'classic');
    expect(data.page.year).toBe(2026);
    const fields = discoveryFields(data.page, data.body, [], extractFields(data.body, [], data.page.title));
    expect(fields.find(field => field.key === 'competitionContent')?.value).toContain('四个赛项');
  });

  it('accepts public search links and discards invalid targets', () => {
    const results = '<a href="https://example.org/?a=1&amp;b=2"><div class="title search-snippet-title">比赛报名</div></a>' +
      '<a href="file:///tmp/test"><div class="search-snippet-title">无效</div></a>';
    expect(parseSearchResults('brave', results)).toEqual([{ url: site + '?a=1&b=2', title: '比赛报名' }]);
    expect(parseSearchResults('sogou', '<h3><a href="/link?url=abc">大赛 <em>官网</em></a></h3>' +
      '<a class="citeLinkClass" href="https://example.org/news">example.org/news</a>'))
      .toEqual([{ url: site + 'news', title: '大赛 官网' }]);
    expect(discoveryUrl('https://[::1]/')).toBeNull();
    expect(discoveryUrl('http://contest.example.org:8080/')).toBe('http://contest.example.org:8080/');
    expect(discoveryUrl('https://example.org:8000/')).toBeNull();
  });

  it('recognizes a homepage and follows its public notice links without using list dates as fields', () => {
    const data = inspectDiscoveryPage(target, `<title>全国大学生数学建模竞赛</title><body>
      <a href="/2026">2026年全国大学生数学建模竞赛报名通知</a>
      <p>报名截止：2026年6月1日</p><a href="/awards">2026年竞赛获奖公示</a>
      </body>`, site);
    expect(data.page.kind).toBe('site');
    expect(data.page.title).toBe(target.name);
    expect(data.page.year).toBeNull();
    expect(data.page.fields).toEqual([]);
    expect(data.followLinks.map((link) => link.url)).toEqual([site + '2026']);
    const personalSite = inspectDiscoveryPage(target,
      '<title>全国大学生数学建模竞赛</title><p>非官方网站，个人收集的赛事资料。</p>', site);
    expect(personalSite.siteIdentity).toBe(false);
  });

  it('keeps a regional deadline and official-site link on the original notice', () => {
    const data = inspectDiscoveryPage(target, `<title>通知｜某大学</title><body><article>
      <h1>2026年全国大学生数学建模竞赛校内报名通知</h1>
      <p>报名截止时间：2026年6月10日。</p>
      <p>报名联络员：邮箱 contact@qq.com，联系方式见 https://qq.com。</p>
      <p>竞赛官网 <a href="https://official.example.org/">官方网站</a></p>
      <p><a href="rules.pdf">竞赛章程</a></p></article></body>`, site + '2026');
    expect(data.page).toMatchObject({ kind: 'notice', scope: 'regional', year: 2026 });
    expect(data.officialLinks.map((link) => link.url)).toEqual(['https://official.example.org/']);
    expect(data.page.attachments).toEqual([{ url: site + 'rules.pdf', title: '竞赛章程' }]);
    const fields = discoveryFields(data.page, data.body, data.links, extractFields(data.body, [], data.page.title));
    expect(fields).toContainEqual({
      key: 'nearestDeadline', label: '报名截止时间', value: '2026年6月10日', quote: '报名截止时间：2026年6月10日。',
    });
    expect(fields.some((field) => field.key === 'signupUrl')).toBe(false);
  });

  it('rejects teacher workshops, historical organizer prose and unrelated introduction as eligibility', () => {
    const workshop = inspectDiscoveryPage(discoveryTarget('全国大学生广告艺术大赛'),
      '<title>关于举办大广赛第三期“青年教师AIGC设计实战应用研修班”的通知</title><article><h1>关于举办大广赛第三期“青年教师AIGC设计实战应用研修班”的通知</h1><p>主办方：全国大学生广告艺术大赛组委会</p><p>培训时间：2026年7月1日。</p></article>', site + 'workshop');
    expect(workshop.page.kind).toBe('listing');
    const design = inspectDiscoveryPage(discoveryTarget('中国大学生计算机设计大赛'),
      '<article><h1>2026年中国大学生计算机设计大赛通知</h1><p>大赛的第一届由教育部高等学校文科计算机基础教学指导委员会独立发起主办；从第十三届开始，根据教育部高教司的相关通知，大赛由中国大学生计算机设计大赛组织委员会主办。</p><p>大赛的参赛对象，是全国高等院校中所有专业的当年在籍本科生。</p></article>', site + 'design');
    const fields = discoveryFields(design.page, design.body, [], extractFields(design.body, [], design.page.title));
    expect(fields.some(field => field.key === 'organizer')).toBe(false);
    expect(fields.some(field => field.key === 'eligibility')).toBe(false);
    const campus = inspectDiscoveryPage(target, '<article><h1>2026年全国大学生数学建模竞赛报名通知</h1><p>主办单位：教务处</p><p>参赛对象：全日制本科生。</p></article>', site + 'campus');
    expect(discoveryFields(campus.page, campus.body, [], extractFields(campus.body, [], campus.page.title)).some(field => field.key === 'organizer')).toBe(false);
    const valid = inspectDiscoveryPage(target, '<article><h1>2026年全国大学生数学建模竞赛报名通知</h1><p>主办单位：中国工业与应用数学学会</p><p>参赛对象：全日制本科生。</p></article>', site + 'official');
    expect(discoveryFields(valid.page, valid.body, [], extractFields(valid.body, [], valid.page.title))).toContainEqual(expect.objectContaining({ key: 'organizer', value: '中国工业与应用数学学会' }));
    const signup = inspectDiscoveryPage(target, '<article><h1>2026年全国大学生数学建模竞赛报名通知</h1><p>登录官网https://contest.example.org/进行报名，截止2026年8月1日。</p></article>', site + 'signup');
    expect(discoveryFields(signup.page, signup.body, [], extractFields(signup.body, [], signup.page.title))).toContainEqual(expect.objectContaining({ key: 'signupUrl', value: 'https://contest.example.org/' }));
  });

  it('does not turn a start date or a site title suffix into notice evidence', () => {
    const title = '2026年全国大学生数学建模竞赛报名通知';
    const data = inspectDiscoveryPage(target, `<title>${title}</title><body>
      <h1>${title}</h1><p>报名时间：2026年5月1日起。</p>
      <a href="https://signup.example.org/">报名系统</a></body>`, site + '2026');
    const fields = discoveryFields(data.page, data.body, data.links, extractFields(data.body, [], data.page.title));
    expect(fields.map((field) => field.key)).toEqual(['signupUrl']);
    const unrelated = inspectDiscoveryPage(target,
      '<title>采购通知｜全国大学生数学建模竞赛</title><h1>采购通知</h1><p>报价截止时间：2026年5月1日</p>', site + 'purchase');
    expect(unrelated.page.kind).not.toBe('notice');
  });

  it('reads an official competition platform without confusing the following paragraph for its content', () => {
    const classic = discoveryTarget('中华经典诵写讲大赛');
    const page = inspectDiscoveryPage(classic, `<article><h1>教育部 国家语委关于举办第八届中华经典诵写讲大赛的通知</h1>
      <p>教语用函〔2026〕1号</p><h2>二、赛事平台</h2><p>大赛官网：https://jdsxj.eduyun.cn。参赛者可通过官网报名参赛。</p>
      <h2>三、大赛赛项</h2><p>本届大赛分四个赛项：“诵读中国”诵读大赛、“诗教中国”讲解大赛、“笔墨中国”书写大赛、“印记中国”篆刻大赛。</p>
      <h2>四、大赛组织</h2><p>包括初赛、复赛、决赛。</p></article>`, site + 'classic');
    const fields = discoveryFields(page.page, page.body, [], extractFields(page.body, [], page.page.title));
    expect(fields).toContainEqual(expect.objectContaining({ key: 'competitionContent', value: expect.stringContaining('四个赛项') }));
    expect(fields).toContainEqual(expect.objectContaining({ key: 'signupUrl', value: 'https://jdsxj.eduyun.cn' }));
    expect(fields.find(field => field.key === 'signupUrl')?.value).not.toContain('。');
  });

  it('accepts all ministries in a jointly hosted notice', () => {
    const page = inspectDiscoveryPage(discoveryTarget('中国国际大学生创新大赛'),
      '<article><h1>教育部关于举办中国国际大学生创新大赛（2026）的通知</h1><p>参赛团队通过登录全国大学生创业服务网（网址：https://cy.ncss.cn）进行报名。</p><p>（一）大赛由教育部、中央统战部、中央网信办、国家发展改革委、工业和信息化部、人力资源社会保障部、农业农村部、中国科学院、中国工程院、国家知识产权局、共青团中央和江苏省人民政府联合主办，南京大学和南京市人民政府共同承办。</p></article>',
      site + 'ministries');
    const fields = discoveryFields(page.page, page.body, [], extractFields(page.body, [], page.page.title));
    expect(fields).toContainEqual(expect.objectContaining({ key: 'organizer', value: expect.stringContaining('共青团中央和江苏省人民政府') }));
  });

  it('recognizes the official ISCC short name and its eligibility heading', () => {
    const target = discoveryTarget('全国大学生信息安全与对抗技术竞赛');
    expect(identityScore(target, '2026年第23届信息安全与对抗技术竞赛通知')).toBeGreaterThanOrEqual(80);
    const page = inspectDiscoveryPage(target, '<article><h1>2026年第23届信息安全与对抗技术竞赛通知</h1><p>竞赛对象</p><p>全国本科教育、专科教育全日制在校生和研究生。</p></article>', site + 'iscc');
    const fields = discoveryFields(page.page, page.body, [], extractFields(page.body, [], page.page.title));
    expect(fields).toContainEqual(expect.objectContaining({ key: 'eligibility', value: expect.stringContaining('全日制在校生') }));
  });

  it('keeps a complete schedule through commas instead of saving a truncated clause', () => {
    const page = inspectDiscoveryPage(target, '<article><h1>2026年全国大学生数学建模竞赛通知</h1><p>比赛时间：2026年10月24-25日（24日实操，25日答辩）。</p></article>', site + 'schedule');
    const fields = discoveryFields(page.page, page.body, [], extractFields(page.body, [], page.page.title));
    expect(fields).toContainEqual(expect.objectContaining({ key: 'scheduleNote', value: expect.stringContaining('25日答辩') }));
  });

  it('verifies the current year from an edition headline in the article', () => {
    const speech = discoveryTarget('“21世纪杯”全国英语演讲比赛');
    const page = inspectDiscoveryPage(speech, '<article><h1>2026年第31届中国日报社“21世纪杯”全国英语演讲比赛通知</h1><p>1．报名和校园选拔赛/地区初赛：2026年1月 ~ 4月</p><p>（一）参赛对象</p><p>国家承认的具有高等学历教育招生资格的普通高等学校在校本、专科学生均可报名参加。</p></article>', site + 'speech');
    expect(page.page.year).toBe(2026);
    const fields = discoveryFields(page.page, page.body, [], extractFields(page.body, [], page.page.title));
    expect(fields).toContainEqual(expect.objectContaining({ key: 'eligibility', value: expect.stringContaining('在校本、专科学生') }));
    expect(fields).toContainEqual(expect.objectContaining({ key: 'scheduleNote', value: expect.stringContaining('2026年1月') }));
  });
});
