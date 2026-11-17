const fs = require('node:fs');
const path = require('node:path');

const directory = path.resolve(__dirname, '../artifacts/catalog-review-20261116');
const audit = JSON.parse(fs.readFileSync(path.join(directory, 'audit.json'), 'utf8'));
const texts = fs.readdirSync(path.join(directory, 'source-text')).map(file =>
  JSON.parse(fs.readFileSync(path.join(directory, 'source-text', file), 'utf8')));
const failures = [];
const decisions = audit.rows.map(row => ({
  index: row.index, id: row.id, name: row.name, decision: 'publish', pages: [],
  reason: '核对已有来源及实质字段；保留缺项，不将未知日期推断为报名中。',
  dateScope: row.hasDates ? '已有日期，按原通知适用范围保留' : '本届全国日期未核实',
  rejectFields: [], clearDeadline: false,
}));

function set(index, data) {
  Object.assign(decisions[index - 1], data);
}

function locate(text, anchor, offset = 0) {
  const direct = text.indexOf(anchor, offset);
  if (direct >= 0) return direct;
  const positions = [];
  let normalized = '';
  for (let position = offset; position < text.length; position += 1) {
    if (!/\s/.test(text[position])) {
      normalized += text[position];
      positions.push(position);
    }
  }
  const found = normalized.indexOf(anchor.replace(/\s/g, ''));
  return found < 0 ? -1 : positions[found];
}

function page(index, part, specs, official = false) {
  const source = texts.find(item => item.index === index && item.status === 'ok' && item.url === part)
    ?? texts.find(item => item.index === index && item.status === 'ok' && item.url.includes(part));
  if (!source) throw new Error(`缺少已访问原文：${index} ${part}`);
  const fields = specs.map(([key, value, anchor, end]) => {
    const start = locate(source.text, anchor);
    if (start < 0) { failures.push(`原文锚点缺失：${index} ${anchor}`); return null; }
    const finish = end ? locate(source.text, end, start + 1) : source.text.indexOf('\n', start);
    if (end && finish < 0) { failures.push(`引文终点缺失：${index} ${end}`); return null; }
    const quote = source.text.slice(start, finish < 0 ? undefined : finish).trim();
    if (!quote || quote.length > 7000) throw new Error(`引文范围错误：${index} ${key}`);
    return { key, label: key, value: value ?? quote, quote };
  }).filter(Boolean);
  decisions[index - 1].pages.push({ url: source.url, title: source.title, kind: 'notice', scope: 'general',
    year: null, edition: null, excerpt: source.text.slice(0, 300), attachments: [], fields, official });
}

function priorPage(index, urlPart, specs) {
  const row = audit.rows[index - 1];
  const report = JSON.parse(fs.readFileSync(path.join(directory, '../catalog-completion-20261116', `${row.id}.json`), 'utf8'));
  const source = report.result.pages.find(item => item.url.includes(urlPart));
  if (!source) throw new Error(`缺少历史原文：${index}`);
  const fields = specs.map(([key, value, originalKey]) => {
    const original = source.fields.find(field => field.key === (originalKey ?? key));
    if (!original?.quote) throw new Error(`缺少历史引文：${index}`);
    return { key, label: key, value, quote: original.quote };
  });
  decisions[index - 1].pages.push({ ...source, fields, tracks: undefined, official: true });
}

set(1, { clearDeadline: true, rejectFields: ['nearestDeadline', 'schedule'], dateScope: '河南城建学院校内通知；2025—2026跨年',
  reason: '原有蓝桥杯父记录与学校目录同名，保留关联结构。通知正文第十五/第十七届不一致；14:00为学院通知口径，不作为全国统一截止。跨年日期不改写年份。' });
page(1, 'huuc.edu.cn', [
  ['competitionContent', '蓝桥杯软件和信息技术专业人才赛事，通知列有软件赛、电子赛、人工智能赛、数字科技创新赛、视觉艺术设计赛及专项赛；具体科目以对应届次官网通知为准。', '二、比赛项目', '1、报名截止时间'],
  ['scheduleNote', '河南城建学院校内通知参考：报名截止2025年12月15日14:00，比赛2026年4月11—12日；通知存在届次表述不一致，非全国统一报名截止。', '1、报名截止时间', '3、报名方式'],
]);
set(2, { reason: '教育部2026主通知核验通过，9月25日12:00为全国报名截止；萌芽赛道资格不扩展到全赛事。', dateScope: '全国主通知' });
page(3, 'www.tiaozhanbei.net/', [
  ['competitionContent', '“挑战杯”包含课外学术科技作品竞赛和创业计划竞赛两个独立项目，交叉轮流开展；本记录为课外学术科技作品竞赛，未将2026创业计划赛赛程移植到本记录。', '这两个项目的全国竞赛交叉轮流开展，每个项目每两年举办一届。'],
], true);
set(3, { reason: '官网赛事身份已确认；当前首页混有创业赛动态，本届科技作品赛报名及赛程未核实，日期留空。' });
page(4, '/727/', [
  ['organizer', '共青团中央、教育部、人力资源社会保障部、中国科协、中国科学院、中国社会科学院、中国工程院、全国学联、辽宁省人民政府', '主办单位'],
  ['competitionContent', '第十五届“挑战杯”中国大学生创业计划竞赛，主体赛事设置先进制造、新一代信息技术、生物医药与健康科技、新能源新材料、现代农业与食品科技、新消费与文化创意、现代服务与社会治理、国际交流合作8个赛道。', '竞赛侧重考量作品科技创新攻关与商业模式创新成效'],
  ['eligibility', '2026年6月1日前正式注册的国内全日制非成人教育普通高校专科、本科、硕博及职业本科、高职高专在校生；不含在职研究生；国外学生及中外联合组队按通知要求。', '2026 年 6 月 1 日以前'],
  ['scheduleNote', '2026年主通知安排：校级初赛5月底前，省级复赛6月底前；全国决赛原计划11月前在大连理工大学举办，实际安排以组委会后续通知为准。各校、省推报截止分别确定。', '（二）赛程安排', '（三）奖项设置'],
], true);
set(4, { dateScope: '全国主通知阶段安排（原计划）' });
page(5, 'scut.edu.cn', [
  ['organizer', '中央社会工作部、共青团中央等部门（学校转载通知所列）', '本届大赛由中央社会工作部'],
  ['competitionContent', '第八届中国青年志愿服务项目大赛和公益创业赛，主题为“青年志愿服务与基层社会治理”，设项目大赛、公益创业赛两个赛道。项目类别含乡村振兴、社区治理、科技创新与科学普及等14类。', '本届大赛由中央社会工作部', '三、申报范围'],
  ['eligibility', '项目大赛面向正在实施且连续实施不少于2年的青年志愿服务项目；依法登记的志愿服务组织和经社区或单位同意成立的志愿服务团体可申报。公益创业赛另按对应赛道通知。', '（一）项目大赛', '（二）公益创业赛'],
]);
set(5, { reason: '原网站证书域名不匹配；改用团中央平台及高校通知核实基本信息。10月30日至11月3日是公示期，5月10日是学校推报，均不作为全国报名截止。' });
set(6, { reason: '教育部第八届艺术展演主通知核验通过；2026年校省展演、2027年全国汇演为跨年安排。', dateScope: '全国分阶段安排，2026—2027' });
{
  const row = audit.rows[6];
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'research-fallback', `${row.id}.json`), 'utf8'));
  const source = report.pages.find(item => item.url === 'https://icpc.global/' && item.excerpt.includes('algorithmic programming contest'));
  if (!source) throw new Error('缺少ICPC官方稳定介绍');
  decisions[6].pages.push({ ...source, fields: [{ key: 'competitionContent', label: '比赛内容',
    value: 'ICPC为面向大学生的算法程序设计竞赛。各区域站点分别发布邀请函与报名指南，不采用公告发布日期作为比赛日期。',
    quote: 'The International Collegiate Programming Contest is an algorithmic programming contest for college students.' }], official: true });
}
set(7, { reason: '已核实ICPC官方介绍与北京总部站点。各站邀请函多为图片/附件，尚未解析出完整赛程，保留日期未知。' });
set(8, { dateScope: '全国赛2026年9月10日18时—13日20时；9月7日20时为报全国组委会截止', reason: '全国组委会报名与校内截止不同；校内8月10日不替代现有全国报送日期。' });
set(9, { rejectFields: ['schedule'], dateScope: '2026模拟电子系统设计专题赛', reason: '2026通知为专题赛，非全部电子设计赛的统一赛程；保留专题赛资格，补明赛项范围。' });
page(9, '/353', [['scheduleNote', '2026年全国大学生电子设计竞赛模拟电子系统设计专题赛：赛区赛暨选拔赛2026年7月29日8:00—8月1日20:00；仅适用于该专题赛。', '2026年7月29日']]);
page(10, '/0915/', [
  ['competitionContent', '第十二届全国大学生机械创新设计大赛分2026年作品创新设计常规赛和2027年作品数字孪生设计挑战赛两个赛季。', '自第十二届大赛开始'],
  ['scheduleNote', '常规赛全国现场决赛已于2026年7月17—20日在哈尔滨工业大学举行；2027数字孪生设计挑战赛季于2026年9月启动，具体报名截止见第5号通知附件，当前尚未核实。', '2026 年 7 月 17 日', '第十二届全国大学生机械创新设计大赛2027年数字孪生设计挑战赛（第5号通知）PDF版.zip'],
], true);
set(10, { dateScope: '第十二届2026常规赛与2027挑战赛分开' });
for (const [index, reason] of [
  [11, '两轮检索未取得可验证的本届全国通知；结果实体不匹配或页面无正文，保留草稿。'],
  [15, '搜索到电子科技大学相关通知，但访问超时/正文身份校验失败/连接重置；未核实全国赛项与日期，保留草稿。'],
  [16, '主办来源证书过期，未降低TLS校验；其他结果未形成有效证据，保留草稿。'],
  [39, '已找到北京邮电大学2026通知，但页面返回HTTP 412；百科/聚合转载不替代原文，保留草稿。'],
  [44, '找到的西南交通大学通知为2025年校内选拔，不作为2026全国时间，保留草稿。'],
  [48, '官网依赖JavaScript、正文为空或身份未确认；暂无可靠本届实质字段，保留草稿。'],
  [49, '官网省选通知附件位于网盘，决赛通知访问超时；只有标题和入口不足以审核发布，保留草稿。'],
  [72, '目录名称与“中国校园戏剧节”等称谓存在实体匹配问题；两轮检索无可确认本届通知，退回草稿。'],
]) set(index, { decision: 'hold', reason, dateScope: '未核实，不填造日期' });
page(12, 'about_intrs2', [
  ['eligibility', null, '全国各类高等院校在校全日制大学生、研究生、港澳台籍学生、外籍留学生均可参加。'],
  ['competitionContent', '第18届大广赛按统一命题创作原创广告作品，类别含平面、视频、动画、互动等，规格按2026年4月1日修订参赛指南执行。', '三、作品类别', '四、作品规格'],
  ['scheduleNote', '第18届线上作品提交2026年5月10日—6月12日16:00；营销创客单元海选提交3月10日—4月10日22:00。赛区线下截稿另定；7月5日为赛区向全国报送截止。', '六、作品提交及报送时间', '七、作品报送流程'],
], true);
set(12, { dateScope: '作品提交及营销创客单元分开', reason: '原采集命中教师AIGC研修班；已补官方学生参赛指南，7月5日赛区报送期限不作为学生报名截止。' });
page(13, 'caa.org.cn', [
  ['organizer', '中国自动化学会（2020年起）', '2020 年起主办单位转为中国自动化学会。'],
  ['competitionContent', '全国大学生智能汽车竞赛面向大学生开展工程实践，当前体系分竞速赛、创意赛和室外赛；各类别分别公布规则及赛程。', '当前竞赛构建了', 'IVFC 自'],
], true);
set(13, { reason: '官方介绍已补；历史表仅含2020—2025届次，2026室外附件404，未改写历史赛程年份。' });
set(14, { reason: '第十六届2026赛事自2025年报名，跨年正常；12月31日为原定截止且注明可延长，后续调整未核实。', dateScope: '第十六届2025—2026；原定截止' });
page(14, 'bs.gznc.edu.cn', [['scheduleNote', '第十六届报名原定2025年10月20日—12月31日（原文注明可能适当延长）；全国决赛安排2026年7月10日—8月10日，具体赛项及延期以组委会通知为准。', '1.参赛队报名时间']]);
set(17, { clearDeadline: true, rejectFields: ['nearestDeadline'], reason: '10月4日为中国海洋大学英语综合能力、笔译校赛截止，非全部赛项的全国截止；保留已核实2026外语能力大赛内容。', dateScope: '中国海洋大学校赛参考；英语赛项' });
page(17, 'ouc.edu.cn', [['scheduleNote', '中国海洋大学校赛参考：2026年10月4日为英语综合能力、笔译比赛校内报名截止，10月11日为校赛；不适用于全部外研社英语系列赛或全国统一报名。', '10月4日']]);
set(18, { dateScope: '2026—2027创意/定向主题分赛道截止', reason: '主办学会官方通知核验通过；创意征集11月27日、定向主题次年3月5日分开保存。' });
page(19, 'curc.cn', [
  ['organizer', '全国大学生机器人大赛组织委员会', '主办单位：全国大学生机器人大赛组织委员会'],
  ['competitionContent', '全国大学生机器人大赛目前包含ROBOCON、RoboMaster两大竞技赛项，面向大学生开展机器人技术创新与工程实践；两项赛事分别公布规则、报名和赛程。', '是一项中国大学生机器人技术创新', '大赛影响'],
], true);
set(19, { reason: '已核对全国大学生机器人大赛官网；排除国外会议robocon.io与韩国企业robocon.ai的同名无关结果。' });
set(20, { clearDeadline: true, rejectFields: ['nearestDeadline'], dateScope: '第十七届不同组别截止', reason: '10月31日仅本科组，研究生/留学生组11月15日；拆分说明，不扩展为全赛事截止。' });
page(20, 'stxy.gufe.edu.cn', [
  ['organizer', '教育部高等学校统计学类专业教学指导委员会、中国商业统计学会', '教育部高等学校统计学类专业教学指导委员会与中国商业统计学会'],
  ['scheduleNote', '第十七届赛事分组报名截止：本科组2026年10月31日24:00；研究生组、留学生组2026年11月15日24:00。校内组织要求以本校通知为准。', '本科组报名截止日期为', '注:'],
]);
page(21, 'http://www.chengtudasai.com/', [
  ['organizer', '原教育部高等学校工程图学课程教学指导委员会、中国图学学会制图技术专业委员会、中国图学学会产品信息建模专业委员会', '“高教杯”全国大学生先进成图技术与产品信息建模创新大赛由'],
  ['competitionContent', '“高教杯”成图大赛围绕先进成图技术、产品信息建模等图学实践，培养图学能力和创新意识。2026第十九届具体赛程见分轮通知附件，当前附件访问受限。', '大赛以培养学生的工匠精神'],
], true);
set(21, { reason: '官方基本介绍已核实；第五、六轮PDF均HTTP 406，未把通知发布日期当比赛日期。' });
set(22, { clearDeadline: true, rejectFields: ['nearestDeadline'], dateScope: '数字化设计与制造分赛', reason: '8月31日为数字化设计与制造分赛，不能作为全国三维数字化创新设计全部赛项统一截止。' });
page(22, 'shiep.edu.cn', [
  ['competitionContent', '本条为全国三维数字化创新设计大赛系列；已核验2026第19届数字化设计与制造分赛通知，其报名与赛程仅适用于该分赛。', '数字化设计与制造大赛'],
  ['scheduleNote', '2026第19届数字化设计与制造分赛报名截止2026年8月31日；其他赛项按各自通知。', '8月31日'],
]);
page(23, 'NoticeDetail?id=2431', [
  ['competitionContent', 'CIMC“西门子杯”中国智能制造挑战赛面向智能制造工程人才培养，涉及智能软硬件、智能产品、工业自动化控制、工业网络及全生命周期数字化等技术应用。', '作为国内智能制造领域规模最大的赛事，涉及'],
  ['scheduleNote', '2026第二十届官网注册组队报名：2026年3月1日—5月31日。各赛项比赛时间另按通知。', '请参赛队伍于'],
], true);
set(23, { dateScope: '全国注册组队报名' });
set(24, { clearDeadline: true, rejectFields: ['nearestDeadline'], dateScope: '2026第十七届；截止口径待核', reason: '高校通知存在3月20日16:00、3月31日两种报名截止口径；剔除未确认的统一截止，保留赛事内容和资格。' });
page(24, 'sues.edu.cn', [['scheduleNote', '第十七届2026赛事：已采通知报名截止有3月20日16:00与3月31日两种口径，尚未核实主办方延期通知。各类别赛程及最终截止以组委会通知为准。', '报名截止时间为']]);
set(25, { reason: '2026年11个大类内容已核实；4月14日/4月30日为学校或地区报送口径，不填全国统一截止。' });
page(26, 'sci.upc.edu.cn', [
  ['competitionContent', '中国高校计算机大赛为系列赛事；其中2026大数据挑战赛以实际数据为基础，考查数据分析处理算法及技术应用。各分项独立发布规则和时间。', '2026 中国高校计算机大赛——大数据挑战赛', '一、参赛对象'],
  ['scheduleNote', '2026大数据挑战赛：报名与组队3月26日—7月15日；该时间仅对应大数据挑战赛，其他分赛见各自通知。', '报名 & 组队'],
]);
set(26, { dateScope: '大数据挑战赛分项' });
set(27, { rejectFields: ['schedule'], dateScope: '第十七届鸿蒙专项赛；第十八届赛道另存', reason: '5月30日为第十七届鸿蒙应用开发专项赛决赛；保留已有第十八届赛道资料，分届次说明。' });
priorPage(27, '/1924', [['scheduleNote', '第十七届鸿蒙应用开发专项赛全国总决赛：2026年5月30日9:00—13:00。该日期不适用于全部赛项；第十八届赛道与报名信息见本条已有赛道资料。']]);
page(28, '/11473', [
  ['organizer', '米兰设计周—中国高校设计学科师生优秀作品展组委会', '米兰设计周 -中国高校设计学科师生优秀作品展组委会'],
  ['competitionContent', '米兰设计周—中国高校设计学科师生优秀作品展采取赛区制，各省级赛区组织收集、评审并推荐作品参加全国评审。具体作品类别及参赛要求以本届通知为准。', '本次活动采取赛区制'],
]);
set(28, { reason: '已核验高校转载与官方登录入口；保留当前有效milan-aap.org.cn地址，不恢复含“进行校内报名”的历史坏链接。' });
set(29, { clearDeadline: true, rejectFields: ['nearestDeadline', 'schedule'], dateScope: '地区/分赛项参考', reason: '4月19日及报名链接对应西北区，5月30日为分赛项初定时间；不设全赛事截止。' });
page(29, 'nepu.edu.cn', [['competitionContent', '全国大学生光电设计竞赛由中国光学学会主办，面向光电及相关专业学生开展综合知识应用与科研实践；各赛区、赛道独立安排报名。', '全国大学生光电设计竞赛是由中国光学学会主办']]);
set(30, { dateScope: '第十届全国报名2026年1月—3月31日', reason: '高校转发的第十届报名时间与资格一致，保留原字段。' });
set(31, { clearDeadline: true, rejectFields: ['nearestDeadline'], dateScope: '中国地质大学校内参考', reason: '3月16日是校内QQ群报名截止；保留金相磨制、抛光、浸蚀和观察内容，不升格全国日期。' });
page(31, 'cug.edu.cn', [['scheduleNote', '中国地质大学校内选拔参考：2026年3月16日为校内报名截止；4月校赛、5月省赛选拔、7月国赛的原通知安排仅作参考，具体以组委会后续通知为准。', '2026年3月16号']]);
page(32, 'ciscn.cn/', [
  ['organizer', '中国信息安全测评中心、教育部高等学校网络空间安全专业教学指导委员会', '中国信息安全测评中心和教育部高等学校网络空间安全专业教学指导委员会联合主办'],
  ['competitionContent', '全国大学生信息安全竞赛包含作品赛、创新实践能力赛等。官网同时列有已结束的第十九届作品赛与第二十届创新实践能力赛，须按届次、赛项分别查看报名通知。', '第二十届全国大学生信息安全竞赛（创新实践能力赛）', '最新公告'],
], true);
set(32, { reason: '官网不同届次并列，已补赛事类别与组织机构，未将旧届时间移植为新届日期。' });
set(33, { clearDeadline: true, rejectFields: ['nearestDeadline'], dateScope: '6月20日届次冲突，未采用', reason: '转载标题第十四届、正文第十三届不一致，6月20日暂不作为2026统一截止；仅保留稳定主办、资格和内容。' });
page(33, 'news/pageinfo', [['competitionContent', 'NCDA设非命题、产教融合/创新创业、公益三个赛道，涵盖视觉传达、动画视频、交互、产品等数字艺术设计方向。具体本届赛题及日期待官网核验。', '各类设计作品，设立']]);
set(34, { clearDeadline: true, rejectFields: ['nearestDeadline', 'schedule'], dateScope: '长春工程学院校内选拔', reason: '11月25日报名及11月29日比赛为长春工程学院校内选拔，非全国周培源竞赛统一日期。' });
page(34, 'ccit.edu.cn', [['scheduleNote', '长春工程学院校内选拔参考：2026年11月25日报名截止，11月29日18:00—20:00比赛。全国周培源竞赛报名和赛期尚未核实。', '报名时间：2026年11月', '六、报名方式']]);
set(35, { clearDeadline: true, rejectFields: ['nearestDeadline', 'schedule'], dateScope: '精雕杯毕业设计分项；文华学院校赛', reason: '4月25日为文华学院校赛报名；5月29—30日为第九届“精雕杯”毕业设计分项决赛，均不设为全系列统一截止。' });
page(35, 'thepaper.cn', [
  ['competitionContent', '中国大学生机械工程创新创意大赛为系列赛事。已核验的“精雕杯”毕业设计大赛是中国机械工程学会主办的机械类专业毕业设计竞赛分项。', '中国大学生机械工程创新创意大赛“精雕杯”毕业设计大赛'],
  ['scheduleNote', '第九届“精雕杯”毕业设计大赛分项全国决赛：2026年5月29—30日，吉林大学；不代表其他机械工程创新创意赛项。', '2026年5月29'],
]);
set(36, { clearDeadline: true, rejectFields: ['nearestDeadline', 'schedule'], dateScope: '校内选拔及专项赛', reason: '3月26日为文华学院校赛；7月报名亦校内；8月22—23日为专项赛，清除全赛事截止。' });
page(36, 'hbu.cn', [['scheduleNote', '河北大学通知所述专项赛：2026年8月22—23日；校内报名2026年6月27日—7月10日。上述日期仅供该校选拔及该专项赛参考，非全赛事统一报名。', '2026 年 8 月 22']]);
page(37, 'cnsoftbei.com/content-74', [['competitionContent', '“中国软件杯”大学生软件设计大赛以产业需求为导向，促进产教融合、科教融汇；参赛对象按普通高校及职业教育组别和赛题要求执行。', '第十五届"中国软件杯"大学生软件设计大赛', '二、 参赛对象'] ], true);
set(38, { rejectFields: ['description'], reason: '教育部主办、主赛道与职业院校分赛道内容已核验；清理原简介尾部误带的“五、大赛相关平台”标题。' });
page(38, 'yangtzeu.edu.cn', [['competitionContent', '2026中美青年创客大赛以“共创未来”为主题，围绕可持续发展领域利用数字技术开展创新作品设计，分主赛道和职业院校分赛道。', '2026年中美青年创客大赛分为']]);
set(40, { clearDeadline: true, rejectFields: ['nearestDeadline', 'description'], dateScope: '湖南工业大学校赛参考', reason: '1月27日23:59为湖南工业大学校赛截止；原120分钟答题简介也是校赛口径，改为全国赛道信息。' });
page(40, 'hut.edu.cn', [
  ['competitionContent', '第十三届大学生新一代信息通信科技大赛（原“大唐杯”）设工程实践赛、产教融合5G+创新应用赛、ICT基础通识赛3个赛道。', '第十三届 “信科赛”包含3个赛道'],
  ['scheduleNote', '湖南工业大学校赛参考：2026年1月27日23:59报名截止，1月28日校赛；全国及其他赛区日期按对应通知。', '1、报名截止时间'],
]);
set(41, { clearDeadline: true, rejectFields: ['nearestDeadline', 'description'], dateScope: '第十一届各赛道分别报名', reason: '10月26日仅昇腾AI算子开发赛道资格赛截止，不能覆盖华为ICT全部赛道；替换空泛简介。' });
page(41, 'bwu.edu.cn', [
  ['competitionContent', '华为ICT大赛设实践、挑战、编程、创新、昇腾AI算子开发、精英等赛道，参赛规则、组队及资格赛时间须分别核对。', '华为ICT大赛'],
  ['scheduleNote', '第十一届中国赛区不同赛道参考：实践赛/挑战赛报名截至2026年10月31日，编程赛/创新赛11月30日，昇腾AI算子开发赛10月26日，精英赛11月15日；各赛道以官方最终安排为准。', '10月31日'],
]);
page(42, '/1014/5284', [
  ['competitionContent', '全国大学生嵌入式芯片与系统设计竞赛设芯片应用、芯片设计、FPGA创新设计三个独立赛道。FPGA赛道使用指定开发平台进行开放式自主数字系统设计。', '全国大学生嵌入式芯片与系统设计竞赛设芯片应用赛道'],
  ['eligibility', 'FPGA创新设计赛道分本科生组、研究生组，每队不超过3人；其他赛道按对应通知。', '竞赛分本科生组和研究生组'],
  ['scheduleNote', '2026 FPGA创新设计赛道：报名7月6日—9月22日24:00，作品提交11月4日18:00，决赛11月20—22日。仅适用该赛道。', '竞赛报名时间', '官方网站'],
]);
set(42, { dateScope: 'FPGA创新设计赛道', reason: '补采哈工大深圳通知成功，三条赛道独立，未建立全赛事统一截止。' });
set(43, { rejectFields: ['description'], reason: '原简介混入西南石油大学两校区推荐题目；改为明确创新赛道类别，校赛4月30日不作全国截止。' });
page(43, 'physics.hit.edu.cn', [['competitionContent', '全国大学生物理实验竞赛（创新）设置命题类创新作品、自选课题类创新作品及国际赛道等参赛类别；学校推荐题目、选拔名额和校内截止不代表全国统一要求。', '命题类创新作品']]);
page(45, 'dlut.edu.cn', [['competitionContent', '全国高校商业精英挑战赛包含多个分项。已核验2026创新创业竞赛创业研究专题赛道，以“人本创业”为统一主题、自主选题撰写学术论文，面向全日制在校大学生（含研究生、本科及高职高专）。', '全国高校商业精英挑战赛创新创业竞赛创业研究专题赛道主要面向']]);
set(45, { reason: '补充已核验创新创业竞赛创业研究专题内容，不能将其资格/赛程无差别扩展到五类商业赛项。' });
page(46, 'xcbds.com', [
  ['organizer', '高等学校国家级实验教学示范中心联席会经管学科组、中国陶行知研究会', '“学创杯”全国大学生创业综合模拟演训活动是由'],
  ['competitionContent', '“学创杯”使用《创业之星》《营销之道》《理财之道》等平台，模拟企业经营决策、营销和财务管理，培养创业与综合管理能力；具体2026赛项通知另行核验。', '该项活动主要采用'],
], true);
set(46, { reason: '官网活动介绍成功补录；通知正文部分未通过身份校验，未猜测报名日期。' });
page(47, '/gedou/', [['competitionContent', '中国高校智能机器人创意大赛以问题提出、解决方案、技术创新和后期孵化形成机器人创新实践链条；已核验官网稳定介绍，具体本届赛项规则及赛程见各分区通知。', '大赛以“更好、更快、更强”为主题', '高校参赛积极性'] ], true);
set(47, { reason: '官网介绍已核实。首届2017年主办信息未冒充2026主办名单；规则文件无已核准时间，不填造日期。' });
set(50, { reason: '节能减排作品与资格已核验；3月26日等为学校选拔，未填为全国统一截止。' });
page(51, 'i21st.cn', [
  ['eligibility', null, '国家承认的具有高等学历教育招生资格的普通高等学校在校本、专科学生均可报名参加'],
  ['competitionContent', '大学组英语演讲赛事，按已备演讲主题自拟题目并提交演讲视频，后续地区赛和全国赛按通知进行。', '上传要求：选手根据已备演讲主题'],
], true);
set(51, { dateScope: '2026大学组，10月国赛为原通知拟定', reason: '官方大学组通知核验通过；保留拟定日期精度，不改成确定时间。' });
set(52, { clearDeadline: true, rejectFields: ['nearestDeadline'], dateScope: '创新赛道报名参考', reason: 'iCAN不同赛道可能独立报名，8月31日仅按已采通知覆盖范围保存，不设全赛事统一截止。' });
page(52, 'cqie.edu.cn', [['scheduleNote', '2026 iCAN已核验通知所述报名时间为4月1日—8月31日，创新赛道报名资料见对应通知；其他赛道另行核验。', '1.报名时间']]);
page(53, 'dsjs.html', [
  ['organizer', '中国工商银行股份有限公司', '主办单位：中国工商银行'],
  ['eligibility', '境内外高等院校在校本科生、硕士和博士研究生可参赛；具体组队人数按本届规则。', '境内外高等院校在校本科生'],
  ['competitionContent', '“工行杯”围绕金融科技应用、银行产品与服务场景提出创新作品，参赛方向涵盖科技金融、绿色金融、普惠金融、养老金融、数字金融等。', '科技金融'],
], true);
page(53, 'id=131', [['scheduleNote', '第十七届2026作品提交截止：大陆赛区10月8日24:00；港澳台赛区10月19日24:00。省赛10月、全国半决赛11月、总决赛12月为启动通知阶段安排。', '10月8日'] ], true);
set(53, { dateScope: '大陆/港澳台作品提交期限分开', reason: '官网启动通知与更新后的作品提交截止均核实，提交截止不冒充统一报名截止。' });
set(54, { reason: '教育部中华经典诵写讲主通知及四赛项身份核验通过；各省组织和赛项日期分别核验，不采用学校截止。' });
page(55, '.pdf', [
  ['organizer', '上海外国语大学', '主办单位：上海外国语大学'],
  ['competitionContent', '第九届“外教社杯”比赛分团队现场赛与短视频大赛，设置中国学生本科院校、职业院校及国际学生等不同组别，组别和规则按章程分别执行。', '四、大赛形式', '职业'],
  ['scheduleNote', '第九届短视频大赛：中国学生英语组、国际学生组校赛2026年4—10月，省赛10月25日前完成，全国赛11月；德语组、日语组校赛4—10月，全国赛11月。团队现场赛另按章程，不设统一报名截止。', '三、赛程安排\n（一）中国学生英语组', '四、作品内容要求'],
], true);
set(55, { dateScope: '第九届短视频赛；不覆盖团队现场赛', reason: '完整官方38页章程已解析；9月下旬直通通道不作为全部大赛截止。' });
set(56, { reason: '高校通知中的算法任务、语言及赛制已核验；未取得可靠全国报名日期，日期留空。' });
page(57, '/11730', [
  ['organizer', '全国工业设计一流专业建设协同创新平台、广东省本科高校工业设计专业教学指导委员会', '全国大学生工业设计大赛是由'],
  ['competitionContent', '2026第八届大赛主题“AI·ài·@i”，作品分智慧与体验、服务与系统、文化与社会、时尚与生活、健康与环保五类，须提交原创设计作品。', '四、 大赛类别', '五、 大赛赛程'],
  ['eligibility', '普通高校全日制在校大学生，包括研究生、本科及高职高专；以所在院校为单位集体报名，鼓励跨学科、跨专业。', '六、 参赛对象', '七、 报名方式'],
  ['scheduleNote', '2026第八届官网在线注册报名：2026年5月26日—6月30日。省赛及作品提交安排见各赛区通知；安徽8月25日校赛提交时间不作为全国截止。', '2026年5月26日—6月30日'],
]);
set(57, { dateScope: '全国注册报名；地区作品提交另定' });
page(58, 'tongji.edu.cn', [
  ['competitionContent', '全国大学生计算机系统能力大赛分智能计算创新、智能系统创新、CPU设计、编译系统、操作系统、数据库系统六个赛道，考查计算机系统设计、分析、优化与应用能力。', '大赛共分为六个赛道'],
  ['eligibility', '资格依赛道区分：智能系统创新、CPU、数据库等主要面向本科生；编译挑战、操作系统功能挑战可有研究生等，组队及跨校限制须查各赛道规则。', '二\n赛道设置与参赛对象', '三\n关于报名'],
  ['scheduleNote', '2026报名：智能系统创新赛3月9日—5月27日；CPU设计赛3月25日—6月20日；操作系统赛3月18日—5月28日。智能计算、编译、数据库启动日期在原通知为预计，须查各自后续通知。', '三\n关于报名', '四\n奖项设置'],
]);
set(58, { dateScope: '六赛道分别报名' });
page(59, 'shiep.edu.cn', [
  ['competitionContent', '物联网设计竞赛允许按合作伙伴技术命题或自拟主题进行设计，提交设计方案和实物演示视频，分赛区选拔后进入全国总决赛。', '参赛队也可以自拟竞赛主题报名参赛。'],
  ['eligibility', '普通高校全日制学生，包括本科、研究生或混合组队；另设高职赛道。不得跨校组队，每队不超过4名学生、2名指导教师。', '三、 参赛对象', '四、 报名流程'],
  ['scheduleNote', '2026第十三届：报名表线上提交6月15日截止；完整设计方案与演示视频7月27日截止；各分赛区8月20日前完成决赛，全国总决赛原定8月20—31日。', '4. 2026年6月15日', '（二）赛区'],
]);
set(59, { dateScope: '全国报名表与作品提交分别标注' });
page(60, 'isclab.org.cn/2026/', [
  ['competitionContent', 'ISCC赛项含破阵夺旗、无限擂台、数据安全、博弈对抗、创新作品、智能安全等；其中破阵夺旗、无限擂台、数据安全为线上挑战赛。', 'ISCC赛项包括'],
], true);
set(60, { reason: '官网赛项内容已补；特定区域校级赛/区域赛截止不作全赛事统一报名期限。' });
page(61, '/27739', [['scheduleNote', '2026年全国大学生测绘学科创新创业智能大赛：2026年7月31日—8月1日在河南理工大学举办，具体各赛项形式及要求见学会通知。', '将于2026年7月31日'] ], true);
set(61, { dateScope: '2026全国竞赛举办日期' });
page(62, 'ai-learning.net/dstz', [
  ['competitionContent', '2026第十二届全国大学生统计建模大赛主题为“服务国家战略 创新统计赋能”，参赛队围绕主题自拟题目撰写统计建模论文，分本科生组和研究生组。', '大赛主题为'],
  ['scheduleNote', '2026第十二届3月启动；5月17日前各校选拔推荐省赛队伍；6月中旬省赛，7—8月国赛通讯/会议评审，答辩具体时间另行通知。5月17日为学校推荐节点，非学生统一报名截止。', '（四）各校选拔推荐省赛队伍', '（七）大赛总结会'],
], true);
set(62, { dateScope: '全国阶段节点，校内报名各校确定' });
page(63, '/13106', [
  ['eligibility', null, '参赛对象为全日制普通高等学校在读本科生、硕士研究生和博士研究生。'],
  ['competitionContent', '第十三届（2026—2027）能源经济学术创意大赛，以本科生组、研究生组开展能源经济相关学术创意作品竞赛，按报名、作品提交、校省赛、全国赛逐级评审。', '大赛设本科生组和研究生组。'],
  ['scheduleNote', '第十三届跨年赛程：报名2026年11月17日—12月16日；作品提交2027年2月22日—3月13日；校省赛3月14日—4月18日；国赛评审4月20日—5月10日；总决赛5月22—23日。', '（一）报名', '二、参赛要求'],
]);
set(63, { dateScope: '第十三届2026—2027跨年', reason: '12月16日为本届真实报名截止；历史2025日期被自动补成年2026的证据不再采用，保留原文待核。' });
page(64, 'www.cmit.cn/html', [
  ['organizer', '全国大学生数字媒体科技作品及创意竞赛组委会', '（一）主办单位', '（二）承办单位'],
  ['eligibility', '普通高校全日制在校研究生、本科及高职高专，专业不限；国际赛道及毕业五年内创业团队按指定规则。每队学生不超过5人，指导教师1—2名。', '三、参赛对象', '五、参赛选题'],
  ['scheduleNote', '2026第十四届报名及作品提交10月23日23:59:59截止；校赛10月24—28日，赛区选拔11月2—15日；全国总决赛11月27—29日；12月4—6日颁奖作品展为待定安排。', '六、赛程安排', '七、'],
], true);
set(64, { dateScope: '2026第十四届全国主通知', reason: '已核验原始主通知，区分报名作品提交、校赛、赛区赛与待定颁奖安排。' });
set(65, { rejectFields: ['description'], dateScope: '湖北分区赛参考', reason: '原简介误采版权/技术支持页脚，已剔除；补武汉工程大学有效通知，7月10日—9月20日及10月12日只按湖北分区保存。' });
page(65, 'wit.edu.cn', [
  ['competitionContent', '税收风险管控案例大赛采取团体赛形式，以税收风险案例及相关资料提交参赛；已核验湖北分区通知，其他分区要求须查相应通知。', '三、竞赛主题', '五 、注意事项'],
  ['eligibility', '全日制高校在校本科生和研究生均可参赛，年级不限；每队3名学生，不得跨校，本研不得混合组队，指导教师1—2名。', '二、参赛对象', '三、竞赛主题'],
  ['scheduleNote', '湖北分区参考：2026年7月10日—9月20日报名；案例及资料提交截止2026年10月12日24:00。不作为全国各分区统一截止。', '（一）湖北分区赛报名时间', '五 、注意事项'],
]);
set(66, { rejectFields: ['eligibility'], reason: '原资格漏掉高职组，已按企业决策/运营/供应链/数智沙盘分别说明研究生、本科、高职限制；未混用校赛报名。' });
page(66, 'sem.ntu.edu.cn', [['eligibility', '企业决策赛道分研究生组、本科组；企业运营、供应链决策、数智沙盘赛道分本科组、高职组。研究生仅参加企业决策研究生组，其他组别及组队按对应通知。', '2、企业决策赛道分为研究生组和本科组。']]);
page(67, '/5186', [
  ['competitionContent', '数智化企业经营沙盘大赛模拟企业数智化经营场景，围绕营销、财务、生产和人力资源岗位决策，考查综合经营管理、数据分析、计划预算与团队协作能力。', '全国高等院校数智化企业经营沙盘大赛自', '二、 参赛对象'],
  ['eligibility', '截至2026年12月31日在籍的普通高校全日制本科生；每队4名选手、1—2名指导教师，不得跨校组队。', '截止至 202 6 年 12月31日'],
  ['scheduleNote', '哈工大深圳校内/广东赛区参考：2026年6月12日校赛报名、6月13日校内选拔、6月27日省赛；原通知全国总决赛9月为预计，不是已确认全国赛期。', '三、 竞赛日程', '四、 竞赛报名'],
]);
set(67, { dateScope: '哈工大深圳校内/广东省赛；国赛仅预计' });
set(68, { clearDeadline: true, rejectFields: ['nearestDeadline', 'schedule'], dateScope: '赛区制省赛；赛马制另定', reason: '原11月1日是省赛最迟完成日，误抽成报名截止。官方赛区制省赛报名10月15日20:00截止，赛马制按赛题另定；原10月24—25日为江苏赛区，保留范围标签。' });
page(68, '/3618', [
  ['eligibility', null, '主要面向全球高校和科学研究机构拥有正式学籍的在读学生'],
  ['scheduleNote', '2026赛区制省赛报名截止10月15日20:00，省赛最迟11月1日前完成；赛马制复赛报名与赛程按具体赛题。总决赛原计划11月中下旬，部分赛题可延至12月31日前。江苏赛区10月24—25日仅为地区参考。', '六、赛程安排', '七、参赛要求'],
], true);
page(69, 'news_show.php?id=234', [
  ['organizer', '国际农业和生物系统工程委员会、中国农业机械学会、中国农业工程学会、省部共建现代农业装备与技术协同创新中心（江苏大学）、农业工程大学国际联盟', '（ 一 ） 联合 主办 单位', '（ 二 ） 大赛承办单位'],
  ['competitionContent', '第十二届国际大学生智能农业装备创新大赛分自由选题、机器人、企业出题、概念设计四类，围绕智能农业装备自主研发与设计开展作品选拔。', 'A 类 : 自由选题 类', '（ 三 ） 各参赛单位'],
  ['eligibility', '2026年9月及以前正式注册的全日制非成人教育普通高校和高职高专在校生，含专科、本科及符合通知要求的研究生；每队2—5人。有省赛地区须通过省级选拔。', '202 6 年 9 月 前（含 9 月）'],
  ['scheduleNote', '第十二届跨年赛程：未设省级选拔赛地区由高校报名，2026年9月10日—11月30日；作品申报12月1—20日；复赛2027年1月1日—3月5日；决赛预计2027年5月。有省赛地区按本省赛程，3月5日前推荐。', '五、大赛进度安排', '1 . 大赛 报名 时间'],
], true);
set(69, { dateScope: '第十二届2026—2027；设省赛/未设省赛区分' });
set(70, { clearDeadline: true, rejectFields: ['nearestDeadline', 'schedule'], dateScope: '桂林信息科技学院校内参考', reason: '10月16日和10月17—29日为该校报名与选拔安排；广西区10月30—31日也非全国统一时间。' });
page(70, 'guit.edu.cn', [['scheduleNote', '桂林信息科技学院校内选拔参考：2026年10月16日报名截止，10月17—29日选拔。其他学校、赛区及全国赛安排按对应通知。', '报名截止时间为']]);
set(71, { rejectFields: ['schedule'], dateScope: '第二届AIGC+3D时尚数字设计赛项', reason: '原12月10—13日为第二届AIGC+3D时尚数字设计赛项国内决赛报到安排，不是所有金砖赛项统一赛期。' });
priorPage(71, '/4002', [['scheduleNote', '2026一带一路暨金砖大赛之第二届AIGC+3D时尚数字设计赛项国内决赛：2026年12月10—13日（10日及11日上午报到，11日下午开幕，12日比赛，13日闭幕）。仅适用该赛项。']]);

if (failures.length) throw new Error(failures.join('\n'));
module.exports = { directory, decisions, page, set };
