const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'artifacts', 'catalog-completion-20261116');
const { PrismaClient } = require(path.join(root, 'apps', 'api', 'node_modules', '@prisma', 'client'));
const prisma = new PrismaClient({
  datasources: { db: { url: 'file:' + path.join(root, 'apps', 'api', 'prisma', 'dev.db').replace(/\\/g, '/') } },
});

const reasonLabels = {
  timeout: '网络请求超时',
  SOURCE_UNREACHABLE: '域名解析或出口网络不可达',
  network_error: '网络连接失败',
  encoding_error: '网页编码无法按声明字符集解析',
  tls_error: '站点 TLS 证书或握手异常',
  http_404: '页面或附件不存在（HTTP 404）',
  empty_or_challenge: '搜索源返回空页或反爬挑战页',
  http_429: '搜索源限流（HTTP 429）',
  http_503: '模型服务不可用（HTTP 503）',
  http_412: '站点访问校验拦截（HTTP 412）',
  robots_disallowed: 'robots.txt 禁止自动读取',
  robots_unknown: 'robots.txt 状态无法确认',
  year_unconfirmed: '正文缺少可核验的当年年份',
  year_mismatch: '公告年份与目标年份不一致',
  edition_mismatch: '届次与目标届次不一致',
  no_page_identity: '页面无法确认赛事身份',
  attachment_identity_unconfirmed: '附件无法确认属于目标赛事',
  attachment_text_missing: '附件缺少可提取文字层',
  attachment_not_pdf: '附件地址未返回有效 PDF',
  parser_unavailable: 'PDF 解析服务不可用',
  javascript_required: '页面需要 JavaScript 渲染',
  https_downgrade: 'HTTPS 跳转降级，被安全策略拦截',
  aborted: '网页请求被中止或连接超时',
  non_html: '来源返回的不是 HTML 网页',
  response_too_large: '网页正文超过采集大小限制',
  robots_denied: 'robots.txt 拒绝访问该站点',
  unknown_error: '网页读取或核验失败，详见原始日志',
  campus_notice: '校赛或高校内部选拔通知，不当作全国赛事资料',
  no_new_fields: '本轮没有取得可保存的新字段',
  notice_type_mismatch: '通知类型不匹配（教师研修/培训，不是学生竞赛通知）',
  campus_source_overwrite: '校内部门或校内安排误覆盖全国赛事字段',
  organizer_invalid: '主办方提取不可靠，已回退为空，待官方原文重录',
  eligibility_invalid: '参赛对象提取到赛事介绍或校内范围，已回退为空，待官方原文重录',
  description_invalid: '比赛内容提取到附件残句、作品材料规格或空标题，已回退为空，待官方原文重录',
  schedule_invalid: '赛程说明提取到截断句，已回退为空，待官方完整安排',
  composite_track_fields: '组合赛事混用具体赛道的比赛内容、参赛对象或时间安排，已回退，须按分项分别核验',
  deadline_campus: '报名截止日期来自校内安排，已回退为空，待全国官方安排',
  accepted_after_verification: '该页面最终通过年份和赛事身份核验，并已保存来源',
  composite_catalog_entry: '学校 PDF 的组合赛事行需要分别检索分项，名称保持原样',
  no_verified_current_notice: '尚未核验到目标年度全国竞赛通知，不能将历史届次当作当年信息',
  identity_unresolved: '目录名称未检索到可核实的赛事官网或当年公告，需人工确认赛事全称、届次及是否仍为当年竞赛',
};

function issueLabel(issue) {
  const code = issue.reason || issue.code || 'unknown_error';
  if (/encoded data was not valid/.test(code)) return reasonLabels.encoding_error;
  if (/network_error:Error:/.test(code)) return reasonLabels.tls_error;
  if (/^http_404$/.test(code)) return reasonLabels.http_404;
  return reasonLabels[code] || `${issue.stage || '采集'}：${code}`;
}

async function main() {
  const competitions = await prisma.competition.findMany({
    where: { createdBy: 'u-demo', deletedAt: null, schoolRecognitionLevel: { in: ['A类', 'B类', 'C类'] } },
    include: {
      organizers: { where: { role: 'host' }, include: { organizer: true } },
      sources: true,
      stages: true,
      entries: true,
      fieldEvidence: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  if (competitions.length !== 71) throw new Error(`目录记录应为 71 条，实际为 ${competitions.length} 条。`);
  const reports = new Map(fs.readdirSync(outputDir).filter(file => /^cm\w+\.json$/.test(file)).map(file => {
    const report = JSON.parse(fs.readFileSync(path.join(outputDir, file), 'utf8'));
    return [report.id, report];
  }));
  const rows = competitions.map((row, index) => {
    const report = reports.get(row.id);
    const sourceUrls = new Set(row.sources.map(source => source.url));
    const eligibility = JSON.parse(row.eligibilityJson || '{}').eligibility;
    const currentFields = {
      比赛内容: row.description,
      主办机构: row.organizers.map(item => item.organizer.name).join('、'),
      参赛对象: eligibility,
      赛程说明: row.scheduleNote,
      报名截止: row.nearestDeadline,
      报名入口: row.signupUrl,
      官网或官方公告来源: row.sources.some(source => ['official_site', 'other'].includes(source.type)),
    };
    const missing = Object.entries(currentFields).filter(([, value]) => !value).map(([key]) => key);
    const issues = [...new Map((report?.warnings ?? []).map(issue => [`${issueLabel(issue)} ${issue.url ?? ''}`, issue])).values()];
    for (const issue of report?.result?.issues ?? []) {
      if (!issues.some(item => item.url === issue.url && item.reason === issue.reason) && !sourceUrls.has(issue.url)) issues.push(issue);
    }
    if (report?.dataStatus === 'no_new_fields' && !issues.some(issue => issue.reason === 'no_verified_current_notice')) {
      issues.push({ reason: 'no_verified_current_notice', stage: '核查结论' });
    }
    if (row.name === '中国校园戏剧节比赛') issues.push({ reason: 'identity_unresolved', stage: '赛事身份' });
    if (/[-—–]\s*[①②③④⑤⑥⑦⑧⑨⑩]|RoboMaster|RoboCon/.test(row.name)) {
      issues.push({ reason: 'composite_catalog_entry', stage: '目录结构' });
    }
    if (index + 1 === 44) issues.push({ reason: 'composite_track_fields', stage: '复核修正' });
    for (const correction of report?.corrections ?? []) issues.push({ reason: 'campus_source_overwrite', stage: '复核修正' });
    for (const rollback of report?.rollbacks ?? []) issues.push({ reason: rollback, stage: '复核修正' });
    return {
      index: index + 1,
      id: row.id,
      name: row.name,
      level: row.schoolRecognitionLevel,
      publishStatus: row.publishStatus,
      registrationStatus: row.registrationStatus,
      runId: report?.runId ?? null,
      runStatus: report?.status ?? 'not_run',
      currentFields,
      missing,
      sources: row.sources.filter(source => ['official_site', 'other'].includes(source.type)).length,
      evidenceFields: [...new Set(row.fieldEvidence.map(field => field.fieldName))],
      savedPages: report?.savedPages ?? [],
      officialSites: report?.officialSites ?? [],
      corrections: report?.corrections ?? [],
      rollbacks: report?.rollbacks ?? [],
      issues,
      issueSummary: [...new Set(issues.map(issueLabel))],
      issueLog: issues.map(issue => ({ stage: issue.stage ?? null, message: issue.message ?? null, reason: issue.reason ?? null, url: issue.url ?? null })),
      reportFile: `${row.id}.json`,
    };
  });
  const summary = {
    generatedAt: new Date().toISOString(),
    catalogCount: rows.length,
    gradeCounts: Object.fromEntries(['A类', 'B类', 'C类'].map(level => [level, rows.filter(row => row.level === level).length])),
    publishCounts: Object.fromEntries([...new Set(rows.map(row => row.publishStatus))].map(status => [status, rows.filter(row => row.publishStatus === status).length])),
    withAdditionalSources: rows.filter(row => row.sources > 0).length,
    withoutAdditionalSources: rows.filter(row => row.sources === 0).length,
    withSavedFields: rows.filter(row => row.evidenceFields.some(key => ['description', 'organizer', 'eligibility', 'schedule', 'nearestDeadline', 'signupUrl'].includes(key))).length,
    withIssues: rows.filter(row => row.issues.length || row.missing.length).length,
    noRun: rows.filter(row => row.runStatus !== 'completed').length,
    withMissingFields: rows.filter(row => row.missing.length > 0).length,
    fullyCoveredFields: rows.filter(row => row.missing.length === 0).length,
    fieldPresence: Object.fromEntries(['比赛内容', '主办机构', '参赛对象', '赛程说明', '报名截止', '报名入口', '官网或官方公告来源']
      .map(field => [field, rows.filter(row => Boolean(row.currentFields[field])).length])),
    issueCounts: Object.fromEntries([...new Set(rows.flatMap(row => row.issues.map(issue => issueLabel(issue))))]
      .map(label => [label, rows.filter(row => row.issues.some(issue => issueLabel(issue) === label)).length])),
  };
  fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify({ summary, rows }, null, 2));
  const lines = [
    '# 学校竞赛目录补全与问题清单',
    '',
    '- 核查日期：2026-11-16（Asia/Shanghai）',
    '- 目录范围：`createdBy=u-demo` 且学校认定为 A/B/C 的 71 条正式目录记录；不包含 12 条 verification 测试记录和 1 条 migration 聚合记录。',
    `- 当前状态：${summary.catalogCount} 项，A/B/C 分别为 ${summary.gradeCounts.A类}/${summary.gradeCounts.B类}/${summary.gradeCounts.C类}；${summary.withAdditionalSources} 项有新增官网/公告来源，${summary.withSavedFields} 项有已保存的采集字段依据。`,
    `- 覆盖情况：${summary.fullyCoveredFields} 项的本次七类核查字段均有值，${summary.withMissingFields} 项仍有缺项；未完成采集 ${summary.noRun} 项。完整不等于已发布，保留原审核状态。`,
    `- 各字段已有值：${Object.entries(summary.fieldPresence).map(([field, count]) => `${field} ${count}/71`).join('；')}。`,
    '- 含义：只写入带来源原文的字段。未公布、无法访问、年份未核实均不猜测；原审核/发布状态保持不变。',
    '',
    '## 缺失原因',
    '',
    '1. 原始学校 PDF 只含序号、竞赛名称和 A/B/C 认定等级，天然不含主办方、官网、参赛对象、比赛内容、赛程和报名入口。',
    '2. 旧数据只执行了目录提取；除蓝桥杯和全球校园人工智能算法精英大赛外，未逐条执行官网采集和字段确认。',
    '3. 本轮日志证实搜索超时/反爬、模型 503、robots 限制、站点访问校验、动态网页、PDF 无文字层、年份或赛事身份无法确认，均会造成字段留空。',
    '4. 目录中的组合赛事仍按 PDF 原行保留，未擅自拆成多个独立竞赛。',
    '',
    '## 问题分类汇总',
    '',
    ...Object.entries(summary.issueCounts).sort((left, right) => right[1] - left[1]).map(([label, count]) => `- ${label}：${count} 项（同一项可有多类问题）`),
    `- 尚未完成采集：${summary.noRun} 项`,
    '',
    '## 71 项逐项核查',
    '',
  ];
  for (const row of rows) {
    const present = Object.entries(row.currentFields).filter(([, value]) => value).map(([key]) => key);
    lines.push(`### ${row.index}. ${row.name}（${row.level}）`);
    lines.push(`- 已有：${present.join('、') || '仅学校目录名称和认定等级'}；新增来源 ${row.sources} 个；状态 ${row.publishStatus}/${row.registrationStatus}。`);
    lines.push(`- 仍缺：${row.missing.join('、') || '本次核查字段均已覆盖'}。`);
    lines.push(`- 当前值：${Object.entries(row.currentFields).filter(([, value]) => value).map(([key, value]) => `${key}=${typeof value === 'boolean' ? '已保存来源' : String(value)}`).join('；') || '无'}。`);
    const uniqueReasons = [...new Set(row.issues.map(issueLabel))];
    lines.push(`- 问题：${uniqueReasons.join('；') || '本轮未记录访问/提取异常'}。`);
    if (row.corrections.length) lines.push(`- 复核修正：${row.corrections.join('；')}。`);
    if (row.issues.length) {
      const examples = row.issues.filter(issue => issue.url).slice(0, 5).map(issue => `${issueLabel(issue)} ${issue.url}`);
      lines.push(`- 日志证据：${examples.join('；')}${row.runId ? `；runId=${row.runId}` : ''}。`);
    } else if (row.runId) lines.push(`- 日志证据：runId=${row.runId}。`);
    lines.push('');
  }
  lines.push('## 数据与日志位置', '',
    '- 单项采集结果：`artifacts/catalog-completion-20261116/<competitionId>.json`。',
    '- 完整机器可读报告：`artifacts/catalog-completion-20261116/summary.json`。',
    '- 原始智能体日志：`artifacts/runtime/agent-logs/agent-2026-11-16.jsonl`，按 runId 检索。',
    '- 修改前数据库备份：`artifacts/runtime/before-catalog-completion-20261116.db`。');
  fs.writeFileSync(path.join(root, 'COMPETITION_CATALOG_COMPLETION_REPORT.md'), lines.join('\n'));
  console.log(JSON.stringify(summary, null, 2));
}

main().finally(() => prisma.$disconnect());
