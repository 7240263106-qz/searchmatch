import type { DiscoveryLink, DiscoveryTrack } from '@competition/contracts';
import { discoveryUrl, isOtherDiscoveryYear } from './competition-discovery';
import { extractLinks, htmlToText } from './html';

export function officialTrackMenu(html: string, home: string): DiscoveryLink[] {
  const cards = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].flatMap(([anchor, body]) => {
    const heading = /<h[2-6]\b[^>]*>([\s\S]*?)<\/h[2-6]>/i.exec(body);
    if (!heading || !/^(?:查看|浏览)(?:赛道|赛项|赛题)(?:规则|详情)?$/.test(htmlToText(body.slice(heading.index + heading[0].length)).trim())) return [];
    const title = htmlToText(heading[1]);
    const link = extractLinks(anchor, home)[0];
    const url = link && discoveryUrl(link.url);
    return title && url && url !== home && new URL(url).origin === new URL(home).origin ? [{ title, url }] : [];
  });
  return [...new Map(cards.map(card => [card.url, card])).values()];
}

export function trackSettingSection(body: string): string {
  return /(?:^|\n)(?:[一二三四五六七八九十]+[、.]\s*)?赛道(?:设置|划分|分类)[^\n]*\n([\s\S]{0,800})/.exec(body)?.[1] ?? '';
}

const compact = (text: string) => text.normalize('NFKC').replace(/\s+/g, '');
const subjectName = (text: string) => compact(text).replace(/^(?:【[^】]+】|〖[^〗]+〗|赛题\d+:)/, '')
  .replace(/[“”「」"·・]/g, '').toLowerCase();

export function trackScheduleDirectories(html: string, home: string): string[] {
  const links = extractLinks(html, home).filter(link => new URL(link.url).origin === new URL(home).origin);
  return [/^(?:国赛|国赛组委会|赛事组委会|大赛组委会)通知$/, /^赛题通知$/]
    .flatMap(label => links.find(link => label.test(link.text))?.url ?? []);
}

export function trackNoticeLinks(html: string, url: string): Array<DiscoveryLink & { publishedYear?: number }> {
  return [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].flatMap(([anchor, body]) => {
    const link = extractLinks(anchor, url)[0];
    if (!link || new URL(link.url).origin !== new URL(url).origin) return [];
    const heading = /<h[2-6]\b[^>]*>([\s\S]*?)<\/h[2-6]>/i.exec(body);
    const title = heading ? htmlToText(heading[1]) : link.text;
    const published = /^(20\d{2})-\d{2}-\d{2}(?:\s|$)/.exec(link.text);
    return /通知|日程|赛程/.test(title) ? [{ title, url: link.url, publishedYear: published ? Number(published[1]) : undefined }] : [];
  });
}

export function trackNamesIn(text: string, subjects: string[], includeGroupName = false): string[] {
  const body = subjectName(text);
  return subjects.filter(subject => {
    const key = subjectName(subject);
    const group = /^(?:.+?大赛(?=·)|[“「][^”」]+[”」])/.exec(subject)?.[0];
    const specific = group && subjectName(subject.slice(group.length));
    return body.includes(key) || Boolean(group && ((specific && body.includes(specific)) ||
      (includeGroupName && body.includes(subjectName(group))))) ||
      (key.endsWith('专项赛') && body.includes(key.slice(0, -3)));
  });
}

const DATE_START = /^(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})(日)?(?:([01]?\d|2[0-3]):([0-5]\d))?/;
const DATE_END = /^[至到~～–—－-](?:(20\d{2})年)?(?:(\d{1,2})月)?(\d{1,2})日(?:([01]?\d|2[0-3]):([0-5]\d))?/;

function readScheduleDate(value: string, year: number) {
  const start = DATE_START.exec(value);
  if (!start) return;
  const [, explicitYear, month, day, daySuffix, hour, minute] = start;
  const end = DATE_END.exec(value.slice(start[0].length));
  if (!daySuffix && !end) return;
  const format = (dateYear: number, dateMonth: string, dateDay: string, h?: string, m?: string) => {
    const date = new Date(Date.UTC(dateYear, Number(dateMonth) - 1, Number(dateDay)));
    if ((dateYear !== year && dateYear !== year + 1) || date.getUTCMonth() + 1 !== Number(dateMonth) ||
      date.getUTCDate() !== Number(dateDay)) return;
    const time = `${dateYear}年${Number(dateMonth)}月${Number(dateDay)}日${h ? `${h.padStart(2, '0')}:${m}` : ''}`;
    return { time, instant: date.getTime() + (Number(h ?? 0) * 60 + Number(m ?? 0)) * 60_000 };
  };
  const startYear = Number(explicitYear ?? year);
  const first = format(startYear, month, day, hour, minute);
  if (!first) return;
  if (!end) return { time: first.time, length: start[0].length };
  const [, endYear, endMonth, endDay, endHour, endMinute] = end;
  const last = format(Number(endYear ?? (Number(month) === 12 && Number(endMonth) === 1 ? startYear + 1 : startYear)),
    endMonth ?? month, endDay, endHour, endMinute);
  if (last && last.instant >= first.instant) return { time: `${first.time} 至 ${last.time}`, length: start[0].length + end[0].length };
}

export function trackScheduleRows(
  tables: Array<Array<Array<string | null>>>, subjects: string[], year: number, source: DiscoveryLink, phase?: string,
): NonNullable<DiscoveryTrack['schedule']> {
  const names = new Map(subjects.map(subject => [subjectName(subject), subject]));
  const schedule: NonNullable<DiscoveryTrack['schedule']> = [];
  for (const [header, ...rows] of tables) {
    const labels = header?.map(value => compact(value ?? '')) ?? [];
    const index = labels.findIndex(label => /^(?:赛题|赛项|科目|项目)(?:名称)?$/.test(label));
    if (index < 0) continue;
    for (const row of rows) {
      const name = subjectName(row[index] ?? '');
      const subject = names.get(name) ?? names.get(name.replace(/赛项$/, ''));
      if (!subject) continue;
      for (const [column, label] of labels.entries()) {
        if (!/(?:时间|日期|截止)$/.test(label) || !/报名|初赛|复赛|决赛|比赛|评[选审]|提交|答辩/.test(label)) continue;
        const cell = compact(row[column] ?? '').replace(/(?:\((?:星期|周)[一二三四五六日天]\))/g, '');
        const date = readScheduleDate(cell, year);
        if (date?.length !== cell.length) continue;
        schedule.push({ subject, label: phase && !label.includes(phase) ? `${phase} · ${label}` : label, time: date.time, source });
      }
    }
  }
  return schedule;
}

const ROUND = /总决赛预选赛|全国半决赛|全国总决赛|半决赛|总决赛|复赛|初赛|区域赛|选拔赛|决赛/;

export function trackNoticeSchedule(html: string, track: DiscoveryTrack, year: number, source: DiscoveryLink): NonNullable<DiscoveryTrack['schedule']> {
  const subjects = track.subjects ?? [];
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ??
    html.split(/<div\b[^>]*class=["'][^"']*\barticle-content\b[^"']*["'][^>]*>/i)[1];
  if (!article) return [];
  const tables = [...article.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(([, table]) =>
    [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(([, row]) =>
      [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, cell]) => htmlToText(cell))));
  const headingPhase = ROUND.exec(source.title.slice(source.title.lastIndexOf('及') + 1))?.[0];
  const rows = trackScheduleRows(tables, subjects, year, source, headingPhase);
  const body = htmlToText(article.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, ''));
  const intro = body.split(/\n[一二三四五六七八九十]+[、.]/, 1)[0].slice(0, 1200);
  // A headline may abbreviate a multi-topic notice. Use the enumerated scope before the schedule.
  const lines = body.split('\n');
  const topicHeadings = lines.filter(line => /^赛题[一二三四五六七八九十\d]+[:：]/.test(line)).join('\n');
  const roster = tables.flatMap(table => {
    const index = table[0]?.findIndex(label => /^(?:赛题|赛项)(?:名称)?$/.test(compact(label))) ?? -1;
    return index < 0 ? [] : table.slice(1).map(row => row[index] ?? '');
  });
  const titledGroup = trackNamesIn(source.title, subjects, true);
  const named = new Set([...trackNamesIn(`${source.title}\n${intro}\n${topicHeadings}`, subjects),
    ...roster.flatMap(name => name ? trackNamesIn(name, titledGroup) : [])]);
  const shared = source.title.includes(track.title) && body.split(/\n[二三四五六七八九十]+[、.]/, 1)[0]
    .split('\n').some(line => /所有[^。；，\n]{0,55}(?:参赛队伍|参赛团队|参赛选手)/.test(line) && line.includes(track.title));
  const scoped = named.size ? [...named] : shared ? subjects : [];
  if (!scoped.length) return rows;
  const initialOnly = new Set(scoped.filter(subject => lines.some((line, index) =>
    trackNamesIn(line, [subject]).length && /仅设初赛/.test(lines[index + 1] ?? ''))));
  const subgroup = /(?:通知|安排)\s*[（(]([^()（）]{2,45})[）)]$/.exec(source.title)?.[1];
  let phase = headingPhase;
  let region: string | undefined;
  for (const line of lines) {
    if (/^(?:参赛须知|[一二三四五六七八九十]+[、.](?:参赛须知|联系方式|奖项设置|报名方式|材料提交要求))/.test(line)) break;
    if (/^[一二三四五六七八九十]+[、.]/.test(line)) {
      const section = ROUND.exec(line)?.[0];
      phase = headingPhase && (!section || headingPhase.endsWith(section)) ? headingPhase : section;
      region = undefined;
    }
    if (/^[（(][一二三四五六七八九十]+[）)]/.test(line) && line.length < 45) {
      if (/未单独设立.*地区/.test(line)) region = '统一线上';
      else if (/独立.*(?:省份|区域)/.test(line)) region = undefined;
      else phase = ROUND.exec(line)?.[0] ?? phase;
    }
    const area = /^\d+[.、]\s*(.{2,45}(?:选拔赛|区域赛)[）)]?)$/.exec(line);
    if (area) region = /[（(]([^）)]+)[）)]$/.exec(area[1])?.[1] ?? area[1].replace(/\s+/g, '');
    for (const sentence of line.normalize('NFKC').split(/[。；;]/)) {
      if (/拟定|暂定|待定|预计|拟于|待公布|另行确定|公示期|异议/.test(sentence)) continue;
      const clause = compact(sentence);
      const match = /(报名(?:与缴费|及缴费|及作品提交)?(?:截止(?:时间|日期)?|(?:将)?于)|(?:材料|作品|视频|答辩视频|文档|代码)?(?:提交截止|截止提交)(?:时间|日期)?|(?:比赛|竞赛|评审|评选|答辩)时间|时间地点|(?:初赛|复赛|总决赛|半决赛|答辩)(?:将)?(?:于|定于)|时间为(?=\d))[:为截至]*/.exec(clause);
      if (!match) continue;
      const rest = clause.slice(match.index + match[0].length);
      const checkIn = /^.{0,30}日报到[,，](?=\d)/.exec(rest);
      const dateText = checkIn && region ? rest.slice(checkIn[0].length) : rest;
      const date = readScheduleDate(dateText, year);
      if (!date) continue;
      const tail = dateText.slice(date.length);
      if (/^[\d:]/.test(tail)) continue;
      const [, action] = match;
      if (action.startsWith('报名') && action.endsWith('于') && !tail.startsWith('截止')) continue;
      const prefix = clause.slice(0, match.index);
      if (action === '时间为' && !/答辩|路演|比赛|评审/.test(prefix)) continue;
      const parsedPhase = ROUND.exec(`${prefix}${action}`)?.[0];
      const currentPhase = phase && (!parsedPhase || phase.endsWith(parsedPhase)) ? phase : parsedPhase;
      const submission = /^(?:文档|代码)/.exec(action)?.[0] ?? '材料';
      const type = action.startsWith('报名') ? (action.includes('作品提交') ? '报名及交稿截止' : '报名截止') :
        /提交/.test(action) ? `${submission}提交截止` : /评[审选]/.test(action) ? '评审时间' : '比赛时间';
      if (type === '比赛时间' && /^报到/.test(tail)) continue;
      if (type === '比赛时间' && tables.length && scoped.length > 1 && /详见表/.test(line)) continue;
      const label = [!type.startsWith('报名') && currentPhase, subgroup, region, type].filter(Boolean).join(' · ');
      const specific = trackNamesIn(prefix, scoped);
      for (const subject of specific.length ? specific : scoped) {
        if (currentPhase && currentPhase !== '初赛' && initialOnly.has(subject)) continue;
        if (!rows.some(row => row.subject === subject && row.label === label)) rows.push({ subject, label, time: date.time, source });
      }
    }
  }
  return rows;
}

export function directorySubjects(html: string, track: DiscoveryLink, year: number): string[] {
  const directory = new URL(track.url);
  const path = directory.pathname.replace(/\/$/, '');
  const prefix = path.slice(0, path.lastIndexOf('/') + 1);
  const subjects = new Set<string>();
  for (const [anchor, body] of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const heading = /<h[2-6]\b[^>]*>([\s\S]*?)<\/h[2-6]>/i.exec(body);
    const category = /<label\b[^>]*>([\s\S]*?)<\/label>/i.exec(body);
    if (!heading || !category || !htmlToText(category[1]).startsWith(track.title)) continue;
    const href = extractLinks(anchor, track.url)[0]?.url;
    const address = href && new URL(href);
    if (!address || address.origin !== directory.origin || !address.pathname.startsWith(prefix)) continue;
    const title = htmlToText(heading[1]).normalize('NFKC');
    if (!title || isOtherDiscoveryYear(title, year) || /赛题一览|赛题汇总/.test(title)) continue;
    const normalized = title.replace(/^20\d{2}\s*[A-Z]{2,10}\s*[·・:：]\s*/i, '')
      .replace(/(?:赛题及竞赛规则|赛题与竞赛规则)$/, '')
      .replace(/\s*\((?:(?:报名)?已截止(?:报名)?|报名中)\)$/, '').trim();
    const quotedTopic = /^[“「"](.+?)[”」"]\s*/.exec(normalized);
    const topic = quotedTopic && normalized.slice(quotedTopic[0].length) === track.title ? quotedTopic[1] : normalized;
    if (topic && topic !== track.title) subjects.add(topic);
  }
  return [...subjects];
}
