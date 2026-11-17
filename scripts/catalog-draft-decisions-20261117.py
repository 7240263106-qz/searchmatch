"""Build a version-checked follow-up review manifest from captured evidence."""
import collections
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts/catalog-draft-audit-20261117'
SOURCES = OUT / 'sources'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def captured(name, url, title, text, method):
    value = {'url': url, 'title': title, 'text': text, 'status': 'ok', 'method': method,
             'capturedAt': '2026-11-17', 'sha256': hashlib.sha256(text.encode()).hexdigest()}
    write(SOURCES / name, value)


# Transcribed from rendered official pages and visually inspected scanned PDFs.
captured('browser-bim-regulations.json', 'https://gxbsxs.glodonedu.com/introduce',
         '第十三届“广联达杯”BIM毕业设计创新大赛竞赛章程', '''
主办单位
中国土木工程学会建筑市场与招标投标研究分会
国家数字建筑行业产教融合共同体
广联达科技股份有限公司
本届比赛共设置十个模块
本届大赛各模块面向全国全日制本科、高职高专、中职院校，所有建筑类相关专业的在籍学生（含研究生）。学生报名不限年级，同一团队内研究生不可超过2人，本科组、专科组（含中职）独立报名。
每支队伍由3-5名参赛学生和1-2名指导教师组成
每支队伍由3名参赛学生和1-2名指导教师组成
1、晋级赛阶段（2026年9月14日-2026年12月上旬）
校园赛负责人须在2026年12月2日16:00前在大赛官网提交晋级队伍名单。
2、总决赛阶段（2027年1月-5月）
作品上传截止时间预计为2027年4月上旬；
I模块 人工智能物联网 线上报名 2026年9月14日-2027年1月30日
J模块 建筑机器人 线上报名 2026年9月14日-2027年1月30日
注：具体时间安排详见后续官网通知
（七）报名时间及方式
1、报名时间：
A模块-H模块
2026年9月14日10:00-2026年11月30日16:00
I模块-J模块
2026年9月14日10:00-2027年1月29日16:00
2、报名方式：各参赛队伍报名之日起可通过大赛官方网站进行报名。
1）官网地址：https://gxbsxs.glodonedu.com/
'''.strip(), 'browser_rendered_text; discrepancy retained')
captured('visual-robot-final.json', 'https://www.robotcontest.cn/home/newsDetails?newsId=130859',
         '第九届中国高校智能机器人创意大赛决赛通知（2号通知）', '''
主题一的作品必须在2026年6月21日前在大赛官方网站提交决赛资料。
现场决赛时间：2026年7月11日报到，7月12-13日现场决赛。
'''.strip(), 'visual_read_of_official_download_page_1; rendered/robot-1.png')
captured('visual-ncda-timetable.json', 'https://www.ncda.org.cn/uploadfile/2026/0327/20260327062022823.pdf',
         '2026第14届未来设计师NCDA大赛通知', '''
报名参赛：即日起开始报名，2026年6月20日截止投稿；
省级赛：2026年7月1日—2026年8月8日，公布省级赛奖项；
全国赛：2026年8月9日—2026年8月26日，公布全国赛奖项；
颁奖典礼：2026年11月（暂定）。
注：各赛项具体安排请以官网发布的详细竞赛方案为准。
'''.strip(), 'visual_read_of_official_pdf_page_2; rendered/ncda-2.png')

snapshot = read(OUT / 'current.json')
baseline = read(OUT / 'before.json')
sources = [read(p) | {'cacheFile': str(p.relative_to(ROOT)).replace('\\', '/')} for p in SOURCES.glob('*.json')]


def norm(text):
    return re.sub(r'\s+', '', text)


def source(url, prefer=None):
    candidates = [s for s in sources if s['url'] == url and s.get('status') == 'ok']
    if prefer:
        candidates = [s for s in candidates if prefer in s['cacheFile']]
    if not candidates:
        raise ValueError('No captured source: ' + url)
    return max(candidates, key=lambda s: len(s.get('text', '')))


decisions = {}
for index, row in enumerate(snapshot['rows'], 1):
    if row.get('schoolRecognitionLevel') not in ('A类', 'B类', 'C类'):
        continue
    before = baseline['rows'][index - 1]
    assert before['id'] == row['id'] and before['versionNo'] == row['versionNo'], 'Concurrent change; inspect first'
    decisions[index] = {'index': index, 'id': row['id'], 'name': row['name'], 'expectedVersion': row['versionNo'],
                        'publishStatus': row['publishStatus'], 'pages': [], 'stages': [], 'notes': [],
                        'qualityReview': False, 'reason': '复核已有目录审核与字段证据，保留原有资料和发布状态。'}


def page(index, url, source_type, fields, *, prefer=None):
    s = source(url, prefer)
    p = {'url': url, 'title': s['title'], 'kind': 'attachment' if '.pdf' in url else 'notice',
         'scope': 'general', 'year': None, 'edition': None, 'excerpt': '', 'attachments': [],
         'sourceType': source_type, 'cacheFile': s['cacheFile'], 'sha256': s.get('sha256'), 'fields': []}
    if '.pdf' in url and re.fullmatch(r'[\w-]+\.pdf', s['title'], re.I):
        p['title'] = decisions[index]['name'] + '｜竞赛通知原件'
    for key, value, quote in fields:
        assert norm(quote) in norm(s['text']), f'Unmatched quote {index}: {quote}'
        p['fields'].append({'key': key, 'label': key, 'value': value, 'quote': quote})
    decisions[index]['pages'].append(p)
    decisions[index]['qualityReview'] = bool(fields) or decisions[index]['qualityReview']
    if fields:
        decisions[index]['reason'] = '逐条对照本次通知原文补录；转载、历史届次及分赛项分别标明。'
    return p


def note(index, text):
    decisions[index]['notes'].append(text)


def schedule(index, url, kind, text, quote, **kwargs):
    return page(index, url, kind, [('scheduleNote', text, quote)], **kwargs)


page(2, 'https://hudong.moe.gov.cn/srcsite/A08/s5672/202607/t20260731_1445670.html', 'official_site', [
    ('scheduleNote', '2026届官方通知：2026年8月10日开放报名，9月25日12:00截止；8—10月校级初赛和省级复赛，10月25日前完成省级复赛、10月31日前完成国赛推荐；总决赛安排在2026年11月。国际参赛项目的报名和遴选另行通知。', '报名系统开放时间为2026年8月10日，报名截止时间为9月25日12时。'),
    ('eligibility', '2026届参赛人员年龄不超过35岁（1991年3月1日及以后出生），学校教师不得作为项目团队成员。仅选择一个符合条件的赛道，具体学籍、毕业年限和组队要求以各赛道方案为准。', '参赛人员年龄不超过35岁（1991年3月1日及以后出生），学校教师不得作为项目团队成员参赛。'),
])
schedule(3, 'https://2025.tiaozhanbei.net/', 'official_site',
         '2027届全国统一报名和终审决赛日期本次尚未核实。已有高校发布2027届校内预选通知，不能代作全国赛程。历史参考：第十九届（2025年）官网于2025年11月2日发布终审决赛开赛动态；该历史日期不适用于2027届。',
         'DAY1丨第十九届“挑战杯”竞赛终审决赛，开赛！')
page(3, 'https://tw.zjhzu.edu.cn/2026/0830/c1044a43670/page.htm', 'other', [])
note(3, '未取得2027届全国统一赛程；校内预通知只证明新届备赛启动。')
schedule(5, 'http://zhijh.youth.cn/tzgg/current/202610/t20261030_16941543.htm', 'official_site',
         '第八届（2026年）全国赛初评在2026年10月中下旬进行，入围名单公示期10月30日—11月3日，排名前500的项目参加终评路演答辩。该公告未给出终评确切日期或全国统一个人报名截止；省级推报、行业赛和校内推荐按各自通知。',
         '公示时间为2026年10月30日-11月3日。')
note(5, '终评具体日待核实；所查学校5月10日为校内推荐截止，不录作全国截止。')
schedule(7, 'https://icpc.pku.edu.cn/ssxx/bed2c89264fd4d90b08bc93036051186.htm', 'official_site',
         '2026 ICPC Asia EC各站拟定赛程：西安2026年10月17—18日，成都10月24—25日，武汉10月31日—11月1日，南京11月7—8日，沈阳11月14—15日，上海12月5—6日，南昌12月19—20日；香港2027年1月9—10日，杭州EC Final为2027年1月26—28日。官方汇总注明以上均暂定，最终以各站报名通知为准。各站单独报名，无统一父级截止。',
         '注：以上时间都是暂定，最终以报名通知为准')
page(11, 'https://www.imust.edu.cn/info/1063/12934.htm', 'official_site', [
    ('scheduleNote', '第十九届（2026年）已举办：2026年10月16—18日在内蒙古科技大学举行。采用承办学校10月20日赛后报道确认的实际日期。下一届报名、选拔及决赛时间本次尚未核实。', '10月16日至18日，第十九届全国大学生结构设计竞赛在内蒙古科技大学顺利举办。'),
    ('competitionContent', '第十九届（2026年）以“勒勒车”为赛题，完成结构方案设计、模型制作、优化调试和现场加载试验，考察力学分析、结构创新与团队协作。下一届赛题以当届通知为准。', '本届大赛以国家级非物质文化遗产“勒勒车”为赛题'),
    ('organizer', '全国大学生结构设计竞赛委员会', '本次赛事由全国大学生结构设计竞赛委员会主办，内蒙古科技大学承办'),
])
note(11, '官网HTTPS证书域名不匹配、HTTP被浏览器阻止，改用决赛承办学校原始报道；详细资格和下届报名尚未核实。')
schedule(13, 'https://www.jwc.ynu.edu.cn/info/1009/4315.htm', 'other',
         '第二十一届（2026年）全国阶段计划（云南大学转述）：室内及缩微赛道全国总决赛为2026年8月；室外赛道全国总决赛计划2026年12月底，西部区域选拔计划12月上旬。保留月份精度，以组委会后续通知为准。7月1日、11月1日是该校报名截止，不是全国统一截止。',
         '室外赛全国总决赛：2026年12月底')
note(13, '已定位官网室外赛通知，未取得可读附件；当前是高校转述的月份级计划。')
page(15, 'https://etc.ouc.edu.cn/2026/0901/c26020a536339/page.htm', 'other', [
    ('scheduleNote', '2027年第十届预通知（中国海洋大学公开转发）：全国总决赛预计2027年7—8月，具体日期地点另行通知；各省于2027年5月10日前完成省级复赛组织及参赛数据、晋级名单报送。5月10日是省级组织报送节点，不是学生统一报名截止。', '预计将于2027年7-8月举办'),
    ('competitionContent', '2027年第十届预通知设3个赛道9个赛项：工程实践（太阳能电动车、生物质能电动车），智能+工程创新（智能搬运、智能分拣、智能救援），虚拟仿真（飞行器设计仿真、智能网联汽车设计、工程场景数字化、企业运营仿真）。实行校级初赛、省级复赛、全国总决赛三级赛制。', '大赛设3个赛道9个赛项'),
    ('eligibility', '2027年第十届：普通高等教育本科院校全日制在校本科生；每队不超过4名学生、2名指导教师；每名学生限一个赛项、一支队伍。', '参赛选手须为普通高等教育本科院校全日制在校本科生。每支参赛队由不超过 4 名学生、不超过 2 名指导教师组成'),
    ('signupUrl', 'http://www.gcxl.edu.cn', '网址：http://www.gcxl.edu.cn'),
])
note(15, '原任务只抓2026，漏掉2027预通知；全国决赛日和学生报名截止仍未明确。')
page(16, 'https://jwc.cueb.edu.cn/docs/2025-04/37d94190d90b481fb97230de9404f064.pdf', 'uploaded_document', [
    ('scheduleNote', '仅核实到第九届（2025年）中物联正式通知，以下为历史资料：2025年4月8日—4月29日16:00报名，5月1日—6月18日初赛，6月19日—7月29日复赛，7月30日—8月28日决赛阶段（答辩日期另行公布）。2026/2027新届通知及日期尚未核实，不把2025日期平移到新年份。', '各参赛团队领队或队长于2025 年4 月29 日16:00 前进入'),
    ('competitionContent', '历史第九届（2025年）要求从官方企业案例选择2—3个案例设计物流解决方案，可采用文字分析报告、数学模型、算法、软件系统和工程设计等形式；分初赛、复赛和决赛。新一届题目要求待新通知核验。', '设计方案可以是文字分析报告、数学模型、算法、软件系统开发以及工程设计方案。'),
    ('organizer', '中国物流与采购联合会', '主办单位：中国物流与采购联合会'),
    ('eligibility', '历史第九届（2025年）规则：全日制本科在校生组每队5人；在校硕士、博士研究生组每队3—5人；至少2名物流类专业或物流方向学生，不得跨校、不得重复组队。新一届资格以新通知为准。', '本科组参赛对象为正式录取的全日制本科在校生。'),
])
note(16, '现官网证书过期，旧HTTP平台无法正常浏览。用高校保存的中物联签发原件补历史资料；新届仍待核实，保留未知报名状态。')
schedule(19, 'https://www.robomaster.com/zh-CN/robo/rm?type=rm-info', 'official_site',
         '子赛事分别记录：RoboMaster超级对抗赛RMUC 2027赛季正式报名为2026年10月20日15:00—10月27日15:00；区域赛计划2027年5—6月，全国总决赛计划2027年7—8月。仅适用于RMUC，不适用于RoboCon和其他RoboMaster赛项；RoboCon最新届具体日期本次未核实。',
         '报名时间：2026年10月20日15:00-2026年10月27日15:00')
note(19, '合并目录父项不能共用子赛事截止；RoboCon官网通知访问中止，保留待核实。')
schedule(21, 'http://www.chengtudasai.com/ctds/public/static/upload/file/20260708/1783518326168555.pdf', 'official_site',
         '第十九届（2026年）第六轮官方通知：7月20日8:00—20:00报到；7月21日开幕式、先进成图技术封闭式比赛和开放赛道答辩；7月22日评阅与抽查复核；7月23日15:00—17:00闭幕式。主赛场为长江大学荆州校区，省级分赛场按统一规则组织。该通知是决赛日程，不是报名截止。',
         '7 月20 日，8:00—20:00，现场报到。')
schedule(30, 'https://xxgk.dhu.edu.cn/2026/0304/c1482a372001/page.htm', 'other',
         '第十届（2026年）公开通知赛程：2026年1月—3月31日报名，1—5月作品设计；初赛作品提交至5月7日，5月初赛评审，6—7月分赛区决赛，全国总决赛计划7月下旬。后两阶段在该通知中注明具体时间地点待定，各题软硬件申请日程以赛题规定为准。',
         '（1）报名时间：2026年1月—2026年3月31日')
schedule(33, 'https://www.ncda.org.cn/uploadfile/2026/0327/20260327062022823.pdf', 'official_site',
         '第14届（2026年）官方通用日程：常规投稿截止2026年6月20日；省级赛7月1日—8月8日，全国赛8月9日—8月26日并公布奖项；颁奖典礼原计划2026年11月（暂定）。各专项赛按各自详细方案执行，不套用常规截止；官网仍有跨年专项赛。',
         '报名参赛：即日起开始报名，2026年6月20日截止投稿；', prefer='visual-ncda')
schedule(38, 'https://yscm.yangtzeu.edu.cn/info/1087/11710.htm', 'other',
         '2026年章程公开转述的计划：报名和中国分赛区选拔持续至2026年6月下旬；入围团队6月20日至决赛前优化作品；决赛计划2026年7月中下旬，变化以组委会最终通知为准。保留计划与月份精度，本次未取得实际决赛日的最终通知。',
         '2026年7月中下旬')
page(39, 'https://cxcyxy.ntu.edu.cn/2026/0430/c10412a290318/page.htm', 'other', [
    ('competitionContent', '2026届公开通知列出CAIM工创、CAIA设计、CAIP强脑、CAIR强体四条赛道，各赛道下设不同赛项，分省级选拔与全国总决赛。具体竞赛内容和组队资格以官方各赛项规程为准。', '本届大赛分CAIM工创赛道、CAIA设计赛道、CAIP强脑赛道、CAIR强体赛道'),
    ('scheduleNote', '2026届全国阶段参考（南通大学公开通知转述）：省级选拔2026年4—9月，全国总决赛2026年7—10月；全国报名系统截止只写到2026年7月，未给出日。5月25日为南通大学校内报名截止，不录作全国截止；各赛项具体安排仍应核对官方规程。', '全国总决赛：2026年7月至10月。'),
    ('signupUrl', 'https://www.raicom.com.cn', '睿抗大赛官网：https://www.raicom.com.cn'),
])
note(39, '官网动态目录在浏览器仍未加载出通知。先补高校转述的全国月份赛程，不把该校资格和报名日推广全国。')

bim = page(44, 'https://gxbsxs.glodonedu.com/introduce', 'official_site', [
    ('competitionContent', '第十三届“广联达杯”BIM毕业设计创新大赛（原国际高校BIM毕业设计创新大赛）设A—J十模块，覆盖城市更新、绿色设计、机电深化、造价与项目管理、运维、人工智能物联网及建筑机器人。A—H为团体线上赛，I—J为团体线下赛。保留学校目录名称。', '本届比赛共设置十个模块'),
    ('organizer', '中国土木工程学会建筑市场与招标投标研究分会、国家数字建筑行业产教融合共同体、广联达科技股份有限公司', '中国土木工程学会建筑市场与招标投标研究分会\n国家数字建筑行业产教融合共同体\n广联达科技股份有限公司'),
    ('eligibility', '全国全日制本科、高职高专、中职院校建筑类相关专业在籍学生，含研究生、不限年级；同队研究生不超过2人，本科与专科（含中职）分组。A—H每队3—5名学生、1—2名指导教师，I—J每队3名学生、1—2名指导教师，具体跨院校限制按模块章程。', '所有建筑类相关专业的在籍学生（含研究生）'),
    ('scheduleNote', '第十三届跨年赛程：A—H报名2026年9月14日10:00—11月30日16:00，晋级赛至2026年12月上旬，总决赛2027年1—5月，交稿预计2027年4月上旬。I—J报名截止存在同页矛盾：“报名时间及方式”写2027年1月29日16:00，流程表写1月30日；该项暂不生成精确截止，需向组委会确认。12月2日16:00是校园赛负责人报送晋级名单的节点。', '2026年9月14日10:00-2026年11月30日16:00'),
    ('signupUrl', 'https://gxbsxs.glodonedu.com/', '官网地址：https://gxbsxs.glodonedu.com/'),
    ('nearestDeadline', '2026年11月30日16:00', '2026年9月14日10:00-2026年11月30日16:00'),
], prefer='browser-bim')
decisions[44]['completeness'] = 'conflict'
decisions[44]['stages'] = [{'name': 'A—H模块报名（不含I—J模块）', 'start': '2026年9月14日10:00',
                            'end': '2026年11月30日16:00', 'applicableTo': '第十三届A—H模块；I—J截止冲突待确认'}]
note(44, '浏览器实际渲染解决SPA空正文；I—J两处截止矛盾保留为冲突，不提高至高可信。')

schedule(45, 'https://sem.ntu.edu.cn/_upload/article/files/f5/78/8bbb42584323bbddb430283c7597/7ecd6ea3-6c56-4089-b5cd-8fe2ae6e8fa9.pdf', 'uploaded_document',
         '仅品牌策划竞赛子项2026届：品牌策划赛道2月13日前院校/教师报名，2月15日前完成知识赛及校赛、3月5日前交预选作品，4月25—26日线上全国总决赛，5月22—24日线下全国精英赛；数字营销赛道4月18—19日全国总决赛；全球总决赛原计划2026年11月下旬。此赛程不适用于目录中另外四类竞赛，不设五类共用截止。',
         '2026 年4 月25-26 日，品牌策划赛道学生组及教师组全国总决赛（线上举行）。')
note(45, '本次补齐品牌策划子项正式赛程；会展、国际贸易、创新创业、会计与商业管理案例四类仍应分别查通知。')
schedule(46, 'http://www.xcbds.com/cyds/dam/userfiles/files/20261014-093851216.pdf', 'official_site',
         '第十三届（2026年）创业综合模拟赛项全国总决赛指南：2026年11月19日分组抽签、11月20日在线测试、11月21—22日竞赛；入围团队须11月8日24:00前确认信息并提交模拟策略。仅适用已晋级队伍，11月8日不是所有学生首次报名截止。财务决策等赛项另有日程。',
         '11 月21 日--11 月22 日竞赛')
page(46, 'http://www.bster.cn/cyds/dam/userfiles/files/20261016-164349286.pdf', 'official_site', [])
schedule(47, 'https://www.robotcontest.cn/home/newsDetails?newsId=130859', 'official_site',
         '第九届（2026年）决赛2号通知：2026年7月11日报到，7月12—13日现场决赛；主题一作品须6月21日前在官网提交决赛资料。主题一及部分赛项在宁波工程学院，主题三和部分专项赛在浙江余姚，个别专项赛另按专项网站。6月21日为决赛资料提交，非全国首次报名截止。',
         '现场决赛时间：2026年7月11日报到，7月12-13日现场决赛。', prefer='visual-robot')
page(48, 'https://storage.cdec.org.cn/hcy/2026/09/20260928144848765-WGma.pdf', 'official_site', [
    ('competitionContent', '第21届以数字艺术、数字设计、数字创意、数字媒体及数字技术创新作品参赛，常规赛有24个投稿类别，另设各自简章管理的专项赛道。个人或团队投稿，按学校二级学院/系组织审核管理。', '本届大赛共设24个投稿类别'),
    ('organizer', '中国好创意暨全国数字艺术设计大赛组织委员会', '主办单位：中国好创意暨全国数字艺术设计大赛组织委员会'),
    ('eligibility', '第21届学生单元分高职组、本科组、研究生组，可个人或团队参赛；在校教师参加独立教师单元。教师不得在学生单元投稿，师生不得混列彼此单元的作品作者。', '学生单元（团队/个人）'),
    ('scheduleNote', '第21届常规赛跨年赛程：报名及投稿2026年10月20日—2027年5月31日17:00；校赛推优2027年6月1日8:00—6月5日17:00；省赛评审6月8—20日17:00止；国赛评审6月24—30日17:00止；国赛获奖名单7月15日前公布。专项赛道各自有截止时间，不能套用常规赛截止。', '报名及截稿时间：2026年10月20日-2027年5月31日17:00止'),
    ('signupUrl', 'https://www.cdec.org.cn/', '大赛官网www.cdec.org.cn，统一报名与上传作品。'),
    ('nearestDeadline', '2027年5月31日17:00', '报名及截稿时间：2026年10月20日-2027年5月31日17:00止'),
])
decisions[48]['stages'] = [{'name': '第21届常规赛报名及投稿（专项赛另计）', 'start': '2026年10月20日',
                            'end': '2027年5月31日17:00', 'applicableTo': '仅常规赛道，专项赛按独立简章'}]
note(48, '从浏览器官网取得第21届正式PDF，解决动态网站和只搜索2026旧届的问题。')
page(49, 'https://craic.aicomp.cn/wp-content/uploads/2026/07/关于第二十八届中国机器人及人工智能大赛全国决赛（线上）的通知.pdf', 'official_site', [
    ('competitionContent', '第二十八届（2026年）全国决赛线上通知覆盖创新、应用、竞技、挑战四类中的指定赛项，包括机器人/人工智能创新、智慧巡检、智能家居、机器人足球、仿人运动、智慧药房及智能制造数字孪生等。线上通知仅适用于文件列出的赛项，不能代表全部线下赛项。', '机器人创新赛、人工智能创新赛'),
    ('scheduleNote', '第二十八届（2026年）全国决赛线上赛项：2026年7月10—23日，通过腾讯会议组织，各赛项具体实施细则由负责人另行发布。该时间仅适用于线上决赛通知列出的项目，不是报名截止，线下项目须查各自通知；通知要求8月15日前开放全国决赛证书下载。', '2026年7月10日-2026年7月23日'),
])
page(49, 'https://cxcyxy.ntu.edu.cn/2026/0430/c10412a290319/page.htm', 'other', [
    ('organizer', '中国人工智能学会', '中国机器人及人工智能大赛是由中国人工智能学会主办的全国性学科竞赛。'),
    ('signupUrl', 'https://www.caairobot.com', '大赛官网：https://www.caairobot.com'),
])
note(49, '已改用组委会全国线上决赛正式通知；南通大学5月11日仅是该校截止，全国详细资格仍应逐赛项查规程。')
schedule(50, 'https://news.dlut.edu.cn/info/1011/148385.htm', 'official_site',
         '第十九届（2026年）全国总决赛已于2026年8月1—2日在大连理工大学举行，采用承办校8月2日原始赛后报道确认实际比赛日。7月31日为其他通知中的报到安排，不计作比赛日或报名截止；下一届赛程尚未核实。',
         '8月1日至2日，第19届全国大学生节能减排社会实践与科技竞赛总决赛在学校举办。')
schedule(54, 'https://www.cup.edu.cn/docs//2026-05/e6e258c803314bdfbd3f183fe944c111.pdf', 'uploaded_document',
         '第八届（2026年）教育部、国家语委通知原计划：四赛项分初赛、复赛、决赛及展示；诵读、讲解赛项初赛至8月5日前、复赛至8月31日前、决赛至9月30日前，10—12月交流展示。省级统一组织赛区与自主报名地区的提交方式、推荐节点不同，书写和篆刻另按附件方案，不设四项共用报名截止。具体后续通知仍需核对。',
         '（一）初赛：2026 年8 月5 日前')
page(54, 'https://jyt.henan.gov.cn/2026/05-28/3359419.html', 'official_site', [])
schedule(56, 'https://www.czu.cn/2026/0722/c6a176600/page.htm', 'other',
         '第二十二届（2026年）全国初赛两场：2026年8月23日、9月19日，均线上举办，可任选场次、取最佳成绩。通知称每场开始前1小时截止报名，但未给出开赛时刻，故不生成精确报名截止。全国决赛日期在本次取得通知中未明确，仍待核实。',
         '第一场（线上）：2026年8月 23 日；第二场（线上）：2026年9月19日')
schedule(66, 'https://sem.ntu.edu.cn/2026/0224/c11410a297048/page.htm', 'other',
         '2026届全国规程要求各学校2026年3月23日前完成校内初赛及选拔。后续设全国复赛、半决赛、总决赛资格赛（备选）和总决赛，具体赛程该通知称在全国复赛报名截止后发布。3月23日为各校选拔完成节点，非全国统一个人报名截止；全国后续实际比赛日仍待核实。',
         '2026年3月23日前完成校内初赛和选拔。')
page(72, 'https://www.chinatheatre.org.cn/jxgg/202604/t20260416_1358881.html', 'official_site', [
    ('competitionContent', '第10届中国校园戏剧节征集全国优秀校园剧目，遴选约20台参加现场展演；包含话剧、戏曲、音乐剧、歌剧、舞剧，以及戏曲折子戏和短剧小戏。该项是遴选展演活动，非个人线上答题或直接报名赛。', '遴选出20台左右全国优秀校园戏剧剧目进行现场展演。'),
    ('organizer', '中国戏剧家协会、四川省文联等相关单位', '由中国戏剧家协会、四川省文联等相关单位联合主办'),
    ('eligibility', '面向全国大、中、小学，以高校学生和青年教师为主；主创及演职人员中，在校生与40岁以下青年教师合计占80%以上。大剧场、小剧场和短剧人数及时长另按通知要求。', '在校生和40岁以下的青年教师人数占总人数80%以上。'),
    ('scheduleNote', '第10届（2026年）原征集通知计划2026年10月中旬在成都举办，实际展演日期本次未取得后续确认。各省剧协须2026年7月31日前（寄出邮戳为准）汇总报中国剧协；学校先报所在地省级剧协。7月31日是省级汇总邮寄节点，不是所有学生直接报名截止。', '于2026年7月31日前（以寄出时间邮戳为准）'),
])
decisions[72]['signupCorrection'] = {'signupMethod': 'offline',
    'signupNote': '学校按属地原则向省级剧协报送，省剧协汇总邮寄中国剧协；依通知提交盖章申报表、剧本和视频U盘等材料，无已核实的个人网页直报入口。',
    'sourceUrl': 'https://www.chinatheatre.org.cn/jxgg/202604/t20260416_1358881.html',
    'quote': '由各学校报送至学校所在省（自治区、直辖市）剧协。'}
note(72, '匹配中国剧协正式活动全名后取得全国征集通知；保留学校原目录名，不误作个人网页报名。')

# Attribute logged skips through the original discovery run, not a nonexistent log competitionId.
run_to_index = {}
for index, decision in decisions.items():
    original = ROOT / 'artifacts/catalog-completion-20261116' / (decision['id'] + '.json')
    if original.exists():
        original = read(original)
        decision['priorWarnings'] = original.get('warnings', [])
        if original.get('runId'):
            run_to_index[original['runId']] = index
log_counts = collections.Counter()
for d in decisions.values():
    log_counts.update(w['reason'] for w in d.get('priorWarnings', []) if w.get('reason'))
for p in (ROOT / 'artifacts/runtime/agent-logs').glob('*.jsonl'):
    for line in p.open(encoding='utf-8'):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        index = run_to_index.get(entry.get('runId'))
        if index and entry.get('reason'):
            decisions[index].setdefault('logSamples', []).append({k: entry.get(k) for k in ['at', 'stage', 'reason', 'message', 'url']})

manifest = {'reviewId': 'catalog-draft-followup-20261117', 'target': 'production',
            'backup': snapshot['backup'], 'publicationPolicy': 'preserve', 'rows': list(decisions.values()),
            'logReasons': dict(log_counts)}
assert len(manifest['rows']) == 71
assert sum(any(f['key'] == 'scheduleNote' for p in d['pages'] for f in p['fields']) for d in decisions.values()) == 25
write(OUT / 'review-manifest.json', manifest)
print(json.dumps({'rows': len(decisions), 'updatedContent': sum(bool(d['pages']) for d in decisions.values()),
                  'fields': sum(len(p['fields']) for d in decisions.values() for p in d['pages']),
                  'logReasons': dict(log_counts)}, ensure_ascii=False, indent=2))
