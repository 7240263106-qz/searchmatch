require('../apps/api/node_modules/reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CompetitionDiscoveryService } = require('../apps/api/dist/services/competition-discovery.service');
const { SafeEgressService } = require('../apps/api/dist/platform/safe-fetch');
const { RobotsService } = require('../apps/api/dist/platform/robots.service');
const { RateLimiterService } = require('../apps/api/dist/platform/rate-limiter.service');
const { ParserClient } = require('../apps/api/dist/services/parser-client.service');
const { AgentLogService } = require('../apps/api/dist/platform/agent-log.service');
const { discoveryTarget, identityScore, isOtherDiscoveryYear, isCampusDiscoveryNotice, scoreDiscoveryLink } = require('../apps/api/dist/domain/competition-discovery');
const { extractFields } = require('../apps/api/dist/domain/rule-extractor');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'catalog-review-20261116');
const audit = JSON.parse(fs.readFileSync(path.join(output, 'audit.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.join(output, 'before.json'), 'utf8'));
const extraFile = path.join(output, 'search-seeds.json');
const extra = fs.existsSync(extraFile) ? JSON.parse(fs.readFileSync(extraFile, 'utf8')) : {};
const fallback = process.argv.includes('--fallback');
const researchFolder = fallback ? 'research-fallback' : 'research';
const sourceCode = fs.readFileSync(path.join(root, 'apps/api/src/services/competition-discovery.service.ts'), 'utf8');
const clueLiteral = sourceCode.match(/const VERIFIED_CATALOG_CLUES[^=]*= (\{[\s\S]*?\n\});/);
const catalogClues = clueLiteral ? require('node:vm').runInNewContext(`(${clueLiteral[1]})`) : {};
const resolver = { getNumber: (_key, fallback) => fallback, getString: (_key, fallback) => fallback };
const log = new AgentLogService(path.join(root, 'artifacts', 'runtime', 'agent-logs'));
const discovery = new CompetitionDiscoveryService(null, new SafeEgressService(), new RobotsService(),
  new RateLimiterService(resolver), { extract: async (body, blocks, title) => extractFields(body, blocks, title) },
  { configured: false }, new ParserClient(resolver));
const dateFlags = row => row.dateEvidence.some(field => {
  const source = row.sources.find(source => source.id === field.sourceId);
  return source && isCampusDiscoveryNotice(discoveryTarget(row.name), source.url, source.title, field.quote ?? '');
}) || /全球校园人工智能/.test(row.name) || /中国国际大学生创新大赛/.test(row.name);
const targets = audit.rows.filter(row => !row.hasDates || dateFlags(row));
fs.mkdirSync(path.join(output, researchFolder), { recursive: true });

function sourceRank(source, target) {
  const title = source.title ?? '';
  const host = new URL(source.url).hostname;
  return (extra[target.name]?.includes(source.url) ? 100 : 0)
    + (/gov\.cn$/.test(host) ? 50 : /edu\.cn$/.test(host) ? 5 : 20)
    + (/2026|2027/.test(title) ? 20 : 0) + (/通知|章程|规程|指南/.test(title) ? 15 : 0);
}

async function research(row) {
  const file = path.join(output, researchFolder, `${row.id}.json`);
  if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).finishedAt) return;
  const target = discoveryTarget(row.name);
  const record = { id: row.id, name: row.name, runId: randomUUID(), startedAt: new Date().toISOString(), searches: [], pages: [], visits: [], logs: [], proposedFields: [] };
  const report = event => {
    const entry = { ...event, at: new Date().toISOString() };
    record.logs.push(entry);
    log.record(record.runId, entry);
  };
  const save = () => fs.writeFileSync(file, JSON.stringify(record, null, 2));
  report({ stage: 'task', level: 'info', message: `审核补采「${row.name}」：核对日期与此前跳过原因。` });
  try {
    const aliases = target.aliases.filter(name => name.length < 55);
    const term = aliases.at(-1) ?? target.name;
    const results = [];
    const queries = fallback ? [['bing', target.name.replace(/[“”]/g, '')], ['sogou', `${term} 通知`]]
      : [['bing', `"${term}" ${target.year} 通知`], ['sogou', `"${term}" ${target.year} 报名 时间`], ['brave', `"${term}" ${target.year} 竞赛通知`]];
    for (const [provider, query] of queries) {
      const result = await discovery.search(provider, query, target);
      record.searches.push(result.report);
      results.push(...result.candidates);
      report({ stage: 'search', level: result.report.error ? 'warning' : 'info',
        message: `${provider}：${query}；${result.report.found} 条结果，${result.report.relevant} 条匹配。`, reason: result.report.error });
      if (results.filter(candidate => identityScore(target, candidate.title) >= 80).length >= 3) break;
    }
    const clues = fallback ? (catalogClues[target.name] ?? []).map(clue => ({ ...clue, title: clue.title ?? target.name })) : [];
    const seeds = [...(extra[target.name] ?? extra[row.name] ?? []).map(url => ({ url, title: target.name })), ...clues,
      ...row.sources.filter(source => !isOtherDiscoveryYear(source.title, target.year) && !isCampusDiscoveryNotice(target, source.url, source.title))];
    const queue = [...new Map([...seeds.sort((left, right) => sourceRank(right, target) - sourceRank(left, target)).slice(0, fallback ? 4 : 2),
      ...results.filter(candidate => identityScore(target, candidate.title) >= 80).sort((left, right) => right.score - left.score).slice(0, 5)]
      .map(candidate => [candidate.url, candidate])).values()];
    const visited = new Set();
    while (queue.length && visited.size < (fallback ? 8 : 6)) {
      const candidate = queue.shift();
      if (visited.has(candidate.url) || /\.(?:zip|rar|docx?|xlsx?|pptx?)(?:[?#]|$)/i.test(candidate.url)) continue;
      visited.add(candidate.url);
      const visit = { url: candidate.url, title: candidate.title, at: new Date().toISOString() };
      record.visits.push(visit);
      try {
        const isPdf = /\.pdf(?:[?#]|$)/i.test(candidate.url);
        const readings = isPdf
          ? [{ page: await discovery.readPdf(candidate, { url: candidate.url, title: candidate.title, kind: 'attachment', scope: 'general', year: null, edition: null, excerpt: '', fields: [], attachments: [] }, target, report), followLinks: [] }]
          : await discovery.readPage(candidate.url, target, report, url => discovery.readNoticeFeed(url), () => {});
        for (const reading of readings) {
          const page = reading.page;
          record.pages.push(page);
          visit.status = 'verified';
          visit.kind = page.kind;
          visit.scope = page.scope;
          visit.year = page.year;
          visit.fields = page.fields.map(field => field.key);
          for (const field of page.fields) {
            if (page.scope === 'general' && page.year === target.year) record.proposedFields.push({ ...field, pageUrl: page.url, title: page.title });
          }
          if (!fallback && !row.hasDates && page.scope === 'general' && page.fields.some(field => field.key === 'nearestDeadline' || field.key === 'scheduleNote')) {
            queue.length = 0;
            break;
          }
          const follow = (reading.followLinks ?? []).filter(link => !isOtherDiscoveryYear(link.title, target.year))
            .sort((left, right) => scoreDiscoveryLink(target, right) - scoreDiscoveryLink(target, left)).slice(0, 2);
          queue.push(...page.attachments.slice(0, 1), ...follow);
        }
      } catch (error) {
        visit.status = 'skipped';
        visit.reason = error.code ?? error.message;
        report({ stage: 'page', level: 'warning', url: candidate.url, message: '审核补采跳过该来源。', reason: String(visit.reason).slice(0, 100) });
      }
      save();
    }
  } catch (error) {
    record.error = error.code ?? error.message;
  } finally {
    record.finishedAt = new Date().toISOString();
    report({ stage: 'task', level: record.error ? 'error' : 'success', message: `审核补采完成：${record.pages.length} 个核验页面，${record.proposedFields.length} 条候选字段。` });
    save();
    console.log(JSON.stringify({ id: row.id, name: row.name, searches: record.searches.length, pages: record.pages.length,
      fields: [...new Set(record.proposedFields.map(field => field.key))], skipped: record.visits.filter(visit => visit.status === 'skipped').length, error: record.error }));
  }
}

async function main() {
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < targets.length) await research(targets[next++]);
  }));
  await log.onApplicationShutdown();
  console.log(JSON.stringify({ finishedAt: new Date().toISOString(), targetCount: targets.length }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
