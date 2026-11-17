import type { DiscoveryField, DiscoveryLink, DiscoveryPage } from '@competition/contracts';
import { decodeEntities, extractLinks, findAttachmentLinks, htmlToText, pageTitle } from './html';
import { isForbiddenAddress } from './normalize';
import type { ExtractionResult } from './rule-extractor';
import { detectCandidateDates, FALLBACK_TIMEZONE } from './time';

const NAME_GROUPS = [
  ['“挑战杯”全国大学生课外学术科技作品竞赛', '挑战杯全国大学生课外学术科技作品竞赛', '挑战杯课外学术科技作品竞赛'],
  ['ACM-ICPC国际大学生程序设计竞赛', 'ICPC国际大学生程序设计竞赛', 'ICPC'],
  ['全国大学生结构设计竞赛', '全国大学生结构设计竞赛', '全国大学生结构设计大赛'],
  ['全国大学生智能汽车竞赛', '全国大学生智能汽车竞赛', '全国大学生智能汽车大赛'],
  ['全国大学生电子商务“创新、创意及创业”挑战赛', '全国大学生电子商务“创新、创意及创业”挑战赛', '全国大学生电子商务三创赛', '三创赛'],
  ['中国大学生工程实践与创新能力大赛', '中国大学生工程实践与创新能力大赛', '大学生工程实践与创新能力大赛'],
  ['全国大学生物流设计大赛', '全国大学生物流设计大赛', '全国大学生物流设计竞赛'],
  ['全国大学生机器人大赛-①RoboMaster、②RoboCon', '全国大学生机器人大赛', 'RoboMaster', 'RoboCon'],
  ['百度之星·程序设计大赛', '百度之星程序设计大赛', '百度之星', '百度之星大赛', '百度之星程序设计竞赛'],
  ['中华经典诵写讲大赛', '中华经典诵写讲大赛', '中华经典诵写讲'],
  ['全国大学生数学建模竞赛', '数模国赛', '国赛数模', 'CUMCM', '高教社杯全国大学生数学建模竞赛'],
  ['团体程序设计天梯赛', '中国高校计算机大赛团体程序设计天梯赛', 'GPLT'],
  ['全国大学生电子设计竞赛', '大学生电子设计竞赛', '全国大学生电赛', 'NUEDC'],
  ['蓝桥杯全国软件和信息技术专业人才大赛', '蓝桥杯'],
  ['全国大学生广告艺术大赛', '大广赛'],
  ['百度之星程序设计大赛', '百度之星', '百度之星大赛', '百度之星程序设计竞赛'],
  ['两岸新锐设计竞赛·华灿奖', '新锐设计竞赛·华灿奖'],
  ['“挑战杯”中国大学生创业计划大赛', '“挑战杯”中国大学生创业计划竞赛', '挑战杯中国大学生创业计划竞赛'],
  ['全国大学生艺术展演', '全国大学生艺术展演活动'],
  ['全国大学生计算机系统能力大赛', '全国大学生计算机系统能力培养大赛', '龙芯杯全国大学生计算机系统能力培养大赛'],
  ['全国大学生信息安全与对抗技术竞赛', '全国大学生信息安全与对抗技术竞赛', '信息安全与对抗技术竞赛', 'ISCC'],
  ['外研社全国大学生英语系列赛', '外研社全国大学生英语系列赛', '外研社国才杯全国大学生外语能力大赛', '全国大学生外语能力大赛'],
  ['全国大学生市场调查与分析大赛', '全国大学生市场调查与分析大赛', '正大杯全国大学生市场调查与分析大赛'],
];

const EDITION = /第\s*[一二三四五六七八九十百零\d]+\s*届/g;
const NOTICE = /报名|参赛指南|参赛须知|竞赛通知|大赛通知|比赛通知|第一次通知|关于.{0,100}通知|章程|规程/;
const COMPETITION_CONTENT = /^(?:\s*(?:[一二三四五六七八九十]+[、．.]|\d+[、．.]|[（(][一二三四五六七八九十\d]+[）)])\s*)?(?:(?:竞赛|比赛|赛事|大赛)(?:内容|形式|项目|组别|科目|赛项|赛制)|赛道设置|赛项设置|竞赛赛道|比赛赛道|竞赛题目|比赛题目|参赛选题|展演项目)\s*[:：]?\s*(.*)$/;
const NAVIGATION = /通知|公告|动态|新闻|章程|规程|参赛指南|报名信息|竞赛简介|竞赛组织|关于竞赛|(?:赛事|大赛|竞赛)介绍/;
const OTHER_NOTICE = /公示|获奖|名单|结果|征题|命题|培训|讲座|研讨|赛题|试题|采访|新闻稿|竞赛总结|论文相似|优秀指导教师|优秀组织工作者|格式规范|网址更换/;
const NON_COMPETITION_NOTICE = /(?:研修|培训|研讨|讲座|工作营|师资班|教师班)/;
const VALID_ORGANIZER = /(?:政府|委员会|组委会|教育部|教育厅|协会|学会|联合会|研究会|科学院|工程院|大学|高校|学校|中心|公司|集团|联盟|基金会|研究院|研究所|共青团|统战部|网信办|工信部|知识产权局|农业农村部|发展改革委|工业和信息化部|人力资源社会保障部)$/;
const AUTHORITY_ORGANIZER = /^(?:中央网信办|中国科学院|中国工程院|共青团中央(?:和[^、，,]+)?|国家语委)$/;
const LOCAL = /校内|校赛|院内|院赛|选拔|省赛|赛区|分赛|地区赛|区域赛|组织参加/;
const CAMPUS_TITLE = /(?<!高)校赛|院赛(?!事)|校内(?:赛|预赛|选拔|初赛|报名|竞赛|比赛)|院内(?:选拔|报名)|校园(?:赛(?!事)|选拔)|校级(?:选拔|竞赛|比赛)/;
const SCHOOL_REPOST = /关于(?:组织.{0,12}(?:参加|参赛)|转发)|(?:我校|本校|各学院).{0,30}(?:组织报名参加|组织.{0,12}参加|选拔(?:参赛|队伍)|校内报名)|(?:面向|限于)(?:我校|本校)|(?:我校|本校|校内)(?:报名|选拔)(?:截止|时间|安排|方式)|(?:报名|参赛).{0,16}(?:我校|本校)(?:竞赛|报名|管理)系统/;
const TRACK = /赛道|组别|本科组|研究生组|高职组|专科组|专题赛|专项赛|专题竞赛|普及赛|龙芯杯|(?:CPU|处理器|操作系统|编译系统|数据库系统|智能计算).{0,8}(?:设计|创新|挑战)赛/i;
const OFFICIAL_LINK = /(?:官网|官方网站|竞赛网站|大赛网站|赛事网站)/;
const SECONDARY_SITE = /培训网|培训平台|竞赛通知网|竞赛汇总|竞赛导航|备赛资料|报名管理|信息管理系统|管理系统|报名系统/;
const UNOFFICIAL_SITE = /非官方(?:网站|站点|平台)|个人(?:收集|整理)|本(?:站|网站).{0,15}与.{0,20}(?:无关|无隶属)/;
const ATTACHMENT = /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar)(?:$|[?#])|[?&]urltype=news\.DownloadAttachUrl(?:&|$)/i;
const YEARS = /(?<!\d)(20\d{2})(?!\d)/g;
const DATE_FRAGMENT = /(?:20\d{2}\s*[年./-]\s*)?\d{1,2}\s*[月./-]\s*\d{1,2}\s*[日号](?:\s*(?:[（(](?:周|星期)[一二三四五六日天]\s*[）)]\s*)?\d{1,2}(?:\s*[:：]\s*\d{2}(?:\s*[:：]\s*\d{2})?|\s*[时点](?:\d{1,2}分)?))?/g;
const HISTORICAL_REFERENCE = /往届|历届|上一届|上届|上年度|去年|回顾|相比/;
const PUBLICATION_LINE = /发布时间|发布日期|发文日期|浏览次数|点击次数/;
const ELIGIBILITY = /参赛对象|参赛资格|参赛条件|报名条件|参加人员|参加对象|竞赛对象/;
const SECTION_PREFIX = /^(?:[（(][一二三四五六七八九十\d]+[）)]|[一二三四五六七八九十\d]+[、.])\s*/;

function compact(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function yearsIn(value: string): number[] {
  return [...new Set([...value.matchAll(YEARS)].map((match) => Number(match[1])))];
}

export function currentDiscoveryYear(now = new Date()): number {
  return Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: FALLBACK_TIMEZONE }).format(now));
}

export function discoveryTarget(name: string, year = currentDiscoveryYear()) {
  const bare = name.normalize('NFKC')
    .replace(/[-—–]\s*(?:[\u2460-\u2473]|\d(?=\p{Script=Han})).*$/u, '')
    .replace(/\(\s*20\d{2}\s*年?\s*\)/g, ' ')
    .replace(/(?<!\d)20\d{2}\s*年度?/g, ' ')
    .replace(/(?:^|\s)20\d{2}(?=\s|\p{Script=Han}|$)/gu, ' ')
    .replace(EDITION, ' ')
    .replace(/\s+/g, ' ').trim() || name;
  const group = NAME_GROUPS.find((names) => names.some((alias) => compact(alias) === compact(bare)))
    ?? NAME_GROUPS.find((names) => compact(names[0]) === compact(bare));
  const canonical = group?.[0] ?? bare;
  return { name: canonical, aliases: group ?? [canonical], year };
}

export type DiscoveryTarget = ReturnType<typeof discoveryTarget>;

export function isEducationDiscoveryHost(url: string): boolean {
  return /(?:^|\.)edu(?:\.(?:[a-z]{2}|com))?\.?$/i.test(new URL(url).hostname);
}

export function isCampusDiscoveryNotice(target: DiscoveryTarget, url: string, title: string, body = ''): boolean {
  if (CAMPUS_TITLE.test(target.name)) return false;
  if (CAMPUS_TITLE.test(title)) return true;
  return isEducationDiscoveryHost(url) && (SCHOOL_REPOST.test(`${title}\n${body}`.slice(0, 5500))
    || /(?:大学|学院)(?!生).{0,160}选拔赛/.test(title));
}

function matchesAlias(text: string, alias: string): boolean {
  if (/^[a-z0-9]+$/i.test(alias)) {
    return new RegExp(`(?:^|[^a-z0-9])${alias}(?:$|[^a-z0-9])`, 'i').test(text);
  }
  return compact(text.replace(EDITION, '')).includes(compact(alias));
}

export function identityScore(target: DiscoveryTarget, title: string): number {
  if (!title) return 0;
  for (const alias of target.aliases) {
    if (!matchesAlias(title, alias)) continue;
    if (target.name === '全国大学生结构设计竞赛' &&
      /全国大学生结构设计(?:信息技术|信息化)(?:大赛|竞赛)/.test(title)) continue;
    const normalized = compact(title.replace(EDITION, ''));
    const term = compact(alias);
    const prefix = normalized.slice(0, normalized.indexOf(term));
    if (/(?:[\p{L}\p{N}]{1,12}杯)$/u.test(prefix) && !/高教社杯$/.test(prefix) && !prefix.endsWith('蓝桥杯')) continue;
    if (normalized === term) return 100;
    return alias === target.name ? 90 : 82;
  }
  if (target.name === '全国大学生结构设计竞赛' &&
    /全国大学生结构设计(?:信息技术|信息化)(?:大赛|竞赛)/.test(title)) return 0;
  const expected = compact(target.name);
  if (expected.length < 6) return 0;
  const pairs = new Set(Array.from({ length: expected.length - 1 }, (_, index) => expected.slice(index, index + 2)));
  const normalized = compact(title);
  const overlap = [...pairs].filter((pair) => normalized.includes(pair)).length / pairs.size;
  return overlap >= 0.75 ? Math.round(overlap * 45) : 0;
}

export function discoverySearches(target: DiscoveryTarget): string[] {
  const chinese = target.aliases.filter(alias => /\p{Script=Han}/u.test(alias));
  if (target.name.startsWith('全国高校商业精英挑战赛')) return ['全国高校商业精英挑战赛', '全国高校商业精英挑战赛品牌策划竞赛'];
  if (target.name === '“学创杯”全国大学生创业综合模拟大赛') return ['学创杯全国大学生创业综合模拟大赛'];
  if (target.name === '中国好创意暨全国数字艺术设计大赛') return ['中国好创意大赛', target.name];
  if (target.name === '全国高校BIM毕业设计创新大赛') return ['全国高校BIM毕业设计创新大赛', '全国高校BIM毕业设计大赛'];
  if (target.name === '全国大学生嵌入式芯片与系统设计竞赛') return ['全国大学生嵌入式芯片与系统设计竞赛', '嵌入式芯片与系统设计竞赛'];
  if (target.name === '睿抗机器人开发者大赛（RAICOM）') return ['睿抗机器人开发者大赛', 'RAICOM机器人开发者大赛'];
  if (target.name === '“工行杯”全国大学生金融科技创新大赛') return ['工行杯全国大学生金融科技创新大赛'];
  if (target.name === '“21世纪杯”全国英语演讲比赛') return ['21世纪杯全国英语演讲比赛'];
  if (target.name === '“外教社杯”全国高校学生跨文化能力大赛') return ['外教社杯全国高校学生跨文化能力大赛'];
  if (target.name.startsWith('外研社全国大学生英语系列赛')) {
    return ['外研社国才杯全国大学生外语能力大赛', '外研社全国大学生英语系列赛'];
  }
  if (target.name.startsWith('中国高校计算机大赛')) {
    return ['中国高校计算机大赛', '中国高校计算机大赛团体程序设计天梯赛', '中国高校计算机大赛网络技术挑战赛'];
  }
  return [...new Map(chinese.sort((left, right) => left.length - right.length)
    .map(alias => [compact(alias), alias])).values()].slice(0, 2);
}

export function discoveryUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || (url.port && !(url.protocol === 'http:' && url.port === '8080')) || isForbiddenAddress(url.href)) return null;
    if (!/^#\/[\w/%.-]*(?:\?[^#]*)?$/.test(url.hash)) url.hash = '';
    else if (url.hash.endsWith('?')) url.hash = url.hash.slice(0, -1);
    return url.href;
  } catch {
    return null;
  }
}

function isSiteHome(url: URL): boolean {
  return (!url.hash || url.hash === '#/') && /^(?:\/|\/home\/?|\/index(?:_[a-z]+)?\.html?)$/i.test(url.pathname) &&
    !['p', 'page_id', 'id', 'articleId', 'cat'].some(key => url.searchParams.has(key));
}

export function isDiscoverySiteCandidate(target: DiscoveryTarget, link: DiscoveryLink): boolean {
  if (!link.title || LOCAL.test(link.title) || OTHER_NOTICE.test(link.title) ||
    SECONDARY_SITE.test(link.title) || UNOFFICIAL_SITE.test(link.title)) return false;
  const address = new URL(link.url);
  return identityScore(target, link.title) >= 80 && (OFFICIAL_LINK.test(link.title) ||
    (isSiteHome(address) && !NOTICE.test(link.title)));
}

export function isPublicAuthorityDiscoveryHost(url: string): boolean {
  return /(?:^|\.)gov\.cn\.?$/i.test(new URL(url).hostname);
}

export function parseSearchResults(provider: 'brave' | 'sogou' | 'bing', text: string): DiscoveryLink[] {
  const results = new Map<string, DiscoveryLink>();
  const add = (urlValue: string, titleValue: string) => {
    const url = discoveryUrl(decodeEntities(urlValue.trim()));
    const title = htmlToText(titleValue).replace(/\s+/g, ' ').trim().slice(0, 240);
    if (url && title && !results.has(url)) results.set(url, { url, title });
  };
  if (provider === 'brave') {
    for (const [, attributes, body] of text.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const url = /\bhref\s*=\s*["']([^"']+)/i.exec(attributes)?.[1];
      const title = /<div\b[^>]*class=["'][^"']*\bsearch-snippet-title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(body)?.[1];
      if (url && title) add(url, title);
    }
  } else if (provider === 'bing') {
    for (const [, item] of text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
      const url = /<link>([\s\S]*?)<\/link>/i.exec(item)?.[1];
      const title = /<title>([\s\S]*?)<\/title>/i.exec(item)?.[1];
      if (url && title) add(url, title.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1'));
    }
  } else {
    for (const [, heading, tail] of text.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3\b|$)/gi)) {
      const title = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(heading)?.[1];
      const direct = /<a\b[^>]*\bhref=["'](https?:\/\/[^"']+)/i.exec(heading)?.[1];
      const citation = [...tail.matchAll(/<a\b([^>]*)>/gi)].find((match) => /\bciteLinkClass\b/.test(match[1]));
      const url = direct ?? /\bhref=["']([^"']+)/i.exec(citation?.[1] ?? '')?.[1];
      if (url && title) add(url, title);
    }
  }
  return [...results.values()];
}

export function scoreDiscoveryLink(target: DiscoveryTarget, link: DiscoveryLink): number {
  if (isOtherDiscoveryYear(link.title, target.year)) return 0;
  const score = identityScore(target, link.title);
  const years = yearsIn(link.title);
  const root = isSiteHome(new URL(link.url));
  if (!score) return /^(首页|竞赛通知|大赛通知|官网|通知公告|competition regulations?)$/i.test(link.title) ? 12 : 0;
  return score + (root ? 22 : 0) + (OFFICIAL_LINK.test(link.title) ? 8 : 0) +
    (years.includes(target.year) ? 18 : 0) +
    (NOTICE.test(link.title) ? 9 : 0) - (LOCAL.test(link.title) ? 12 : 0) - (OTHER_NOTICE.test(link.title) ? 30 : 0);
}

export function isOtherDiscoveryYear(title: string, year: number): boolean {
  const years = yearsIn(title.normalize('NFKC'));
  return years.length > 0 && !years.includes(year);
}

export function isDiscoveryNoticeCandidate(target: DiscoveryTarget, link: DiscoveryLink): boolean {
  return identityScore(target, link.title) >= 80 && NOTICE.test(link.title)
    && !OTHER_NOTICE.test(link.title) && !NON_COMPETITION_NOTICE.test(link.title) && !isOtherDiscoveryYear(link.title, target.year);
}

export function discoveryEdition(text: string): string | null {
  return /第\s*[一二三四五六七八九十百零\d]+\s*届/.exec(text.normalize('NFKC'))?.[0].replace(/\s/g, '') ?? null;
}

export function noticeYear(target: DiscoveryTarget, title: string, body: string, parent?: DiscoveryPage, documentTitle = title): number | null {
  const titleYears = yearsIn(title.normalize('NFKC'));
  if (titleYears.length === 1 && !parent) return titleYears[0];

  // Read year evidence from the article, without using a footer, URL or publication timestamp.
  const lines = body.normalize('NFKC').slice(0, 8000).split(/[\n。；]/);
  const currentStatements = lines.filter(line => !HISTORICAL_REFERENCE.test(line) && !/附件下载/.test(line)
    && !/^(?:发布时间?|发布日期|时间|日期|更新时间)\s*[:：]/.test(line));
  const headlineYears = new Set(currentStatements.slice(0, 12).flatMap(line => {
    const match = /^\s*(?:关于(?:举办|组织参加|开展)?\s*)?(20\d{2})\s*年度?/.exec(line);
    return match && identityScore(target, line) >= 80 && !OTHER_NOTICE.test(line) ? [Number(match[1])] : [];
  }));
  if (headlineYears.size === 1) {
    const [year] = headlineYears;
    return titleYears.length === 1 && titleYears[0] !== year ? null : year;
  }
  if (headlineYears.size > 1 || titleYears.length > 1) return null;

  const datesFor = (label: RegExp) => new Set(currentStatements.flatMap(line => {
    const match = label.exec(line);
    return match ? detectCandidateDates(line.slice(match.index + match[0].length))
      .flatMap(date => date.at ? yearsIn(date.rawText ?? '') : []) : [];
  }));
  const eventYears = datesFor(/(?:竞赛|比赛|赛事|决赛|初赛|选拔赛)(?:举办|举行|开赛)?(?:时间|日期|将于|于)|(?:举行|开赛)时间/);
  if (titleYears.length === 1) return eventYears.size && !eventYears.has(titleYears[0]) ? null : titleYears[0];
  if (eventYears.size === 1) return [...eventYears][0];
  if (eventYears.size > 1) return null;

  const registrationYears = datesFor(/(?:报名|注册)(?:阶段|截止(?:时间|日期)?|时间|日期|于|至)/);
  if (registrationYears.size === 1) return [...registrationYears][0];
  if (registrationYears.size > 1) return null;

  const edition = discoveryEdition(title) ?? discoveryEdition(currentStatements.slice(0, 12).find(line =>
    identityScore(target, line) >= 80 && !OTHER_NOTICE.test(line)) ?? '');
  if (!parent && edition && identityScore(target, documentTitle) >= 80) {
    const stageYears = new Set(currentStatements.slice(0, 16).flatMap(line =>
      /^(?:\d+[．.]\s*)?(?:报名|校园选拔赛|地区初赛|地区半决赛|地区决赛|全国半决赛|全国总决赛)/.test(line) ? yearsIn(line) : []));
    if (stageYears.size === 1) return [...stageYears][0];
  }

  const stageYears = currentStatements.filter(line => /(?:校级|省级|全国)(?:展演|汇演)阶段\s*[(（]\s*20\d{2}\s*年/.test(line))
    .flatMap(yearsIn);
  if (stageYears.length) return Math.min(...stageYears);

  const documentYears = yearsIn(documentTitle);
  if (!parent && documentYears.length === 1 && discoveryEdition(title) && identityScore(target, documentTitle) >= 80) return documentYears[0];

  const officialDocumentYears = new Set(currentStatements.flatMap(line => {
    const match = /[〔\[]\s*(20\d{2})\s*[〕\]]\s*\d+\s*号/.exec(line);
    return match ? [Number(match[1])] : [];
  }));
  if (!parent && edition && officialDocumentYears.size === 1 && identityScore(target, documentTitle) >= 80) return [...officialDocumentYears][0];
  if (!parent && edition) {
    const currentEditionYears = new Set(currentStatements.slice(0, 16).flatMap(line => {
      const match = /^\s*(?:20\d{2}\s*年\s*)?(第\s*[一二三四五六七八九十百零\d]+\s*届)/.exec(line);
      return match && discoveryEdition(line) === edition && identityScore(target, line) >= 80 ? yearsIn(line) : [];
    }));
    if (currentEditionYears.size === 1) return [...currentEditionYears][0];
  }
  return parent?.edition && edition === discoveryEdition(parent.edition) ? parent.year : null;
}

function pageContent(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  return body.replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
}

export function discoveryNextPage(html: string, url: string): string | null {
  const address = new URL(url);
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const nextLabel = /^(?:下一?页|next(?:\s+page)?)(?:\s*[>»›→]+)?$/i;
  for (const [, anchor, label, link] of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>|<link\b([^>]*)>/gi)) {
    const attributes = anchor ?? link;
    const relation = /(?:^|\s)rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
    const relations = (relation?.[1] ?? relation?.[2] ?? relation?.[3] ?? '').toLowerCase().split(/\s+/);
    const accessibleLabel = /(?:^|\s)(?:aria-label|title)\s*=\s*["']([^"']+)["']/gi;
    if (!relations.includes('next') && !nextLabel.test(htmlToText(label ?? '')) &&
      ![...attributes.matchAll(accessibleLabel)].some(([, name]) => nextLabel.test(decodeEntities(name).trim()))) continue;
    const href = /(?:^|\s)href\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    if (!href) continue;
    const resolved = URL.parse(decodeEntities(href), address.href);
    if (!resolved || resolved.origin !== address.origin) continue;
    const next = discoveryUrl(resolved.href);
    if (next && next !== url) return next;
  }
  return null;
}

export function inspectDiscoveryPage(target: DiscoveryTarget, html: string, url: string, openedInline = false) {
  const content = pageContent(html);
  const address = new URL(url);
  const rawTitle = pageTitle(html) ?? '';
  const headings = [...content.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .slice(0, 20).map((match) => htmlToText(match[1]).replace(/\s+/g, ' '));
  const text = htmlToText(content);
  const lines = text.split('\n');
  const titleParts = rawTitle.split(/(?:\s*[_|｜]\s*|\s+[—-]\s+|\s*-\s*(?=[^-]{0,45}(?:学院|大学|教务处|网站|中心)$))/u);
  const isNoticeTitle = (line: string) => line && line.length <= 180 && NOTICE.test(line) &&
    !/^(?:(?:上一篇|前一篇|下一篇|相关文章|附件)\s*[:：【]|第[一二三四五六七八九十\d]+条|根据)|[。；]$/.test(line)
    && identityScore(target, line) >= 80;
  const primaryTitle = rawTitle.split(/\s+[-—|｜]\s+|[|｜]/, 1)[0];
  const headline = [...headings, titleParts[0]].find(isNoticeTitle);
  const heading = headline ?? lines.slice(0, 80).find(isNoticeTitle);
  const namedTitle = titleParts.find((part) => identityScore(target, part) >= 80);
  const siteEdition = namedTitle && discoveryEdition(namedTitle);
  const root = !openedInline && isSiteHome(address);
  const overviewTitle = !root && address.hash ? [heading, ...headings, namedTitle].find(line => line &&
    line.length <= 180 && identityScore(target, line) >= 80 && !OTHER_NOTICE.test(line) && yearsIn(line).length === 1) : undefined;
  const links = extractLinks(content, url, { hashRoutes: true }).flatMap((link) => {
    const address = discoveryUrl(link.url);
    return address && link.text ? [{ url: address, title: link.text }] : [];
  });
  const navigationLinks = [...html.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/gi)].flatMap(([, navigation]) =>
    extractLinks(navigation, url, { hashRoutes: true }).flatMap(link => {
      const address = discoveryUrl(link.url);
      return address && link.text && NAVIGATION.test(link.text) ? [{ url: address, title: link.text }] : [];
    }),
  );
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(content)?.[1];
  const matchingNoticeLinks = links.filter((link) => link.url !== url && identityScore(target, link.title) >= 80 && NOTICE.test(link.title));
  const listingHeadings = headings.filter(isNoticeTitle).filter(line =>
    matchingNoticeLinks.some(link => compact(link.title).includes(compact(line))));
  const noticeDirectory = !root && matchingNoticeLinks.length > 0 && (
    /^(?:通知公告|公告通知|竞赛通知|赛事通知|大赛通知|通知列表|新闻动态|新闻中心|大赛新闻|公告列表)$/u.test(primaryTitle.trim()) ||
    (!article && !isNoticeTitle(primaryTitle) && listingHeadings.length > 1)
  );
  const title = noticeDirectory ? rawTitle || headings[0] || '通知列表'
    : root ? namedTitle ?? rawTitle : overviewTitle ?? heading ?? namedTitle ?? rawTitle;
  const articleText = article ? htmlToText(article) : text;
  const bodyLines = articleText.split('\n');
  const headingLine = heading ? bodyLines.findIndex((line) => compact(line).includes(compact(heading)) ||
    (isNoticeTitle(line) && compact(heading).includes(compact(line)))) : -1;
  const bodyStart = root || noticeDirectory || overviewTitle || headingLine < 0 ? 0 : headingLine;
  const bodyEnd = bodyLines.findIndex((line, index) => index > bodyStart && /^(?:上一篇|前一篇|下一篇|相关文章)\s*[:：]/.test(line));
  const body = bodyLines.slice(bodyStart, bodyEnd < 0 ? undefined : bodyEnd).join('\n');
  const nonCompetitionNotice = NON_COMPETITION_NOTICE.test(titleParts[0] ?? rawTitle) &&
    !/(?:学生|参赛).{0,20}(?:报名|作品|竞赛|比赛)/.test(body.slice(0, 1200));
  const attachments = findAttachmentLinks(article ?? content, url).flatMap((link) => {
    const address = discoveryUrl(link.url);
    return address && ATTACHMENT.test(address) && (!link.text || body.includes(link.text))
      ? [{ url: address, title: link.text || new URL(address).pathname.split('/').at(-1)! }] : [];
  }).slice(0, 8);
  const bodyHasDetail = /截止|截至|报名时间|参赛对象|参赛资格|竞赛对象|主办单位|举办时间|竞赛时间|比赛时间|参赛队|(?:由|共同|联合).{2,80}主办/.test(body)
    || body.split('\n').some(line => COMPETITION_CONTENT.test(line));
  const notice = Boolean(!root && !noticeDirectory && (bodyHasDetail || attachments.length) &&
    !nonCompetitionNotice && (overviewTitle || (heading && !OTHER_NOTICE.test(heading) && (article || headline || matchingNoticeLinks.length <= 4))));
  const siteIdentity = !notice && !noticeDirectory && !SECONDARY_SITE.test(rawTitle) && !UNOFFICIAL_SITE.test(text.slice(0, 3000)) &&
    Boolean(namedTitle && (root || OFFICIAL_LINK.test(namedTitle)) &&
      (!siteEdition || noticeYear(target, namedTitle, text) === target.year));
  const affiliated = Boolean(namedTitle && identityScore(target, namedTitle) >= 80 &&
    links.some((link) => identityScore(target, link.title) >= 80));
  const scopeText = `${title}\n${body.slice(0, 1800)}`;
  const regionalSite = siteIdentity && (LOCAL.test(rawTitle) ||
    [...text.slice(0, 1200).matchAll(/(?:电子设计竞赛|数学建模竞赛|天梯赛)(?!联合|全国)[\p{Script=Han}]{2,5}赛区/gu)].length >= 2);
  const scope = siteIdentity || notice ? regionalSite || LOCAL.test(title) ||
    (notice && (/^(?:各学院|各系|各专业同学|各班级)[：:]|(?:我校|本校|各学院|本学院|我院).{0,32}(?:报名|选拔|参赛|竞赛)|(?:报名|参赛).{0,24}(?:我校|本校)/m.test(scopeText)
      || (isEducationDiscoveryHost(url) && /校级竞赛|院内选拔|各年级本科生/.test(scopeText))))
    ? 'regional' : TRACK.test(title) || (siteIdentity && headings.some(line => identityScore(target, line) >= 80 && TRACK.test(line)))
      ? 'track' : 'general' : null;
  const years = yearsIn(title);
  const edition = discoveryEdition(title);
  const page: DiscoveryPage = {
    title, url, kind: notice ? 'notice' : siteIdentity ? 'site' : 'listing', scope,
    year: notice ? noticeYear(target, title, body, undefined, identityScore(target, rawTitle) >= 80 ? rawTitle : title) : years.length === 1 ? years[0] : null,
    edition, excerpt: body.slice(0, 320), fields: [],
    attachments: notice ? attachments : [],
  };
  return {
    page, body, links, siteIdentity, noticeDirectory,
    campusNotice: isCampusDiscoveryNotice(target, url, title, notice ? body : ''),
    nextPage: notice ? null : discoveryNextPage(html, url),
    relevant: Boolean(notice || noticeDirectory || siteIdentity || affiliated || matchingNoticeLinks.length ||
      (identityScore(target, title) >= 80 && identityScore(target, text.slice(0, 6000)) >= 80)),
    officialLinks: notice ? links.filter((link) => !/报名|注册/.test(link.title) &&
      (OFFICIAL_LINK.test(link.title) || body.split('\n').some((line) =>
        OFFICIAL_LINK.test(line) && line.includes(link.title) && /^(?:https?:\/\/|www\.)/i.test(link.title)))) : [],
    followLinks: [...new Map([...navigationLinks, ...links].map(link => [link.url, link])).values()]
      .filter((link) => !ATTACHMENT.test(link.url) && !OTHER_NOTICE.test(link.title) &&
      !isOtherDiscoveryYear(link.title, target.year) &&
      (NAVIGATION.test(link.title) || scoreDiscoveryLink(target, link) >= 80 ||
        (siteIdentity && new URL(link.url).hash && /大赛|竞赛|比赛/.test(link.title)))),
    shell: text.length < 120 && /<script\b[^>]*\bsrc\s*=/i.test(html),
  };
}

export function discoveryFields(
  page: DiscoveryPage, body: string, links: DiscoveryLink[], extraction: ExtractionResult,
): DiscoveryField[] {
  const fields = new Map<string, DiscoveryField>();
  const datedNotice = page.kind === 'notice' || page.kind === 'attachment';
  const pageYear = page.year;
  const add = (key: string, label: string, value: string, quote: string) => {
    if (!fields.has(key)) fields.set(key, { key, label, value, quote });
  };
  const lines = body.split('\n');
  if (datedNotice) {
    const heading = lines.findIndex(line => /^(?:参赛对象|参赛资格|参赛条件|报名条件|参加人员|参加对象|竞赛对象)\s*[:：]?$/.test(line.replace(SECTION_PREFIX, '')));
    const detail = lines[heading + 1]?.trim();
    if (heading >= 0 && detail && !HISTORICAL_REFERENCE.test(detail) && !SECTION_PREFIX.test(detail) && detail.length >= 8) {
      add('eligibility', '参赛对象', detail.slice(0, 360), `${lines[heading]}\n${detail}`.slice(0, 500));
    }
  }
  for (const { key, label, value, evidence, state } of extraction.fields) {
    const quote = evidence?.snippet;
    if (!value || !quote || state !== 'explicit' || !body.includes(quote) || !quote.includes(value) || HISTORICAL_REFERENCE.test(quote)) continue;
    const supported = (key === 'organizer' && /(?:主办单位|主办方|主办机构)\s*[:：]\s*\S{2}|由.{2,120}(?:主办|举办)/.test(quote)) ||
      (datedNotice && key === 'eligibility' && (/^(?:[（(][一二三四五六七八九十\d]+[）)]|[一二三四五六七八九十\d]+[、.])?\s*(?:参赛对象|参赛资格|参赛条件|报名条件|参加人员|参加对象)\s*[:：]/.test(quote) || /面向.{0,45}(?:学生|参赛者|高校|教师)/.test(quote))) ||
      (datedNotice && key === 'fee' && /\d+\s*元|免费|不收|免收/.test(quote));
    if (supported && (key !== 'organizer' || value.trim().split(/[、，,]/).every(part => VALID_ORGANIZER.test(part.trim()) || AUTHORITY_ORGANIZER.test(part.trim())))) {
      add(key, label, value, quote);
    }
  }
  const deadlines = new Map<string, string>();
  const addDeadline = (date: string, quote: string) => {
    const year = yearsIn(date)[0] ?? page.year;
    if (!year || (page.year && Math.abs(year - page.year) > 1)) return;
    const value = (yearsIn(date).length ? date : `${year}年${date}`)
      .replace(/\s*[（(](?:周|星期)[一二三四五六日天]\s*[）)]\s*/, '')
      .replace(/(\d{1,2})[时点](?:(\d{1,2})分)?$/, (_, hour, minute) => `${hour}:${(minute ?? '0').padStart(2, '0')}`);
    deadlines.set(value, quote.slice(0, 500));
  };
  const scopedDeadlines: string[] = [];
  const stageSchedule: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (HISTORICAL_REFERENCE.test(line) || PUBLICATION_LINE.test(line)) continue;
    const next = lines[index + 1]?.trim() ?? '';
    const section = line.replace(SECTION_PREFIX, '');
    if (datedNotice && /^(?:报名|注册)(?:及作品提交|与作品提交)?\s*[:：]?$/.test(section)) {
      const timing = /^(?:(?:赛程|报名|提交)?时间\s*[:：]\s*)?(?:截止(?:时间)?\s*[:：]?|截至|至)\s*(.+)$/.exec(next)?.[1];
      const date = timing?.match(DATE_FRAGMENT)?.at(-1);
      if (date) addDeadline(date, `${line}\n${next}`);
    }
    if (datedNotice && !fields.has('competitionContent')) {
      const content = COMPETITION_CONTENT.exec(line);
      if (content) {
        const value = content[1].trim() || (!/^(?:[一二三四五六七八九十]+、|报名|参赛资格|主办单位|比赛时间|竞赛时间|\d+[、.])/.test(next) ? next : '');
        if (value.length >= 4 && !HISTORICAL_REFERENCE.test(value)) {
          add('competitionContent', '比赛内容', value.slice(0, 360), (content[1].trim() ? line : `${line}\n${next}`).slice(0, 500));
        }
      }
    }
    const organizer = !/第一届|历届|往届|上届/.test(line)
      ? /(?:^主办(?:单位|方|机构)?\s*[:：]\s*(.{2,100})$|由\s*([^，。；]{2,90}?)\s*(?:联合)?主办)/.exec(section) : null;
    const organizerValue = (organizer?.[1] ?? organizer?.[2])?.trim();
    if (organizerValue && VALID_ORGANIZER.test(organizerValue)
      && organizerValue.split(/[、，,]/).every(part => VALID_ORGANIZER.test(part.trim()) || AUTHORITY_ORGANIZER.test(part.trim()))) {
      add('organizer', '主办机构', organizerValue, line.slice(0, 500));
    }
    for (const clause of line.match(/[^。；]+[。；]?/g) ?? []) {
      const start = /(?:竞赛|比赛|赛事|决赛|初赛|选拔赛)(?:举办|举行|开赛)?\s*(?:时间|日期|将于|于)|(?:举行|开赛)时间/.exec(clause);
      const schedule = start ? clause.slice(start.index - (clause.slice(0, start.index).match(/20\d{2}\s*年\s*$/)?.[0].length ?? 0)) : '';
      const scheduleDates = schedule.match(DATE_FRAGMENT) ?? [];
      const scheduleYears = yearsIn(schedule);
      if (datedNotice && schedule && (scheduleDates.length || detectCandidateDates(schedule).some(date => date.at)) &&
        (!pageYear || !scheduleYears.length || scheduleYears.some(year => Math.abs(year - pageYear) <= 1))) {
        add('scheduleNote', '比赛时间', schedule.trim().slice(0, 200), clause.trim().slice(0, 500));
      }
      const cutoff = /(?:报名|注册)(?:的)?(?:截止(?:日期|时间)?|时间|日期|于|至)\s*[:：]?/.exec(clause);
      if (datedNotice && cutoff) {
        const timing = clause.slice(cutoff.index + cutoff[0].length)
          .split(/[，,](?=(?:省赛|国赛|初赛|复赛|决赛|比赛|竞赛|作品|评审|结果|公示|答辩|省级|全国))/)[0];
        const dates = [...timing.matchAll(DATE_FRAGMENT)];
        const isRange = /(?:即日起|[日号])\s*(?:至|到|[-—～~])/.test(timing);
        const date = dates.at(-1)?.[0];
        if (date && (cutoff[0].includes('截止') || /截止|截至|结束/.test(timing) || isRange)) addDeadline(date, clause.trim());
      }
      if (datedNotice && /(?:赛道|定向主题).{0,12}作品征集.{0,4}截止/.test(clause)) {
        scopedDeadlines.push(clause.trim());
      }
      const url = /https?:\/\/[a-z0-9][a-z0-9.-]*(?:\:\d+)?(?:\/[\w./?&=#%:+~-]*)?/i.exec(clause);
      if (url && /(?:报名|注册)(?:入口|系统|平台|网址|链接)|(?:大赛|竞赛|赛事)(?:官网|官方网站)|(?:登录|登陆|通过).{0,50}(?:系统|平台)?(?:网上|在线)?报名|竞赛管理系统.{0,8}报名/.test(clause)
        && !/联络员|电子邮件|联系方式/.test(clause) && discoveryUrl(url[0])) {
        add('signupUrl', '报名入口', url[0], clause.trim().slice(0, 500));
      }
    }
    if (datedNotice && /(?:校级|省级|全国)(?:展演|汇演)阶段\s*[(（]\s*20\d{2}\s*年/.test(section)) {
      stageSchedule.push(line);
    }
    if (datedNotice && /^(?:\d+[．.]\s*)?(?:报名|校园选拔赛|地区初赛|地区半决赛|地区决赛|全国半决赛|全国总决赛)[^：:]{0,40}[:：]\s*20\d{2}\s*年/.test(section)
      && !/(?:起|开始)(?:时间)?[。；，]?\s*$/.test(section)) {
      stageSchedule.push(line);
    }
  }
  const signup = links.find((link) => /^(?:立即报名|(?:网上|在线|赛事|竞赛|大赛)?(?:报名入口|报名系统|报名平台|在线报名|参赛报名|参赛系统|竞赛管理系统))$/.test(link.title));
  if (signup && body.includes(signup.title)) add('signupUrl', '报名入口', signup.url, signup.title);
  if (deadlines.size === 1) {
    for (const [date, quote] of deadlines) add('nearestDeadline', '报名截止时间', date, quote);
  }
  if (scopedDeadlines.length || stageSchedule.length) {
    const dates = [...scopedDeadlines, ...stageSchedule];
    const existing = fields.get('scheduleNote');
    if (existing) dates.push(existing.value);
    const schedule = [...new Set(dates)].join('\n').slice(0, 500);
    const evidence = [...scopedDeadlines, ...stageSchedule, ...(existing ? [existing.quote] : [])].join('\n').slice(0, 500);
    fields.set('scheduleNote', { key: 'scheduleNote', label: '赛程安排', value: schedule, quote: evidence });
  }
  return [...fields.values()];
}
