import type { DiscoveryLink, DiscoveryTrack } from '@competition/contracts';
import { discoveryEdition, discoveryUrl } from './competition-discovery';
import { extractLinks, htmlToText } from './html';

const SITE = 'https://dasai.lanqiao.cn';
const NEWS = 'https://www.guoxinlanqiao.com';
const PROGRAM = 20;
const PAGE_SIZE = 10;
export const LANQIAO_HOME = SITE + '/';
export const LANQIAO_NOTICE_LIST = `${SITE}/notices/?progid=${PROGRAM}`;

function isOfficialAsset(url: string): boolean {
  const address = new URL(url);
  return address.protocol === 'https:' && /(?:^|\.)lanqiao\.cn$/.test(address.hostname);
}

export function lanqiaoTrackLinks(html: string, home: string): DiscoveryTrack[] {
  const tracks = new Map<string, DiscoveryTrack>();
  for (const [, card] of html.matchAll(/<div\b[^>]*\bclass=["'][^"']*\brace-item\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)) {
    const heading = /<span\b[^>]*\bclass=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(card)?.[1];
    const lines = (heading ?? '').split(/<br\b[^>]*>/i).map(htmlToText).filter(Boolean);
    const title = lines.join(lines.length > 1 && lines.every(line => line.endsWith('赛')) ? '／' : '');
    const link = extractLinks(card, home).find(item => item.text === '我要报名');
    const url = link && discoveryUrl(link.url);
    if (title && url && isOfficialAsset(url)) {
      tracks.set(url, { title, url });
    }
  }
  return [...tracks.values()];
}

export function lanqiaoNoticeFeed(page: number): string {
  return `${NEWS}/api/news/find?status=1&project=dasai&progid=${PROGRAM}&pageno=${page}&pagesize=${PAGE_SIZE}`;
}

export function lanqiaoPage(address: string): 'home' | 'listing' | number | null {
  const url = new URL(address);
  if (url.origin !== SITE) return null;
  if (url.pathname === '/') return 'home';
  if (url.pathname.replace(/\/$/, '') === '/notices' && url.searchParams.get('progid') === String(PROGRAM)) return 'listing';
  const id = /^\/notices\/([1-9]\d{0,8})\/?$/.exec(url.pathname)?.[1];
  return id ? Number(id) : null;
}

export function lanqiaoDetailFeed(id: number): string {
  return `${NEWS}/api/web/news/selectone?nnid=${id}`;
}

interface NoticeRecord {
  nnid?: number;
  appid?: string;
  programaId?: number;
  nstatus?: number;
  title?: string;
  publishTime?: string;
  content?: string;
}

function isPublicNotice(row: NoticeRecord | null): row is NoticeRecord & { nnid: number; title: string } {
  return Boolean(row && Number.isSafeInteger(row.nnid) && row.nnid! > 0 && row.nnid! < 1_000_000_000
    && row.appid === 'dasai' && row.programaId === PROGRAM && row.nstatus === 1
    && typeof row.title === 'string' && row.title.trim());
}

export function lanqiaoNoticePage(payload: unknown, year: number, page: number) {
  const data = payload as { succ?: boolean; datalist?: NoticeRecord[]; total?: number } | null;
  if (data?.succ !== true || !Array.isArray(data.datalist)) throw new Error('notice_feed_invalid');
  const records = data.datalist.slice(0, PAGE_SIZE).filter(isPublicNotice);
  const links: DiscoveryLink[] = records.flatMap(row =>
    typeof row.publishTime === 'string' && row.publishTime.startsWith(`${year}-`)
      ? [{ url: `${SITE}/notices/${row.nnid}`, title: row.title.trim().slice(0, 180) }] : []);
  return {
    links,
    ids: records.map(row => row.nnid),
    count: data.datalist.length,
    hasMore: data.datalist.length >= PAGE_SIZE && (typeof data.total !== 'number' || page * PAGE_SIZE < data.total),
    older: records.length === data.datalist.length && records.length > 0 && records.every(row => {
      const date = typeof row.publishTime === 'string' && /^20\d{2}(?=-)/.exec(row.publishTime);
      return Boolean(date && Number(date[0]) < year);
    }),
  };
}

export function lanqiaoNoticeHtml(payload: unknown, id: number): string {
  const data = payload as { succ?: boolean; news?: NoticeRecord } | null;
  const row = data?.news ?? null;
  if (data?.succ !== true || !isPublicNotice(row) || row.nnid !== id || typeof row.content !== 'string') {
    throw new Error('notice_feed_invalid');
  }
  const title = row.title.trim().slice(0, 180)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<title>${title}</title><body><article><h1>${title}</h1>${row.content}</article></body>`;
}

export function lanqiaoTrackNotices(payload: unknown, year: number) {
  const { links } = lanqiaoNoticePage(payload, year, 1);
  const announcement = links.find(link => /关于举办.*蓝桥杯全国.*软件和信息技术.*大赛.*通知/.test(link.title)
    && discoveryEdition(link.title));
  const edition = announcement && discoveryEdition(announcement.title);
  const schedule = edition ? links.find(link => discoveryEdition(link.title) === edition
    && /蓝桥杯.*省赛比赛时间.*通知/.test(link.title)) : undefined;
  return { announcement, edition, schedule };
}

export function lanqiaoTrackGuide(html: string, announcement: DiscoveryLink, edition: string): DiscoveryLink | undefined {
  const link = extractLinks(html, announcement.url).find(item =>
    isOfficialAsset(item.url) && /费用说明/.test(item.text) && /\.pdf(?:[?#]|$)/i.test(item.url)
    && (discoveryEdition(item.text) ?? edition) === edition);
  return link && { title: link.text, url: link.url };
}

const compact = (text: string) => text.normalize('NFKC').replace(/\s+/g, '');

export function lanqiaoTrackDetails(
  tracks: DiscoveryTrack[], edition: string, year: number,
  guide?: { source: DiscoveryLink; text: string }, schedule?: { source: DiscoveryLink; html: string },
): DiscoveryTrack[] {
  const categories = new Map<string, string[]>();
  const windows: Array<NonNullable<DiscoveryTrack['registration']>[number] & { category: string }> = [];
  if (guide && discoveryEdition(guide.text.slice(0, 500)) === edition) {
    const text = guide.text.normalize('NFKC');
    const feeSection = /一、收费标准([\s\S]*?)二、报名时间说明/.exec(text)?.[1] ?? '';
    let subjects: string[] = [];
    for (const line of feeSection.split('\n').map(line => line.trim())) {
      const category = /^\d+\.\s*(.+)/.exec(line)?.[1];
      const subject = /^\(\d+\)\s*(.+?)(?:\s*\d+\s*元.*)?$/.exec(line)?.[1];
      if (category) {
        subjects = [];
        categories.set(compact(category).split('(')[0], subjects);
      } else if (subject) {
        subjects.push(subject.trim());
      }
    }

    const registrationSection = /二、报名时间说明([\s\S]*?)(?:三、|$)/.exec(text)?.[1] ?? '';
    const date = '20\\d{2}年\\d{1,2}月\\d{1,2}日\\d{1,2}:\\d{2}';
    const windowPattern = new RegExp(`^(.*?)(报名(?:及提交作品)?时间):(${date})[—–~至-](${date})`);
    for (const clause of registrationSection.split(/^\s*(?:\d+\.|\(\d+\))\s*/m)) {
      const match = windowPattern.exec(compact(clause));
      if (!match) continue;
      const [, appliesTo, label, start, end] = match;
      const endYear = Number(end.slice(0, 4));
      if (!start.startsWith(`${year}年`) || endYear < year || endYear > year + 1) continue;
      const includesSubmission = label.includes('提交作品');
      const specialSubjects = categories.get('专项赛') ?? [];
      for (const category of categories.keys()) {
        // The announcement sometimes omits the final “赛” in the list of groups.
        if (category !== '专项赛' && appliesTo.includes(category === '人工智能赛' ? '人工智能' : category)) {
          windows.push({ category, start, end, includesSubmission });
        }
      }
      for (const subject of specialSubjects) {
        const name = compact(subject).replace(/^蓝桥杯大赛/, '');
        if (appliesTo.includes(name)) windows.push({ category: '专项赛', subject, start, end, includesSubmission });
      }
    }
  }

  const timetable = new Map<string, NonNullable<DiscoveryTrack['schedule']>>();
  for (const [, table] of (schedule?.html ?? '').matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const [header, ...rows] = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(([, row]) =>
      [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, cell]) => htmlToText(cell).replace(/\s+/g, ' ')));
    if (!header || !header.some(cell => /省赛.*时间/.test(compact(cell)))) continue;
    let category = '';
    for (const cells of rows) {
      if (cells.length === 3) category = compact(cells[0]).split('(')[0];
      if (!category || (cells.length !== 2 && cells.length !== 3)) continue;
      const [subject, time] = cells.slice(-2);
      if (!subject || !new RegExp(`(?:${year}|${year + 1})年\\d{1,2}月\\d{1,2}日`).test(compact(time))) continue;
      const entries = timetable.get(category) ?? [];
      entries.push({ subject, time });
      timetable.set(category, entries);
    }
  }

  return tracks.map(track => {
    const names = compact(track.title).split('/');
    const subjects = [...new Set(names.flatMap(name => categories.get(name) ?? []))];
    const applicableWindows = windows.filter(window => names.includes(window.category))
      .map(({ subject, start, end, includesSubmission }) => ({ subject, start, end, includesSubmission }));
    const registration = [...new Map(applicableWindows.map(window => [
      JSON.stringify(window), window,
    ])).values()];
    const rounds = names.flatMap(name => timetable.get(name) ?? []);
    return {
      ...track, edition,
      subjects: subjects.length ? subjects : undefined,
      registration: registration.length ? registration : undefined,
      schedule: rounds.length ? rounds : undefined,
      guide: subjects.length || registration.length ? guide?.source : undefined,
      scheduleNotice: rounds.length ? schedule?.source : undefined,
    };
  });
}
