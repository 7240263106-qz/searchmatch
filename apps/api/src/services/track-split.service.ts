import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../platform/prisma.module';

export interface TrackCandidate {
  name: string;
  kind: 'track' | 'group';
  evidence: string;
}

export interface HierarchyResult {
  seriesId: string;
  editionId: string;
  tracks: Array<{ trackId: string; name: string; kind: 'track' | 'group' }>;
}

const TRACK_KEYWORDS: Array<{ name: string; pattern: RegExp }> = [
  { name: '软件类', pattern: /软件类|软件赛|软件开发|程序设计|编程|算法|Java|C\/C\+\+|Python|Web 应用|软件测试/i },
  { name: '电子类', pattern: /电子类|电子赛|单片机|嵌入式|物联网|EDA|电子设计|电路/i },
  { name: '人工智能', pattern: /人工智能|机器学习|深度学习|AI 赛道|智能算法/ },
  { name: '大数据', pattern: /大数据|数据分析|数据挖掘/ },
  { name: '网络安全', pattern: /网络安全|信息安全|CTF|攻防/ },
  { name: '数字媒体', pattern: /数字媒体|视觉设计|动画|视频/ },
];

const GROUP_KEYWORDS: Array<{ name: string; pattern: RegExp }> = [
  { name: '研究生组', pattern: /研究生组/ },
  { name: '本科组', pattern: /本科组|大学组/ },
  { name: '高职高专组', pattern: /高职高专组|高职组|专科组/ },
  { name: '职业院校组', pattern: /职业院校组|中职组/ },
  { name: '公开组', pattern: /公开组|社会组/ },
];

const EDITION_PATTERN = /第\s*([一二三四五六七八九十百零\d]+)\s*届/;
const YEAR_PATTERN = /(20\d{2})\s*年/;

const CN_NUMBERS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18,
  十九: 19, 二十: 20,
};

export function detectTracks(text: string): TrackCandidate[] {
  const candidates: TrackCandidate[] = [];
  const seen = new Set<string>();

  for (const item of TRACK_KEYWORDS) {
    const match = item.pattern.exec(text);
    if (match && !seen.has(item.name)) {
      seen.add(item.name);
      candidates.push({ name: item.name, kind: 'track', evidence: match[0] });
    }
  }
  for (const item of GROUP_KEYWORDS) {
    const match = item.pattern.exec(text);
    if (match && !seen.has(item.name)) {
      seen.add(item.name);
      candidates.push({ name: item.name, kind: 'group', evidence: match[0] });
    }
  }
  return candidates;
}

export function inferSeriesName(competitionName: string, text: string): string {
  const source = `${competitionName} ${text.slice(0, 800)}`;
  if (/蓝桥杯/.test(source)) return '蓝桥杯全国软件和信息技术专业人才大赛';
  if (/数学建模/.test(source)) return '全国大学生数学建模竞赛';
  if (/电子设计/.test(source)) return '全国大学生电子设计竞赛';
  if (/ICPC|国际大学生程序设计/i.test(source)) return '国际大学生程序设计竞赛';
  return competitionName.replace(/[·\-—（(].*$/, '').trim() || competitionName;
}

export function inferEdition(text: string): { ordinal: number; year: number; name: string } {
  const editionMatch = EDITION_PATTERN.exec(text);
  const yearMatch = YEAR_PATTERN.exec(text);
  const year = yearMatch?.[1] ? Number(yearMatch[1]) : new Date().getFullYear();
  let ordinal = 0;
  if (editionMatch?.[1]) {
    const raw = editionMatch[1];
    ordinal = /^\d+$/.test(raw) ? Number(raw) : CN_NUMBERS[raw] ?? 0;
  }
  if (ordinal === 0) ordinal = Math.max(1, year - 2007);
  return { ordinal, year, name: ordinal > 0 ? `第${ordinal}届（${year}）` : `${year}年` };
}

export function fourElementKey(seriesId: string, editionId: string, trackId: string, groupKey = '__none__'): string {
  return createHash('sha256').update(`${seriesId}|${editionId}|${trackId}|${groupKey}`).digest('hex');
}

@Injectable()
export class TrackSplitService {
  constructor(private readonly prisma: PrismaService) {}

  async ensureHierarchy(input: {
    seriesName: string;
    editionText: string;
    tracks: TrackCandidate[];
  }): Promise<HierarchyResult> {
    const normalizedSeries = input.seriesName.replace(/\s+/g, '');
    const series = await this.prisma.competitionSeries.upsert({
      where: { normalizedName: normalizedSeries },
      create: { name: input.seriesName, normalizedName: normalizedSeries },
      update: {},
    });

    const edition = inferEdition(input.editionText);
    const editionRow = await this.prisma.competitionEdition.upsert({
      where: {
        seriesId_ordinal_year: {
          seriesId: series.id,
          ordinal: edition.ordinal,
          year: edition.year,
        },
      },
      create: {
        seriesId: series.id,
        ordinal: edition.ordinal,
        year: edition.year,
        name: edition.name,
      },
      update: {},
    });

    const contentTracks = input.tracks.filter((item) => item.kind === 'track');
    const tracks: Array<{ trackId: string; name: string; kind: 'track' | 'group' }> = [];

    for (const candidate of contentTracks) {
      const track = await this.prisma.competitionTrack.upsert({
        where: {
          editionId_normalizedName: {
            editionId: editionRow.id,
            normalizedName: candidate.name,
          },
        },
        create: {
          editionId: editionRow.id,
          name: candidate.name,
          normalizedName: candidate.name,
        },
        update: {},
      });
      tracks.push({ trackId: track.id, name: track.name, kind: 'track' });
    }

    if (tracks.length === 0) {
      const placeholder = await this.prisma.competitionTrack.upsert({
        where: {
          editionId_normalizedName: {
            editionId: editionRow.id,
            normalizedName: '未分赛道',
          },
        },
        create: {
          editionId: editionRow.id,
          name: '未分赛道',
          normalizedName: '未分赛道',
        },
        update: {},
      });
      tracks.push({ trackId: placeholder.id, name: '未分赛道', kind: 'track' });
    }

    return { seriesId: series.id, editionId: editionRow.id, tracks };
  }

  detect(text: string): TrackCandidate[] {
    return detectTracks(text);
  }
}