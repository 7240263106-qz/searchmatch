require('../apps/api/node_modules/reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CompetitionDiscoveryService } = require('../apps/api/dist/services/competition-discovery.service');
const { SafeEgressService } = require('../apps/api/dist/platform/safe-fetch');
const { RobotsService } = require('../apps/api/dist/platform/robots.service');
const { RateLimiterService } = require('../apps/api/dist/platform/rate-limiter.service');
const { htmlToText, extractLinks, pageTitle } = require('../apps/api/dist/domain/html');
const { ParserClient } = require('../apps/api/dist/services/parser-client.service');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/catalog-review-20261116');
const audit = JSON.parse(fs.readFileSync(path.join(output, 'audit.json'), 'utf8'));
const followup = process.argv.includes('--followup');
const requested = process.argv.slice(2).map(Number).filter(Number.isFinite);
const service = new CompetitionDiscoveryService(null, new SafeEgressService(), new RobotsService(),
  new RateLimiterService({ getNumber: (_key, fallback) => fallback }), null, null, null);
const directory = path.join(output, 'source-text');
fs.mkdirSync(directory, { recursive: true });
const targets = [];
for (const row of audit.rows.filter(row => !followup && (!requested.length || requested.includes(row.index)))) {
  const pages = ['research-fallback', 'research'].flatMap(folder => {
    const file = path.join(output, folder, `${row.id}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).pages : [];
  });
  const urls = [...new Map([...pages.filter(page => page.kind !== 'listing').map(page => ({ ...page,
    rank: (page.fields.length ? 30 : 0) + (page.year === 2026 ? 20 : 0) })),
    ...row.sources.filter(source => source.url && !/\.pdf(?:[?#]|$)/i.test(source.url)).map(source => ({ ...source,
      rank: row.dateEvidence.some(field => field.sourceId === source.id) ? 25 : 5 }))]
    .sort((left, right) => right.rank - left.rank).map(item => [item.url, item])).values()];
  for (const source of urls.slice(0, requested.length ? 7 : 3)) targets.push({ id: row.id, name: row.name, index: row.index, url: source.url });
}
if (followup) {
  const items = JSON.parse(fs.readFileSync(path.join(output, 'followup-sources.json'), 'utf8'));
  for (const item of items) {
    const row = audit.rows[item.index - 1];
    targets.push({ id: row.id, name: row.name, index: row.index, url: item.url });
  }
}
async function read(target) {
  const key = createHash('sha256').update(target.url).digest('hex').slice(0, 18);
  const file = path.join(directory, `${key}.json`);
  if (fs.existsSync(file)) return;
  const record = { ...target, at: new Date().toISOString() };
  try {
    const response = await service.readRemote(target.url, 2500000, 'text/html,application/xhtml+xml');
    if (/pdf/i.test(response.contentType ?? '') || response.buffer.subarray(0, 5).toString() === '%PDF-') {
      const parser = new ParserClient({ getString: (_key, fallback) => fallback, getNumber: (_key, fallback) => fallback });
      const result = await parser.parse('竞赛通知.pdf', 'pdf', response.buffer, true);
      if (!result.ok) throw new Error(result.errorCode ?? 'pdf_parse_failed');
      Object.assign(record, { status: 'ok', title: target.title ?? '竞赛官方通知附件', text: result.text, links: [], pageCount: result.pageCount });
      fs.writeFileSync(file, JSON.stringify(record, null, 2));
      console.log(JSON.stringify({ index: target.index, url: target.url, status: 'ok', pdf: true, characters: record.text.length }));
      return;
    }
    const initial = response.buffer.toString('utf8');
    const encoding = /charset\s*=\s*["']?([\w-]+)/i.exec(`${response.contentType}\n${initial.slice(0, 3000)}`)?.[1];
    const html = encoding && /^(?:gb|big5)/i.test(encoding) ? new TextDecoder(encoding).decode(response.buffer) : initial;
    record.url = response.finalUrl;
    record.title = pageTitle(html);
    record.text = htmlToText(html);
    record.links = extractLinks(html, response.finalUrl);
    record.status = 'ok';
  } catch (error) {
    record.status = 'skipped';
    record.reason = error.code ?? error.message;
  }
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ index: target.index, title: record.title, url: target.url, status: record.status, reason: record.reason, characters: record.text?.length }));
}
async function main() {
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < targets.length) await read(targets[next++]);
  }));
  console.log(JSON.stringify({ finishedAt: new Date().toISOString(), attempted: targets.length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
