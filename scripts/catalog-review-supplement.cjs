require('../apps/api/node_modules/reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('../apps/api/node_modules/@prisma/client');
const { CompetitionService } = require('../apps/api/dist/services/competition.service');
const { AuditService } = require('../apps/api/dist/platform/audit.module');
const { directory, decisions, page } = require('./catalog-review-decisions.cjs');

const prisma = new PrismaClient();
const audit = new AuditService(prisma);
const service = new CompetitionService(prisma, audit, null);
const execution = JSON.parse(fs.readFileSync(path.join(directory, 'execution.json'), 'utf8'));
const supplementalFile = path.join(directory, 'supplemental-execution.json');
const counts = new Map(decisions.map(row => [row.index, row.pages.length]));

page(4, '/793/', [['scheduleNote', '第十五届2026“挑战杯”创业计划竞赛终审决赛已于2026年10月30日—11月2日在大连理工大学举行（组委会11月5日发布结果）。校省初赛原安排分别为5月底前、6月底前。', '10月30日至11月2日'] ], true);
page(25, '.pdf', [
  ['eligibility', '2026第19届参赛对象为全国普通高校2026年在籍本科生，含港澳台学生和来华留学生，其他限制按竞赛规程。', '2026 年（第19 届）中国大学生计算机设计大赛是由', '2026 年大赛分设'],
  ['scheduleNote', '2026第19届原通知：校省赛3—5月，5月30日为上推国赛作品数据截止；六个决赛现场分批安排7月17—21日、7月22—26日、7月27—31日、8月6—10日、8月11—15日、8月16—20日。各作品类别对应现场以原通知表为准，不设统一学生报名截止。', '大赛国赛共组合为6 个决赛现场', '附件1'],
], true);
page(28, '/11473', [['scheduleNote', '第九届作品展跨年赛程：2025年10月启动、2025年10月—2026年3月线上报名及提交作品；2026年4—5月省赛评审、5—6月国赛评审、7—8月系列活动。不得套用于后续届次。', '四、赛事赛程', '五、作品类别与要求']]);
page(32, 'http://www.ciscn.cn/', [['scheduleNote', '官网第十九届作品赛通知原安排2026年8月举办；官网第二十届创新实践能力赛另有入口，具体报名及赛期尚未核实。各届次、赛项不得混用。', '定于2026年8月举办'] ], true);
page(37, 'cnsoftbei.com/content-74', [['scheduleNote', '第十五届2026官方通知：报名阶段3月24日—7月20日；初赛作品提交暂定7月20日15:00，初赛评审拟7月，全国总决赛拟8月。原通知带“暂定/拟定”，实际调整以后续通知为准。', '(一)报名阶段', '四、'],
], true);
page(43, '.pdf', [
  ['eligibility', '第十二届物理实验竞赛（创新）参赛对象为全国各类高校2026年秋季学期在籍本（专）科学生，其他组队、获奖作品及国际赛道要求按通知执行。', '1．参赛对象为全国各类高等学校2026年秋季学期在籍本（专）科学生'],
  ['scheduleNote', '2026第十二届物理实验竞赛（创新）第一轮通知：5月15日前高校预赛报名，9月1—15日正式报名、上传资料和缴费；详细方案待第二轮通知确认，初评结果及决赛通知原定10月中下旬公布。以上不是校内4月30日截止。', '3. 各参赛高校在2026年5月15日前', '2. 进入决赛的作品'],
], true);
page(55, '.pdf', [['scheduleNote', '第九届团队现场赛：校赛2026年5—9月、省赛11月15日前完成；本科院校组全国决赛文本11月15日前提交，全国现场决赛/总决赛12月3—6日在上海。短视频赛英语/国际学生组校赛4—10月、省赛10月25日前、全国赛11月；德语/日语组全国赛11月。各组别分别执行。', '全国决赛文本评审环节', '2.比赛形式'] ], true);
page(60, 'isclab.org.cn/2026/', [
  ['organizer', '北京理工大学、中国兵工学会、教育部信息对抗技术专业虚拟教研室（2026线上挑战赛通知所列）', '8.1 主办单位', '8.2 承办单位'],
  ['scheduleNote', '2026 ISCC线上挑战赛三项：报名4月24日8:00—5月6日20:00；破阵夺旗校赛5月1—6日、区域赛5月9—15日、总决赛5月16—18日；无限擂台5月9—18日、数据安全5月1—18日。仅适用于线上挑战赛，特定赛区细则另定。', '4 竞赛时间', '5 竞赛模式'],
], true);

async function main() {
  if (fs.existsSync(supplementalFile)) throw new Error('已有补充执行记录，禁止重复写入');
  const additions = decisions.flatMap(row => row.pages.slice(counts.get(row.index)));
  if (additions.length !== 8 || additions.flatMap(source => source.fields).length !== 11) {
    throw new Error('补充原文引文不完整，停止写入');
  }
  const report = { at: new Date().toISOString(), rows: [] };
  for (const decision of decisions) {
    const additions = decision.pages.slice(counts.get(decision.index));
    if (!additions.length) continue;
    const previous = execution.rows.find(row => row.id === decision.id);
    const row = await prisma.competition.findUniqueOrThrow({ where: { id: decision.id } });
    if (row.versionNo !== previous.after.versionNo) throw new Error(`记录${decision.index}已被其他操作更新，停止补充`);
    let expectedVersion = row.versionNo;
    for (const source of additions) {
      const result = await service.saveDiscoveryFields(row.id, expectedVersion, source, 'u-demo', ['editor', 'reviewer', 'admin']);
      expectedVersion = result.versionNo;
      report.rows.push({ index: decision.index, id: row.id, name: row.name, url: source.url,
        fields: source.fields, versionNo: expectedVersion, status: 'completed' });
      fs.writeFileSync(supplementalFile, JSON.stringify(report, null, 2));
    }
    await prisma.reviewRecord.create({ data: { competitionId: row.id, action: 'comment', reviewer: 'u-demo',
      comment: '审核补采：已补充核实官方原通知/附件的赛程，并明确届次、赛道、原计划或暂定范围；仍不推断未知全国统一截止。' } });
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(supplementalFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ competitions: new Set(report.rows.map(row => row.id)).size,
    fields: report.rows.flatMap(row => row.fields).length, status: 'completed' }));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
