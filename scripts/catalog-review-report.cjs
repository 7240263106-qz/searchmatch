const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('../apps/api/node_modules/@prisma/client');

const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'artifacts', 'catalog-review-20261116');
const prisma = new PrismaClient();
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : null;
const execution = read(path.join(directory, 'execution.json'));
const manifest = read(path.join(directory, 'review-manifest.json'));
const supplement = read(path.join(directory, 'supplemental-execution.json'));
const finalScope = read(path.join(directory, 'final-scope-execution.json'));
const unique = values => [...new Set(values.filter(Boolean))];
const clean = value => String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
const dateTextPattern = /20\d{2}年|\d{1,2}月(?:\d{1,2}|上旬|中旬|下旬|底)|20\d{2}[-/]\d{1,2}/;
const statusLabel = status => ({ published: '已发布', draft: '草稿（暂缓发布）', pending_review: '待审核' }[status] ?? status);
const fieldLabel = key => ({ competitionContent: '赛事介绍', description: '赛事介绍', organizer: '主办方',
  eligibility: '参赛资格', scheduleNote: '赛程说明', schedule: '赛程说明', signupUrl: '报名入口',
  signupNote: '报名入口范围', nearestDeadline: '报名截止', discoveryTracks: '赛道资料' }[key] ?? key);
const reasonLabels = {
  timeout: '访问或搜索超时', empty_or_challenge: '搜索为空或触发验证', no_page_identity: '正文赛事身份未核实',
  year_mismatch: '年份与目标不一致', year_unconfirmed: '年份未确认', campus_notice: '校内通知，不可直接套用全国',
  robots_disallowed: 'robots 禁止访问', robots_unknown: 'robots 状态未确认', browser_busy: '动态页面读取器忙',
  http_412: '站点返回 HTTP 412', http_403: '站点返回 HTTP 403', http_404: '页面 HTTP 404',
};

function investigation(id, index, texts) {
  const runs = [
    ['原始补全', read(path.join(root, 'artifacts', 'catalog-completion-20261116', `${id}.json`))],
    ['审核联网', read(path.join(directory, 'research', `${id}.json`))],
    ['名称回退搜索', read(path.join(directory, 'research-fallback', `${id}.json`))],
  ].filter(([, run]) => run);
  const issues = runs.flatMap(([phase, run]) => [
    ...(run.warnings ?? []), ...(run.logs ?? []).filter(log => log.level === 'warning' || log.reason),
    ...(run.visits ?? []).filter(visit => visit.status === 'skipped'),
  ].filter(log => log.reason || log.level === 'warning').map(log => ({ phase, reason: log.reason ?? log.message,
    url: log.url ?? null, message: log.message ?? null })));
  for (const text of texts.filter(text => text.index === index && text.status !== 'ok')) {
    issues.push({ phase: '定向原文/附件', reason: text.reason ?? text.status, url: text.url ?? null, message: null });
  }
  const distinct = [...new Map(issues.map(issue => [`${issue.phase}|${issue.reason}|${issue.url}`, issue])).values()];
  return { runs: runs.map(([phase, run]) => ({ phase, runId: run.runId, searches: run.searches ?? [],
    verifiedPages: (run.pages ?? run.result?.pages ?? []).length })), issues: distinct };
}

async function search(label, conditions) {
  const response = await fetch('http://127.0.0.1:3000/api/v1/search/competitions', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-actor-id': 'u-demo', 'x-actor-roles': 'editor,reviewer,admin' },
    body: JSON.stringify({ limit: 100, ...conditions }),
  });
  if (!response.ok) throw new Error(`接口核验失败：${label} HTTP ${response.status}`);
  const body = await response.json();
  if (!body.data?.page || !Array.isArray(body.data.items)) throw new Error(`接口响应结构异常：${label}`);
  return { label, conditions, total: body.data.page.total, ids: body.data.items.map(item => item.id),
    names: body.data.items.map(item => item.name) };
}

async function main() {
  if (execution.summary.failed || execution.rows.length !== 72 || !supplement.finishedAt || !finalScope.finishedAt) {
    throw new Error('审核执行记录不完整，停止生成完成报告');
  }
  const rows = await prisma.competition.findMany({
    where: { id: { in: execution.rows.map(row => row.id) } },
    include: { sources: true, fieldEvidence: true, stages: true, entries: true,
      organizers: { include: { organizer: true } }, reviews: true },
  });
  const texts = fs.readdirSync(path.join(directory, 'source-text')).map(file => read(path.join(directory, 'source-text', file)));
  const checks = [];
  checks.push(await search('已发布（包含过期）', { includeExpired: true }));
  checks.push(await search('已发布（默认排除过期）', {}));
  checks.push(await search('管理工作区', { scope: 'workspace', includeExpired: true, includeLowCredibility: true }));
  checks.push(await search('新增能源经济', { keyword: '能源经济', includeExpired: true }));
  checks.push(await search('新增智能农业', { keyword: '智能农业', includeExpired: true }));
  const details = execution.rows.map(result => {
    const row = rows.find(item => item.id === result.id);
    if (!row) throw new Error(`缺少审核对象：${result.index}`);
    const decision = manifest.rows.find(item => item.id === row.id);
    const final = finalScope.rows.find(item => item.id === row.id);
    const added = supplement.rows.filter(item => item.id === row.id);
    const saved = result.steps.filter(step => typeof step === 'object').flatMap(step => step.fields);
    const supplemented = added.flatMap(item => item.fields.map(field => field.key));
    const validEvidence = row.fieldEvidence.filter(field => !field.fieldName.startsWith('reviewRejected:'));
    const dateEvidence = validEvidence.filter(field => ['schedule', 'nearestDeadline', 'discoveryTracks'].includes(field.fieldName));
    const datedMaterial = Boolean(row.nearestDeadline || dateTextPattern.test([row.scheduleNote,
      ...dateEvidence.map(field => field.fieldValue)].filter(Boolean).join('\n')));
    let eligibility;
    try { eligibility = JSON.parse(row.eligibilityJson); } catch { eligibility = {}; }
    const missing = unique([
      ...(!row.description ? ['赛事介绍'] : []),
      ...(!row.organizers.length ? ['主办方'] : []),
      ...(!eligibility.eligibility ? ['详细参赛资格'] : []),
      ...(!row.nearestDeadline ? ['全国统一报名截止（未确定或不适用于聚合赛事）'] : []),
      ...(!row.scheduleNote ? ['主表赛程说明（赛道资料中可能另有记录）'] : []),
      ...(!row.signupUrl ? ['直达报名入口'] : []),
    ]);
    const logs = investigation(row.id, result.index, texts);
    return { index: result.index, id: row.id, name: row.name, publishStatus: row.publishStatus,
      newlyPublished: result.steps.includes('published'), versionNo: row.versionNo, reason: decision.reason,
      dateScope: final?.scheduleNote ?? decision.dateScope, datedMaterial, nearestDeadline: row.nearestDeadline,
      scheduleNote: row.scheduleNote, signupUrl: row.signupUrl, signupNote: row.signupNote,
      changedFields: unique([...saved, ...supplemented, ...(final?.saved?.fields.map(field => field.key) ?? []),
        ...(final ? ['signupNote'] : [])]), missing, sources: row.sources.filter(source => source.url),
      rejectedEvidence: row.fieldEvidence.filter(field => field.fieldName.startsWith('reviewRejected:')),
      substantiveEvidenceFields: unique(validEvidence.filter(field => field.sourceId
        && (field.snippet || field.fieldName === 'discoveryTracks')).map(field => field.fieldName)),
      clearedDeadline: Boolean(decision.clearDeadline), ...logs };
  });
  const published = details.filter(row => row.publishStatus === 'published').length;
  const held = details.filter(row => row.publishStatus !== 'published');
  const summary = { at: new Date().toISOString(), reviewDate: '2026-11-17', total: details.length,
    schoolCatalog: 71, existingAdditionalParent: 1, newlyPublished: execution.summary.newlyPublished,
    published, draft: held.length, failed: execution.summary.failed,
    fieldSaveOperations: manifest.rows.flatMap(row => row.pages).flatMap(page => page.fields).length
      + supplement.rows.flatMap(row => row.fields).length + finalScope.rows.flatMap(row => row.saved?.fields ?? []).length,
    signupScopeNotes: finalScope.rows.length,
    withAnyDatedMaterial: details.filter(row => row.datedMaterial).length,
    withoutDatedMaterial: details.filter(row => !row.datedMaterial).length,
    withGlobalDeadline: details.filter(row => row.nearestDeadline).length,
    clearedDeadlines: details.filter(row => row.clearedDeadline).map(row => row.index),
    checks, held: held.map(({ index, id, name, reason }) => ({ index, id, name, reason })), rows: details };
  if (published !== 64 || held.length !== 8 || checks[0].total !== published || checks[2].total !== details.length
    || checks[3].total < 1 || checks[4].total < 1) throw new Error('实时数量不符合预期，请检查并发更新及接口过滤条件');
  fs.writeFileSync(path.join(directory, 'after.json'), JSON.stringify({ at: summary.at, rows }, null, 2));
  fs.writeFileSync(path.join(directory, 'final-summary.json'), JSON.stringify(summary, null, 2));
  const lines = [
    '# 竞赛逐项审核与知识库入库报告', '',
    '审核日期：2026年11月17日（北京时间）。', '',
    '## 实际完成结果', '',
    `学校竞赛目录71项，加原有蓝桥杯父记录1项，共${summary.total}条父记录，全部有逐项审核结论。新增发布${summary.newlyPublished}条，现已发布${published}条，${held.length}条保留草稿，执行失败${summary.failed}条。`, '',
    `本次三轮保存共${summary.fieldSaveOperations}次有原文引文的字段操作，另补${summary.signupScopeNotes}处报名入口适用范围。字段操作数包含同一字段的后续更新，不等同于唯一字段数。`, '',
    `当前${summary.withAnyDatedMaterial}条含日期材料、${summary.withoutDatedMaterial}条未发现可用日期材料；${summary.withGlobalDeadline}条主表保留报名截止。日期材料包括赛道/地区/学校参考、历史届次及拟定安排，不代表已确认全国统一日期。`, '',
    '现有资料达到部分发布标准的记录已发布；尚未核实的字段继续留空或保留范围说明，并未宣称所有竞赛的所有字段都已补齐。', '',
    '## 知识库与检索核验', '',
    '本项目的知识库检索使用已发布竞赛库，智能体调用同一竞赛搜索服务；本次没有建立或声称完成独立向量库嵌入。工作区草稿不作为公开知识库条目。', '',
    '| 接口核验 | 当前条数 |', '| --- | ---: |',
    ...checks.map(check => `| ${check.label} | ${check.total} |`), '',
    '默认公开搜索排除过期记录；勾选包含过期可看到全部64条已发布记录。关键词“能源经济”“智能农业”已通过运行中的API找到对应新增竞赛。智能体基础关键词查询亦已核验；不把这一结果扩大为任意自然语言问法均已验证。', '',
    '## 数据缺失与未显示的原因', '',
    '- 导入目录主要建立竞赛条目，部分资料仍是草稿；普通知识库只搜索已发布记录。',
    '- 部分发布条目残留导入时的低可信评分，导致默认过滤。发布时重新计算审核后的可信度，并验证默认检索可见性。',
    '- 网络日志存在搜索超时/验证页、HTTP 412/406、证书过期、连接重置、robots限制、动态正文读取失败。',
    '- 页面只有赛事首页或搜索标题，缺少可核验的正文与引文；这些不作为实质字段自动补录。',
    '- 页面校级/地区/赛道/届次范围与父竞赛不同；年份或正文届次冲突时拒绝套用全国截止。',
    '- 日期提取曾将省赛最迟完成日期误认报名截止；已修正提取逻辑并增加回归测试。', '',
    '## 暂缓发布的8项', '',
    '| 审核序号 | 竞赛 | 原因 |', '| ---: | --- | --- |',
    ...held.map(row => `| ${row.index} | ${clean(row.name)} | ${clean(row.reason)} |`), '',
    '## 日期与字段污染修正', '',
    `已清除以下${summary.clearedDeadlines.length}项不适合作父竞赛统一报名截止的旧值：${summary.clearedDeadlines.join('、')}。同时清理对应official阶段的截止字段、保留原始证据并标记为reviewRejected。截止数减少属于纠错，原文和审计记录仍保留。`, '',
    '| 序号 | 竞赛 | 审核问题与处置 |', '| ---: | --- | --- |',
    ...details.filter(row => row.clearedDeadline || row.rejectedEvidence.length).map(row =>
      `| ${row.index} | ${clean(row.name)} | ${clean(row.reason)} |`), '',
    '其他特别检查：计算机设计5月30日为高校上推数据截止；物理创新赛第一轮计划、软件杯暂定安排均保留原精度；能源经济为2026—2027跨年；智能农业区分有无省级选拔地区；金砖12月10—13日仅适用AIGC+3D时尚数字设计赛项。不得转成全赛事统一截止。', '',
    '三维设计报名入口已标“数字化设计与制造分赛”；光电报名入口已标“西北赛区”，光电主表赛程已替换为明确创意赛道、原通知拟定范围的安排。', '',
    '保留原蓝桥杯与目录蓝桥杯两条父记录及其已有赛道/子项关系，未为消除同名而破坏数据关联。', '',
    '## 全部72项逐项明细', '',
  ];
  for (const row of details) {
    const changed = row.changedFields.length ? unique(row.changedFields.map(fieldLabel)).join('、') : '审核已有资料；无新增实质字段';
    const reasons = unique(row.issues.map(issue => issue.reason));
    lines.push(`### ${row.index}. ${row.name}`, '',
      `- 结果：${statusLabel(row.publishStatus)}${row.newlyPublished ? '，本次新增发布' : ''}；当前版本 ${row.versionNo}。`,
      `- 审核结论：${row.reason}`,
      `- 日期范围：${row.dateScope}`,
      `- 主表报名截止：${row.nearestDeadline ? new Date(row.nearestDeadline).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）' : '未设；不得由地区/校赛/赛道日期推断全国截止'}。`,
      `- 当前赛程：${row.scheduleNote ?? '主表无已采信赛程，赛道材料与来源另列；不推断日期。'}`,
      `- 本轮补录/纠正字段：${changed}。`,
      `- 仍待补全：${row.missing.join('；') || '暂无上述基础字段缺项；具体赛道仍按来源核实'}。`,
      `- 现有报名入口：${row.signupUrl ?? '尚未核实'}${row.signupNote ? `；${row.signupNote}` : ''}`,
      `- 来源支持的字段：${row.substantiveEvidenceFields.map(fieldLabel).join('、') || '没有足够的来源支持实质字段，暂缓发布'}。`,
      `- 检索/采集记录：${row.runs.map(run => `${run.phase}核验页面${run.verifiedPages}个`).join('；') || '已有材料与定向原文核验'}。`,
      `- 日志跳过原因：${reasons.length ? reasons.map(reason => `${reasonLabels[reason] ?? reason}（${reason}）`).join('；') : '本次关联日志未记录跳过错误；不代表每个未知字段均已有来源'}。`, '');
    if (row.sources.length) {
      lines.push('已保存来源：', '', ...unique(row.sources.map(source => `- [${clean(source.title)}](${source.url})`)), '');
    }
    const urlIssues = row.issues.filter(issue => issue.url);
    if (urlIssues.length) {
      lines.push('具体失败/跳过页面（完整记录见 final-summary.json）：', '',
        ...urlIssues.slice(0, row.publishStatus === 'draft' ? 8 : 3).map(issue =>
          `- ${issue.phase}：${issue.reason}；${issue.url}`), '');
    }
    const followup = texts.filter(text => text.index === row.index);
    if (followup.length) lines.push(`- 定向原文/附件核验：${followup.filter(text => text.status === 'ok').length}个成功，${followup.filter(text => text.status !== 'ok').length}个未成功；原文缓存见 source-text。`, '');
  }
  lines.push('## 工程验证与运行项目', '',
    '- 全量测试：12个测试文件、133项测试通过，详见 ../runtime/catalog-review-full-tests.log。',
    '- 完整构建通过，保留既有前端chunk体积提示，详见 ../runtime/catalog-review-build.log。',
    '- API：http://127.0.0.1:3000/api/v1；前端：http://127.0.0.1:5173/library。',
    '- 两个报名范围与光电赛程的最后数据修正已通过数据库回读校验。', '',
    '## 备份与追溯', '',
    '- 写入前SQLite一致性备份：../runtime/before-catalog-review-20261117.db（未覆盖）。',
    '- 首次数据快照：before.json；最终数据库快照：after.json。首次快照与正式执行之间用户已有操作，新增发布57以正式执行前7条已发布为基数。',
    '- 冻结审核方案：review-manifest.json；逐条写入与发布结果：execution.json。',
    '- 附件/日期补录：supplemental-execution.json；最终赛程及报名范围：final-scope-execution.json。',
    '- 本次实时汇总及API校验：final-summary.json；包含逐项完整跳过原因及URL。',
    '- 联网研究：research/、research-fallback/；定向原文：source-text/；每个缓存保存原URL和结果。',
    '- 运行日志：../runtime/catalog-review-research.log、catalog-review-research-fallback.log、catalog-review-fetch.log、catalog-review-followup.log、catalog-review-final-sources.log、catalog-review-final-pdf.log、catalog-review-apply.log、catalog-review-supplement.log、catalog-review-final-scope.log。',
    '- 应用Agent日志：../runtime/agent-logs/agent-2026-11-16.jsonl；可与逐项研究runId对应检查。',
    '- 通过应用服务保存可靠字段并创建来源、引文、版本及outbox；审核结论和范围修正有reviewRecord与audit记录。所有写入使用版本检查，未批量覆盖其他用户的最新内容。', '',
    '本报告描述核验时的数据库状态，后续人工编辑或定时采集可能改变数量。未知日期与暂缓项仍需后续有效公告支持。', '');
  const reportFile = path.join(directory, '竞赛逐项审核报告-20261117.md');
  fs.writeFileSync(reportFile, lines.join('\n'));
  console.log(JSON.stringify({ ...summary, checks: checks.map(({ label, total }) => ({ label, total })), rows: undefined,
    reportFile }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
