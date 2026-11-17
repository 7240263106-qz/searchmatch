const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'artifacts', 'catalog-completion-20261116');
const statePath = path.join(outputDir, 'state.json');
const api = process.env.CATALOG_API_URL ?? 'http://127.0.0.1:3000/api/v1';
const actorHeaders = {
  'content-type': 'application/json',
  'x-actor-id': 'u-demo',
  'x-actor-roles': 'editor,reviewer,admin',
};
const { PrismaClient } = require(path.join(root, 'apps', 'api', 'node_modules', '@prisma', 'client'));
const databaseUrl = 'file:' + path.join(root, 'apps', 'api', 'prisma', 'dev.db').replace(/\\/g, '/');
const concurrency = Math.max(1, Math.min(3, Number(process.env.CATALOG_CONCURRENCY) || 2));

fs.mkdirSync(outputDir, { recursive: true });

async function request(route, options = {}) {
  const response = await fetch(api + route, {
    ...options,
    headers: { ...actorHeaders, ...options.headers },
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(`${options.method ?? 'GET'} ${route}: ${body.error?.code ?? response.status} ${body.error?.message ?? ''}`);
  }
  return body.data ?? body;
}

const CAMPUS_SOURCE = /(?:各学院|全校|我校|本校|我院|校内|本院|学校).{0,100}(?:报名|选拔|参赛)|(?:报名|选拔|参赛).{0,100}(?:各学院|全校|我校|本校|我院|校内|本院|学校)/;
const LOCAL_UNIT = /^(?!.*(?:政府|委员会|组委会|教育部|教育厅|协会|学会|联合会|研究会|科学院|工程院|大学|高校|中心|公司|集团|联盟|基金会|研究院|研究所|共青团|统战部|网信办|工信部|知识产权局|农业农村部)$).+$/;
const TRAINING_NOTICE = /研修|培训|研讨|讲座|工作营|师资班|教师班/;
const ELIGIBILITY_HEADING = /^(?:[（(][一二三四五六七八九十\d]+[）)]|[一二三四五六七八九十\d]+[、.])?\s*(?:参赛对象|参赛资格|参赛条件|报名条件|参加人员|参加对象)\s*[:：]/;
const INTRODUCTORY_FIELD = /重要.{0,12}赛事|现将|列入|排行榜|已成功|历史|创办|研发|举办十[一二三四五六七八九十\d]+届|是一项|是面向|^(?:[^。]{0,80})发起以来/;
const BAD_CONTENT = /^第\d+\s*页$|\.{3,}|…{2,}|^(?:[（(][一二三四五六七八九十\d]+[）)]|[一二三四五六七八九十\d]+[、.)）])\s*[^：:。；]{1,30}$|[:：]$|将于竞赛开始时|作品.{0,8}(?:纸张|用纸|规格|尺寸)|纸张规格|用纸规格|中性笔|钢笔|秀丽笔|及相关要求|及要求参见|参见附件|有哪些类型[？?]难度如何[？?]|^(?:有哪些|有什么|如何|是否|为什么|什么是|怎么)[^。；]{0,60}[？?]$|自\s*(?:18|19|20)\d{2}\s*年发起以来/;
const CAMPUS_CONTENT = /^(?:我校|本校|我院|本校学院)|^分类及主题$/;
const BAD_ELIGIBILITY = /实际成$|报名已经截止|参赛对象及|参赛条件$|参赛资格与队伍成绩|，每个参赛$|、留$|境内$|，其中\s*[:：]?$|留学$/;
const BAD_SCHEDULE = /，$|[:：]$|[（(][^）)]*$/;
const COMPOSITE_CATALOG = /[-—–]\s*[①②③④⑤⑥⑦⑧⑨⑩]|RoboMaster|RoboCon/;

function canSave(field, page) {
  if (TRAINING_NOTICE.test(page.title)) return false;
  if (page.scope === 'regional') {
    if (field.key === 'nearestDeadline' || field.key === 'signupUrl') return false;
    if (field.key === 'organizer' && /(?:中心|教务处|学院|学部)$/.test(field.value.trim())) return false;
    if (CAMPUS_SOURCE.test(field.quote)) return false;
  }
  if (field.key === 'organizer' && (LOCAL_UNIT.test(field.value.trim()) || field.value.length > 120 || /第一届|历届|往届|上届/.test(field.value)
    || /(?:18|19|20)\d{2}年.{0,30}(?:创办|发起|研发|开始)/.test(field.quote)
    || /(?:教务|学院|学部|创新创业学院|网络信息管理)/.test(field.value))) return false;
  if (field.key === 'eligibility' && ((!ELIGIBILITY_HEADING.test(field.value) && !ELIGIBILITY_HEADING.test(field.quote)) || INTRODUCTORY_FIELD.test(field.value)
    || BAD_ELIGIBILITY.test(field.value.trim()))) return false;
  if (field.key === 'competitionContent' && (BAD_CONTENT.test(field.value.trim()) || CAMPUS_CONTENT.test(field.value.trim()))) return false;
  if (field.key === 'scheduleNote' && BAD_SCHEDULE.test(field.value.trim())) return false;
  return ['organizer', 'eligibility', 'competitionContent', 'scheduleNote', 'signupUrl'].includes(field.key)
    || (field.key === 'nearestDeadline' && /(?:^|[^\d])20\d{2}\s*[年./-]/.test(field.value));
}

function priority(page) {
  const host = new URL(page.url).hostname;
  const authority = /(?:^|\.)gov\.cn$/i.test(host) || /(?:^|\.)moe\.gov\.cn$/i.test(host);
  const general = page.scope === 'general' && page.kind === 'notice';
  return (authority && general ? 80 : page.scope === 'general' && page.kind === 'attachment' ? 65 : general ? 45 : page.scope === 'track' ? 20 : page.kind === 'site' ? 30 : 10)
    + (page.kind === 'notice' ? 2 : page.kind === 'attachment' ? 1 : 0);
}

function missingValue(value) {
  return value === null || value === undefined || value === ''
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

function normalized(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, '').trim();
}

async function enrich(competition) {
  const file = path.join(outputDir, `${competition.id}.json`);
  if (fs.existsSync(file)) {
    const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (previous.status === 'completed' && process.env.CATALOG_RETRY !== '1') return previous;
  }
  const startedAt = new Date().toISOString();
  const report = {
    id: competition.id,
    catalogIndex: competition.catalogIndex,
    name: competition.name,
    schoolRecognitionLevel: competition.schoolRecognitionLevel,
    startedAt,
    status: 'running',
    savedPages: [],
    officialSites: [],
    warnings: [],
  };
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  try {
    const result = await request(`/competitions/${competition.id}/discover`, { method: 'POST', body: '{}' });
    report.runId = result.runId;
    report.result = result;
    for (const search of result.searches.filter(search => search.error)) {
      report.warnings.push({ stage: 'search', message: `${search.provider} 搜索未完成`, reason: search.error });
    }
    for (const issue of result.issues) report.warnings.push({ stage: 'page', ...issue });
    const logLines = fs.readFileSync(path.join(root, 'artifacts', 'runtime', 'agent-logs', 'agent-2026-11-16.jsonl'), 'utf8')
      .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(log => log.runId === result.runId);
    const previousWarnings = report.warnings;
    report.warnings = logLines.filter(log => ['warning', 'error'].includes(log.level)).map(log => ({
      at: log.at,
      stage: log.stage,
      message: log.message,
      reason: log.reason,
      url: log.url,
    }));
    for (const warning of previousWarnings) {
      if (!report.warnings.some(item => item.stage === warning.stage && item.reason === warning.reason && item.url === warning.url)) {
        report.warnings.push(warning);
      }
    }
    const composite = COMPOSITE_CATALOG.test(competition.name) || /[-—–]\s*①/.test(competition.name);
    const pages = [...result.pages].sort((left, right) => priority(left) - priority(right));
    for (const page of pages) {
      if (page.kind === 'listing') continue;
      const keys = page.fields.filter(field => canSave(field, page)).map(field => field.key);
      if (page.kind === 'site' && page.tracks?.length) keys.push('discoveryTracks');
      if (!keys.length) continue;
      try {
        await request(`/competitions/${competition.id}/discovery-fields`, {
          method: 'POST',
          body: JSON.stringify({ runId: result.runId, pageUrl: page.url, keys }),
        });
      report.savedPages.push({ url: page.url, title: page.title, scope: page.scope, priority: priority(page), keys });
      report.savedFields ??= {};
      for (const field of page.fields.filter(field => keys.includes(field.key))) {
        (report.savedFields[field.key] ??= []).push({ value: field.value, quote: field.quote, pageUrl: page.url, priority: priority(page) });
      }
      } catch (error) {
        report.warnings.push({ stage: 'save', message: error.message, url: page.url });
      }
    }
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      for (const site of result.sites) {
        const existing = await prisma.sourceMaterial.findFirst({
          where: { competitionId: competition.id, url: site.url },
          select: { id: true },
        });
        if (!existing) {
          await prisma.sourceMaterial.create({
            data: {
              competitionId: competition.id,
              type: 'official_site',
              title: site.title,
              url: site.url,
              ownerId: 'u-demo',
            },
          });
        }
        report.officialSites.push({ url: site.url, title: site.title, scope: site.scope });
      }
      const saved = await prisma.competition.findUniqueOrThrow({
        where: { id: competition.id },
        include: {
          organizers: { where: { role: 'host' }, include: { organizer: true } },
          stages: true,
          entries: true,
          sources: true,
          fieldEvidence: true,
        },
      });
      let eligibility = JSON.parse(saved.eligibilityJson || '{}');
      const corrections = [];
      const best = key => report.savedFields?.[key]?.sort((left, right) => right.priority - left.priority)[0];
      const bestOrganizer = best('organizer');
      if (bestOrganizer && (saved.organizers.length !== 1 || normalized(saved.organizers[0].organizer.name) !== normalized(bestOrganizer.value))) {
        await request(`/competitions/${competition.id}/discovery-fields`, {
          method: 'POST', body: JSON.stringify({ runId: result.runId, pageUrl: bestOrganizer.pageUrl, keys: ['organizer'] }),
        });
        corrections.push('按来源优先级重选主办机构');
      }
      const bestDescription = best('competitionContent');
      if (bestDescription && normalized(saved.description) !== normalized(bestDescription.value)) {
        await request(`/competitions/${competition.id}/discovery-fields`, {
          method: 'POST', body: JSON.stringify({ runId: result.runId, pageUrl: bestDescription.pageUrl, keys: ['competitionContent'] }),
        });
        corrections.push('按来源优先级重选比赛内容');
      }
      const bestEligibility = best('eligibility');
      if (bestEligibility && normalized(eligibility.eligibility) !== normalized(bestEligibility.value)) {
        await request(`/competitions/${competition.id}/discovery-fields`, {
          method: 'POST', body: JSON.stringify({ runId: result.runId, pageUrl: bestEligibility.pageUrl, keys: ['eligibility'] }),
        });
        corrections.push('按来源优先级重选参赛对象');
      }
      const bestSchedule = best('scheduleNote');
      if (bestSchedule && normalized(saved.scheduleNote) !== normalized(bestSchedule.value)) {
        await request(`/competitions/${competition.id}/discovery-fields`, {
          method: 'POST', body: JSON.stringify({ runId: result.runId, pageUrl: bestSchedule.pageUrl, keys: ['scheduleNote'] }),
        });
        corrections.push('按来源优先级重选赛程说明');
      }
      if (corrections.length) {
        const refreshed = await prisma.competition.findUniqueOrThrow({ where: { id: competition.id }, include: { organizers: { where: { role: 'host' }, include: { organizer: true } } } });
        saved.description = refreshed.description;
        saved.scheduleNote = refreshed.scheduleNote;
        saved.organizers = refreshed.organizers;
        eligibility = JSON.parse(refreshed.eligibilityJson || '{}');
      }
      report.corrections = corrections;
      report.rollbacks = [];
      const organizerEvidence = await prisma.fieldEvidence.findMany({ where: { competitionId: competition.id, fieldName: 'organizer' } });
      if (!bestOrganizer && saved.organizers.some(item => LOCAL_UNIT.test(item.organizer.name.trim()) || item.organizer.name.length > 120 || /第一届|历届|往届|上届/.test(item.organizer.name)
        || /^(?:工程实践与创新中心|教务处|创新创业学院)$/.test(item.organizer.name.trim())
        || organizerEvidence.some(field => /(?:18|19|20)\d{2}年.{0,30}(?:创办|发起|研发|开始)/.test(field.snippet ?? '')))) {
        await prisma.competitionOrganizer.deleteMany({ where: { competitionId: competition.id, role: 'host' } });
        await prisma.fieldEvidence.deleteMany({ where: { competitionId: competition.id, fieldName: 'organizer' } });
        saved.organizers = [];
        report.rollbacks.push('organizer_invalid');
      }
      const eligibilityEvidence = await prisma.fieldEvidence.findMany({ where: { competitionId: competition.id, fieldName: 'eligibility' } });
      if (!bestEligibility && eligibility.eligibility && (CAMPUS_SOURCE.test(eligibility.eligibility) ||
        (!ELIGIBILITY_HEADING.test(eligibility.eligibility) && !eligibilityEvidence.some(field => ELIGIBILITY_HEADING.test(field.snippet ?? ''))) ||
        INTRODUCTORY_FIELD.test(eligibility.eligibility) ||
        /我校|本校|我院|校区|全校|全院/.test(eligibility.eligibility) || BAD_ELIGIBILITY.test(eligibility.eligibility) || eligibility.eligibility.length > 360)) {
        delete eligibility.eligibility;
        await prisma.competition.update({ where: { id: competition.id }, data: { eligibilityJson: JSON.stringify(eligibility) } });
        await prisma.fieldEvidence.deleteMany({ where: { competitionId: competition.id, fieldName: 'eligibility' } });
        report.rollbacks.push('eligibility_invalid');
      }
      const scopedDescription = composite && report.savedFields?.competitionContent?.some(field => result.pages.find(page => page.url === field.pageUrl)?.scope === 'track');
      if (!bestDescription && saved.description && (BAD_CONTENT.test(saved.description.trim()) || CAMPUS_CONTENT.test(saved.description.trim()) || scopedDescription)) {
        await prisma.competition.update({ where: { id: competition.id }, data: { description: null } });
        await prisma.fieldEvidence.deleteMany({ where: { competitionId: competition.id, fieldName: 'description' } });
        saved.description = null;
        report.rollbacks.push('description_invalid');
      }
      const scopedSchedule = composite && report.savedFields?.scheduleNote?.some(field => result.pages.find(page => page.url === field.pageUrl)?.scope === 'track');
      if (!bestSchedule && saved.scheduleNote && (BAD_SCHEDULE.test(saved.scheduleNote.trim()) || INTRODUCTORY_FIELD.test(saved.scheduleNote) || scopedSchedule)) {
        await prisma.competition.update({ where: { id: competition.id }, data: { scheduleNote: null } });
        await prisma.fieldEvidence.deleteMany({ where: { competitionId: competition.id, fieldName: 'schedule' } });
        saved.scheduleNote = null;
        report.rollbacks.push('schedule_invalid');
      }
      if (composite) {
        const scopedEvidence = await prisma.fieldEvidence.findMany({ where: { competitionId: competition.id } });
        const specificTrack = /品牌策划|会展|国际贸易|创新创业|会计与商业管理|流通业|创业研究|创业计划|RoboMaster|RoboCon/i;
        const data = {};
        if (competition.catalogIndex === 44) {
          data.description = null;
          data.scheduleNote = null;
          data.signupUrl = null;
          data.nearestDeadline = null;
          data.registrationStatus = 'undetermined';
          delete eligibility.eligibility;
          data.eligibilityJson = JSON.stringify(eligibility);
          await prisma.registrationStage.deleteMany({ where: { competitionId: competition.id, stageType: 'official' } });
          await prisma.fieldEvidence.deleteMany({ where: { competitionId: competition.id, fieldName: { in: ['description', 'eligibility', 'schedule', 'nearestDeadline', 'signupUrl'] } } });
          report.rollbacks.push('composite_track_fields');
        }
        if (saved.description && specificTrack.test(saved.description)) data.description = null;
        if (eligibility.eligibility && specificTrack.test(eligibility.eligibility)) {
          delete eligibility.eligibility;
          data.eligibilityJson = JSON.stringify(eligibility);
        }
        if (saved.scheduleNote && specificTrack.test(saved.scheduleNote)) data.scheduleNote = null;
        if (saved.nearestDeadline && scopedEvidence.some(field => field.fieldName === 'nearestDeadline' && specificTrack.test(`${field.sourceTitle ?? ''}\n${field.snippet ?? ''}`))) {
          data.nearestDeadline = null;
          data.registrationStatus = 'undetermined';
          await prisma.registrationStage.deleteMany({ where: { competitionId: competition.id, stageType: 'official' } });
        }
        if (Object.keys(data).length) {
          await prisma.competition.update({ where: { id: competition.id }, data });
          Object.assign(saved, data);
          report.rollbacks.push('composite_track_fields');
        }
        const trackScopedFields = ['description', 'eligibility', 'schedule', 'nearestDeadline', 'signupUrl'];
        const scopedIds = scopedEvidence.filter(field => trackScopedFields.includes(field.fieldName)
          && specificTrack.test(`${field.sourceTitle ?? ''}\n${field.snippet ?? ''}`)).map(field => field.id);
        if (scopedIds.length) await prisma.fieldEvidence.deleteMany({ where: { id: { in: scopedIds } } });
      }
      const bestDeadline = best('nearestDeadline');
      if (bestDeadline) {
        await request(`/competitions/${competition.id}/discovery-fields`, {
          method: 'POST', body: JSON.stringify({ runId: result.runId, pageUrl: bestDeadline.pageUrl, keys: ['nearestDeadline'] }),
        });
        const refreshed = await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } });
        if (refreshed.nearestDeadline?.getTime() !== saved.nearestDeadline?.getTime()) corrections.push('按来源优先级重选报名截止日期');
        saved.nearestDeadline = refreshed.nearestDeadline;
        saved.registrationStatus = refreshed.registrationStatus;
      }
      const bestSignup = best('signupUrl');
      if (bestSignup && saved.signupUrl !== bestSignup.value) {
        await request(`/competitions/${competition.id}/discovery-fields`, {
          method: 'POST', body: JSON.stringify({ runId: result.runId, pageUrl: bestSignup.pageUrl, keys: ['signupUrl'] }),
        });
        corrections.push('按来源优先级重选报名入口');
        const refreshed = await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } });
        saved.signupUrl = refreshed.signupUrl;
      }
      const deadlineEvidence = await prisma.fieldEvidence.findMany({ where: { competitionId: competition.id, fieldName: 'nearestDeadline' } });
      const campusDeadline = deadlineEvidence.some(field => CAMPUS_SOURCE.test(field.snippet ?? '') || /校级|校内|院级|校内选拔/.test(field.sourceTitle ?? ''));
      const regionalDeadline = report.savedPages.some(page => page.scope === 'regional' && page.keys.includes('nearestDeadline') && CAMPUS_SOURCE.test(
        result.pages.find(item => item.url === page.url)?.fields.find(field => field.key === 'nearestDeadline')?.quote ?? ''));
      if ((campusDeadline || regionalDeadline) && !best('nearestDeadline')) {
        await prisma.competition.update({ where: { id: competition.id }, data: { nearestDeadline: null, registrationStatus: 'undetermined' } });
        await prisma.registrationStage.deleteMany({ where: { competitionId: competition.id, stageType: 'official' } });
        await prisma.fieldEvidence.deleteMany({ where: { competitionId: competition.id, fieldName: 'nearestDeadline' } });
        saved.nearestDeadline = null;
        saved.registrationStatus = 'undetermined';
        report.rollbacks.push('deadline_campus');
      }
      const organizerNames = saved.organizers.map(item => item.organizer.name);
      if (organizerNames.length === 1) {
        const normalizedOrganizer = organizerNames[0].normalize('NFKC').replace(/([一-龥])\s+(?=[一-龥])/g, '$1');
        if (normalizedOrganizer !== organizerNames[0]) {
          const bestSource = [...report.savedPages].filter(page => page.keys.includes('organizer')).sort((left, right) => right.priority - left.priority)[0];
          const canonical = bestSource && result.pages.find(page => page.url === bestSource.url)?.fields.find(field => field.key === 'organizer')?.value;
          if (canonical && normalized(canonical) === normalizedOrganizer && canonical !== organizerNames[0]) {
            await request(`/competitions/${competition.id}/discovery-fields`, {
              method: 'POST', body: JSON.stringify({ runId: result.runId, pageUrl: bestSource.url, keys: ['organizer'] }),
            });
            saved.organizers = [{ organizer: { name: canonical } }];
            corrections.push('按最高优先级原文规范主办方排版');
          }
        }
      }
      report.saved = {
        publishStatus: saved.publishStatus,
        description: saved.description,
        organizer: saved.organizers.map(item => item.organizer.name),
        eligibility: eligibility.eligibility ?? null,
        scheduleNote: saved.scheduleNote,
        nearestDeadline: saved.nearestDeadline,
        registrationStatus: saved.registrationStatus,
        signupUrl: saved.signupUrl,
        stages: saved.stages.length,
        entries: saved.entries.length,
        sources: saved.sources.length,
        officialSources: saved.sources.filter(source => source.type === 'official_site').length,
        evidenceFields: [...new Set(saved.fieldEvidence.map(field => field.fieldName))],
        trackCount: saved.fieldEvidence.filter(field => field.fieldName === 'discoveryTracks').reduce((count, field) => {
          try { return count + JSON.parse(field.fieldValue || '[]').length; } catch { return count; }
        }, 0),
      };
      report.missingFields = Object.entries({
        比赛内容: saved.description,
        主办机构: saved.organizers.length,
        参赛对象: eligibility.eligibility,
        赛程说明: saved.scheduleNote,
        报名截止: saved.nearestDeadline,
        报名入口: saved.signupUrl,
        官网或官方公告来源: saved.sources.filter(source => source.type === 'official_site' || source.type === 'other').length,
      }).filter(([, value]) => missingValue(value)).map(([key]) => key);
      report.dataStatus = report.savedPages.length || report.officialSites.length ? 'enriched' : 'no_new_fields';
    } finally {
      await prisma.$disconnect();
    }
    report.status = 'completed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack || error.message;
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { completed: [], failed: [] };
  for (const key of ['completed', 'failed']) state[key] = state[key].filter(id => id !== competition.id);
  state[report.status === 'completed' ? 'completed' : 'failed'].push(competition.id);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(`[${report.catalogIndex}/71] ${report.status}/${report.dataStatus ?? '-'} ${report.name}; pages=${report.savedPages.length}; sites=${report.officialSites.length}; warnings=${report.warnings.length}`);
  return report;
}

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  let competitions;
  try {
    competitions = await prisma.competition.findMany({
      where: { createdBy: 'u-demo', deletedAt: null, schoolRecognitionLevel: { in: ['A类', 'B类', 'C类'] } },
      select: { id: true, name: true, schoolRecognitionLevel: true },
      orderBy: { createdAt: 'asc' },
    });
  } finally {
    await prisma.$disconnect();
  }
  if (competitions.length !== 71) throw new Error(`目录记录应为 71 条，实际为 ${competitions.length} 条，已停止。`);
  competitions = competitions.map((competition, index) => ({ ...competition, catalogIndex: index + 1 }));
  const only = process.env.CATALOG_ONLY?.split(',').map(Number).filter(Boolean);
  const pending = competitions.filter(competition => !only?.length || only.includes(competition.catalogIndex));
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const competition = pending[cursor++];
      await enrich(competition);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
