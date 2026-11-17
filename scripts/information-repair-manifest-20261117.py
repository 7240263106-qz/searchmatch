"""Human-authored, source-backed repair decisions. No network or production writes."""
import datetime
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts/competition-information-repair-20261117'
BASE = json.loads((OUT / 'before/database-snapshot.json').read_text(encoding='utf-8'))['rows']
CACHES = {}
INVALID_ANCHORS = []
for folder in ['artifacts/catalog-draft-audit-20261117/sources', 'artifacts/competition-information-repair-20261117/sources']:
    for p in (ROOT / folder).glob('*.json'):
        c = json.loads(p.read_text(encoding='utf-8-sig'))
        if c.get('text'):
            CACHES[p.stem] = dict(c, cacheFile=p.relative_to(ROOT).as_posix())

ROWS = [dict(index=i, id=r['id'], name=r['name'], expectedVersion=r['versionNo'],
             publishStatus=r['publishStatus'], fields=[], entries=[], stages=[], notes=[], scopeIssues=[]) for i,r in enumerate(BASE,1)]


def evidence(prefix, anchors):
    c = CACHES[prefix]
    text = c['text']
    compact = re.sub(r'\s+', '', text)
    positions = [i for i,ch in enumerate(text) if not ch.isspace()]
    snippets = []
    for anchor in anchors.split('|'):
        anchor = re.sub(r'\s+', '', anchor)
        start = compact.find(anchor)
        if start < 0:
            INVALID_ANCHORS.append(f'{prefix}: {anchor}')
            continue
        pos = positions[start]
        snippets.append(text[max(0,pos-55):min(len(text),pos+850)])
    domain = __import__('urllib.parse',fromlist=['urlparse']).urlparse(c['url']).hostname or ''
    official = any(domain == d or domain.endswith('.'+d) for d in [
        'cahe.edu.cn','tiaozhanbei.net','nuedc-training.com.cn','sun-ada.net','3chuang.net',
        'rmcloud.org','robomaster.com','cimc.org.cn','siemenscup-cimc.org.cn','fwwb.org.cn',
        'lanqiao.cn','ncda.org.cn','cnsoftbei.com','robotcontest.cn','robo-maker.org','cdec.org.cn',
        'caairobot.com','aicomp.cn','contest.i21st.cn','gonghangbei.com','isclab.org.cn','csgpc.org',
        'ai-learning.net','cmit.cn','uiaec.ujs.edu.cn','chinatheatre.org.cn','jyt.henan.gov.cn','xcbds.com',
        'icpc.pku.edu.cn','12umic.hit.edu.cn','nscscc.com'])
    return dict(url=c['url'], title=c.get('title') or c['url'].rsplit('/',1)[-1],
                sourceType='official_site' if official else 'other', cacheFile=c['cacheFile'],
                sha256=hashlib.sha256(text.encode()).hexdigest(), checkedAt=c.get('checkedAt') or c.get('fetchedAt'),
                snippet='\n[…]\n'.join(snippets), selectedAnchors=anchors.split('|'))


def field(i, key, value, source, anchor, scope='national'):
    ROWS[i-1]['fields'].append(dict(key=key, value=value, scope=scope, evidence=evidence(source,anchor)))


def route(i, source, anchor, method, note, url=None, scope='national', contact=None):
    ev = evidence(source,anchor)
    r = ROWS[i-1]
    r['fields'] += [dict(key='signupMethod',value=method,scope=scope,evidence=ev),
                    dict(key='signupNote',value=note,scope=scope,evidence=ev)]
    if url:
        r['fields'].append(dict(key='signupUrl',value=url,scope=scope,evidence=ev))
    if contact:
        r['fields'].append(dict(key='signupContact',value=contact,scope=scope,evidence=ev))
    r['entries'].append(dict(type='school' if scope=='school_reference' or method=='school_unified' else 'instruction' if not url else 'official',
                             url=url, method=method,note=note,contact=contact,scope=scope,evidence=ev))


def eligibility(i, value, source, anchor, scope='national'):
    field(i,'eligibility',value,source,anchor,scope)
    if scope != 'national':
        ROWS[i-1]['scopeIssues'].append('补录的参赛条件仅适用于'+scope+'，不能视为全国所有赛项资格已补齐。')


# Separate legacy record: retain its historical campus scope instead of merging editions.
route(1,'7aad8d5d25f59f2f0358','报名必须|注册', 'school_unified',
      '河南城建学院历史校内通知参考：学生先在蓝桥杯平台注册、认证并选报项目，提交学院审核后按学院授权个人缴费；未通过学院审核不适用该院报销政策。本条原通知届次表述有冲突，不作为第十八届全国统一报名规则。',
      scope='school_reference')
ROWS[0]['notes'].append('独立历史父项保留；当前第十八届完整信息另见学校目录中的蓝桥杯父项，不跨届覆盖。')

route(2,'00130eea132d4c4cbf73','报名|cy.ncss.cn','web',
      '通过全国大学生创业服务网参赛系统报名并提交项目材料，学校审核、校级初赛和省级复赛逐级遴选。不同赛道的身份、毕业年限和项目要求分别适用，不以系统可访问判断仍在报名。', 'https://cy.ncss.cn/')
field(3,'organizers',['共青团中央','中国科协','教育部','中国社会科学院','全国学联'], '4cb3590c33b5fa1e8360','挑战杯是','series_summary')
eligibility(3,'湖州学院2027届校内预选参考：2027年6月1日前正式注册的全日制非成人教育在校本科生，每人限报1项；集体作品不超过10人、指导教师不超过3人。仅为湖州学院/浙江预选口径，全国新届完整章程仍需核实。','a2d2ac29433c10e50c7c','参赛对象|申报要求','school_reference')
route(3,'a2d2ac29433c10e50c7c','参赛办法','school_unified',
      '湖州学院2027届预选参考：按项目申报书编写作品材料，交二级学院初选、排序推荐，由学院统一汇总报校团委。2026年10月19日是该校材料报送日，不能作为全国截止。其他高校应联系本校团委确认本校通道。', scope='school_reference')
route(4,'345b74faac8c66054634','竞赛平台|校、省、全国','school_unified',
      '先参加本校组织的初赛，由学校及省级组委会逐级选拔、推荐至全国赛；赛事官方平台承载参赛报名和项目评审。该全国通知未给出可核验的个人直达报名网址，不能用官网首页替代个人申报入口。')
route(5,'5c76e44065ce2d7e3176','材料准备|推报时间','school_unified',
      '华南理工大学2026校内推报参考：填写项目或公益创业赛申报表，并附项目介绍、图片、财务等支撑材料；以学院为单位报校团委，学校评审后择优推荐省级评选。5月10日仅为该校截止，不是全国个人直报日。',scope='school_reference')
field(6,'organizers',['教育部','重庆市人民政府'],'50321d433eded34b50b0','教育部、重庆市人民政府共同举办')
eligibility(6,'第八届艺术表演、艺术作品、艺术实践工作坊面向全国普通高校全日制在籍本专科生和研究生；高校美育改革创新优秀成果面向高校、教育行政部门、科研院所等单位和个人。','50321d433eded34b50b0','参加人员|高校美育改革')
route(6,'50321d433eded34b50b0','校级展演|yszy.eduyun.cn','school_unified',
      '学生通过学校参加校级展演，学校遴选推荐省级展演；学校将展演情况统一报送全国学校美育数字教育平台，账号另行分配。此链接为组织报送平台，不是个人自由注册直报入口。校级2026年4—7月，省级8—12月，全国汇演2027年1—6月。','https://yszy.eduyun.cn/hd/dyz')
route(7,'5a003cdb6a26c66ee929','报名方式|第二轮报名','web',
      '2026第51届ICPC亚洲区域赛南昌站：获得名额的正式队伍须先在icpc.global注册队伍，再到中文系统填写队伍信息。第一轮11月15日结束；第二轮外卡由高校教练邮件申请，11月22日结束。仅为南昌站，不适用于所有区域赛站。','https://uep.pintia.cn/icpc-reg/examGroups',scope='subevent_Nanchang_2026')
ROWS[6]['scopeIssues'].append('已核南昌站双系统及外卡流程；其他赛站资格、报名截止及全球参赛规则仍须对应邀请函，未设置统一父项截止。')
ROWS[6]['stages'].append(dict(name='2026 ICPC南昌站第二轮（外卡）',start=None,end='2026年11月22日',applicableTo='仅2026南昌站，教练申请外卡、获得名额队伍完成双系统登记',evidence=evidence('5a003cdb6a26c66ee929','第二轮报名11月22日结束')))

field(8,'description','以数学建模方法分析实际问题并提交竞赛论文的全国性大学生赛事。2026年竞赛时间为9月10日18:00至9月13日20:00；报名组织由各校负责，校内选拔和培训时间另列。','5e2479a32139f2a33ed1','竞赛时间|数学建模')
eligibility(8,'云南大学2026校内组织口径：在校各专业本科生，队伍不超过3名学生、最多1名指导教师，可跨学院/专业/年级但不跨校，每人仅参加1队。全国其他学历组别须核对全国报名参赛须知。','5e2479a32139f2a33ed1','参赛对象','school_reference')
route(8,'5e2479a32139f2a33ed1','报名时间及方式','school_unified',
      '云南大学2026参考流程：学生填写报名表交学院，学院核对汇总后由信息学院统一导入竞赛报名系统；8月10日为该校学生报名截止。现存cumcm系统链接用于组织报名，本轮未进入账号或提交真实报名。','https://cumcm.cnki.net/',scope='school_reference')
field(9,'description','2026年模拟电子系统设计专题赛，考查电子系统分析设计、制作调试和测试能力，实行赛区选拔与全国专题赛决赛。专题赛与常规全国赛分属不同安排，不将专题赛日期泛化至所有电子设计竞赛。','20864209d500d3ab88ed','专题赛|参赛对象')
route(9,'20864209d500d3ab88ed','由所在学校统一向赛区','school_unified',
      '2026模拟电子系统设计专题赛：在校学生校内自愿组队，每队3人，由所在学校统一向赛区组委会报名；全国决赛通过赛区推荐或邀请后校内选拔产生，不能个人直接报名全国决赛。')
field(10,'organizers',['全国大学生机械创新设计大赛组委会'],'abb3186496feb3ed2621','主办单位为')
eligibility(10,'2027数字孪生挑战赛：第十二届常规赛省级二等奖以上获奖作品可组队；开设智能制造工程或数字孪生微专业高校的企业选题须另经审查且占比受限。在校研究生、本科、专科生（含2027届）经学校报名，每队不超过6学生、2指导，每学生仅1作品。仅适用于2027挑战赛季。','abb3186496feb3ed2621','参赛资格|参赛条件','subevent_digital_twin_2027')
route(10,'abb3186496feb3ed2621','预报名通道|正式报名通道','web',
      '2027数字孪生挑战赛须经学校组队，在大赛官网完成预报名（2026年10月10—20日），仅已预报名队伍可在12月20—30日正式报名并交第一阶段报告和视频，学校组织省预赛后推荐全国赛。不在官网报名不能参加省赛/国赛；不套用2026常规赛流程。','https://umic.moocollege.com',scope='subevent_digital_twin_2027')
field(10,'scheduleNote','第十二届2026常规赛全国决赛已于7月17—20日举办。2027数字孪生挑战赛按第5号通知：2026年10月10—20日预报名，12月20—30日正式报名及交第一阶段材料；2027年4月21日前省级预赛，4月30日前赛区推荐全国名单。仅预报名队伍取得正式报名资格，后续全国决赛细则另发。','abb3186496feb3ed2621','2026年7月17日|预报名通道|2027年4月21日')
ROWS[9]['stages'].append(dict(name='2027数字孪生挑战赛正式报名（仅预报名队）',start='2026年12月20日',end='2026年12月30日',applicableTo='2027数字孪生挑战赛；须已完成预报名',evidence=evidence('abb3186496feb3ed2621','正式报名通道')))
field(10,'nearestDeadline','2026年12月30日','abb3186496feb3ed2621','正式报名通道','subevent_digital_twin_2027')
eligibility(11,'东北农业大学2026校赛参考：本校在读本科生自行组队，每队2—3人，可联系1指导教师，校赛选拔5队参加黑龙江省赛。仅本校选拔规则，不作为全国参赛人数和资格的统一要求。','2f3d4956e5458f118eda','报名规则','school_reference')
route(11,'2f3d4956e5458f118eda','报名规则|报名时间','school_unified',
      '东北农业大学2026校赛参考：在工程师协会登记姓名、学号、专业班级及指导教师，关注“东农工程师”公众号具体推文，参加校选后由学校推荐省赛。5月1—10日仅为本校报名时间；全国完整章程与其他学校通道未核实。',scope='school_reference')
ROWS[10]['notes'].append('全国官网详情仍受阻；已补可核实的校内选拔参考流程，保留草稿，全国完整章程和资格仍待核。')
route(12,'2c712fae1cf00278ebbe','第1步|第4步','web',
      '按第18届参赛指南在大广赛官网“全国作品提交”系统注册并上传作品，核对后由草稿转为正式作品，获得唯一参赛编号及报名表、承诺书；学生再按要求向学校交材料，由学校报赛区、赛区报全国。线上作品提交截至2026年6月12日16:00，线下截稿由各赛区另定。','https://www.sun-ada.net/')
eligibility(13,'中国自动化学会赛事介绍列示本科、专科参赛对象；2026云南大学校内组织仅面向全日制在校本科生。各赛道和学历组实际资格分别核实，不把校内本科限制套用于全国全部组别。','ae9e250a3d9011300363','参赛对象','series_summary')
route(13,'d6f305905f2b71414605','材料提交','school_unified',
      '云南大学2026校内组织参考：填写参赛报名表，按通知指定邮箱提交，并备注学院、学号、姓名、参赛赛道，由校内赛事负责人协调；室内7月1日、室外11月1日是该通知口径。其他学校须联系本校赛务确认，不能共用该校邮箱。',scope='school_reference')
eligibility(14,'普通高校全日制在校专科、本科、研究生均可，专业不限。团队3—5名学生、0—2名高校指导和0—2名企业指导；可跨校，以队长学校报名，同类赛不得重复报两个项目。','0d39dfc849a43f144863','参赛资格和指导原则')
route(14,'0d39dfc849a43f144863','报名方式|队长','web',
      '由队长在三创赛官网“团队登录”选择对应赛道、注册团队，填学生与指导教师、作品资料，由学校管理员审核；学校首次承办需先完成校级备案。常规赛与实战赛使用不同团队账号，不以注册账号视为自动晋级。','https://www.3chuang.net/#/home')
route(15,'f4d09de6f1e1c55a62cd','参赛报名','web',
      '所有参赛队登录大赛官网，点击“竞赛报名”完成注册并提交报名及参赛材料；学校初赛、省级复赛、全国决赛逐级选拔。2027年5月10日是省级复赛数据和推荐名单报送要求，不是学生统一报名截止。','http://www.gcxl.edu.cn/')
route(16,'64beb3ee9984654c8caa','报名|dspt.clppx.org.cn','web',
      '第八届2025历史规程参考：领队或队长登录物流设计大赛平台，填信息并上传学校盖章报名表、在校证明及学生证材料。该旧届路径只供历史查阅，不据此宣称2026或后续届次已开放。','http://dspt.clppx.org.cn/pkIndex/wlsj/wlsjdshome',scope='historical_2025')
field(17,'description','学校目录收录外研社英语演讲、辩论、写作、阅读系列比赛。现有2026“外研社·国才杯”“理解当代中国”通知对应综合能力、演讲、笔译、短视频等赛项，不能将其赛程或资格统一套用于目录四项，英语辩论尤其需独立通知。','96e3b4e0c49b496c663b','竞赛组别')
ROWS[16]['scopeIssues'].append('目录演讲/辩论/写作/阅读与现存“理解当代中国”赛项范围不完全一致；已在报名说明明确适用范围，不能视为四子赛全部核实。')
route(17,'96e3b4e0c49b496c663b','报名流程','web',
      '所核2026“理解当代中国”通知：在官网填个人信息，选择该校举办的具体赛项，并参加校、省、全国三级选拔。本入口不能直接覆盖原目录英语辩论赛；原目录四子赛与当前综合能力、演讲、笔译等赛项须分别核实。','https://ucc.fltrp.com/',scope='subevent_UCC_2026')
route(18,'57580f455d7733c82308','官方网站将于|校赛','school_unified',
      '第11届华灿奖从中国高等教育学会专题页进入：创意赛道由学校初选推荐至赛区，再入全国评审；定向主题赛道直接进入全国评审。各校按所属赛区要求报送，本轮尚未核实专题页内作品系统的直达地址。','https://www.cahe.edu.cn/site/term/906.html')
eligibility(19,'2027 RoboMaster大学生超级对抗赛RMUC以高校队伍参赛，原则每校1队，允许两校联合组队，需按新参赛队资格及邀请流程办理。仅适用于RoboMaster RMUC；RoboCon及其他RM赛项独立适用。','bdeee9ca808920649f4e','参赛|高校','subevent_RMUC_2027')
route(19,'bdeee9ca808920649f4e','我的战队|邀请码','web',
      '2027 RoboMaster RMUC：队长或指导教师登录RoboMaster论坛“我的战队”进入报名并选择赛项，新队按通知联系赛务获取邀请码。此流程不适用于RoboCon，后者的独立报名通道仍需核实。','https://www.robomaster.com/',scope='subevent_RMUC_2027')
eligibility(20,'第16届市场调查赛面向本专科、研究生及留学生等相应组别；实践团队通常3—5名学生、1—3名指导教师。所核高校通知未限制专业，报名须取得本校参赛代码，不复制其他学校代码。','0e90d1b7041a1544f575','参赛|指导','notice_2026')
route(20,'0e90d1b7041a1544f575','学生参赛报名|代码','web',
      '在中国商业统计学会网站“学生参赛报名”页面注册，选择本届组别并填写本校参赛代码，按校内负责人要求组队、参加知识赛和实践赛；本校代码需向学校索取。','http://www.china-cssc.org/list-60-1.html')
field(21,'description','先进成图技术与产品信息建模竞赛包含机械、建筑、环艺、道桥、水利、电子等类别和开放赛道；2026年第19届全国决赛按第六轮通知实行主赛场、分赛场组织，参赛队服从所在省级组委会安排。','f6fadcd5beaddee5df56','竞赛组织安排|机械类')
route(21,'f6fadcd5beaddee5df56','省级组委会','school_unified',
      '2026全国决赛阶段由学校和所在省级组委会组织参赛，按省级通知确认主/分赛场、报到及答辩安排。已核实的是晋级后的组织路径，初赛的注册入口与全国资格尚未从现有正文确认，不用旧“附件受限”占位描述代替。')
field(22,'organizers',['全国三维数字化创新设计大赛组委会','国家制造业信息化培训中心','全国3D技术推广服务与教育培训联盟','北京光华设计发展基金会'],'8f2f655b90163e512d71','主办')
eligibility(22,'2026数字化设计与制造分赛：团队一般2—3名学生、1—2名指导教师，分职业院校组、本研组等。此条件只针对该分赛，其他3D赛项及青少年赛按各自规程执行。','8f2f655b90163e512d71','参赛|指导','subevent_design_manufacturing')
route(22,'8f2f655b90163e512d71','报名|3dshow','web',
      '现入口仅对应2026数字化设计与制造分赛，在该分赛平台选择组别并提交参赛资料和作品；其他三维数字化赛项不能直接套用本分赛入口、资格和截止。','https://3dshow.3ddl.net/i/DM',scope='subevent_design_manufacturing')
eligibility(23,'面向全国控制、电气、机械、仪表、信息通信、计算机等相关专业本研学生，以及相应专业高职高专、技师院校学生。普通赛项通常1—3名学生、1—2名指导；通识等赛项另有年级、单人要求，须按赛项核对。','721ee38f1354a5c84201','主要面向|报名')
route(23,'721ee38f1354a5c84201','注册|报名','web',
      '在西门子杯官网注册，选定赛项、组别并组队，按该赛项要求完成报名手续。不同赛项的队伍规模、年级、赛区及缴费要求分开适用，本轮只核对公开说明，不进行真实缴费。','http://www.siemenscup-cimc.org.cn/')
eligibility(24,'第17届面向全国普通高校全日制在校学生（含2026应届毕业生）及毕业不超过5年者（2021年后毕业）。每队最多5名学生、2名指导；B类每校最多2队，A/C/D各类别按具体题目规则组织。','1c78d5fe2b84ecb965b7','参赛对象|参赛要求')
route(24,'047dda722a0d3ce5e203','3月31日|选题处','web',
      '第17届通过大赛官网报名系统完成报名与选题，正式延期至2026年3月31日16:00。B类超过2队的学校须先校选，入选2队在截止前将盖章证明上传报名系统选题处，不再发送邮箱。初赛作品另按B/C、A/D04—06、D01—03时间窗口提交。','https://www.fwwb.org.cn/')
field(24,'scheduleNote','第17届以2026年3月17日正式延期通知为准：报名及选题延至2026年3月31日16:00；B/C类作品4月11日10:00—4月15日16:00，A类及D04—06作品4月18日10:00—4月22日16:00，D01—03作品截止4月27日16:00；成员/教师调整4月23日10:00—4月24日16:00，初赛评审4月28日—5月12日。旧3月4日或18日截止已被延期通知取代。','047dda722a0d3ce5e203','3月31日|4月11日|4月18日|4月27日')
ROWS[23]['stages'].append(dict(name='第17届报名及选题（正式延期）',start=None,end='2026年3月31日16:00',applicableTo='第17届全国统一报名及选题；B类需校内限额推荐',replaceOfficialFirst=True,evidence=evidence('047dda722a0d3ce5e203','3月31日')))
field(24,'nearestDeadline','2026年3月31日16:00','047dda722a0d3ce5e203','3月31日')
route(25,'91a45a0026189073ac12','2026.jsjds.com.cn','web',
      '2026参赛队按组委会平台注册，填写团队和作品信息，并按学校、地区选拔要求审核报送。北京赛区的单人队伍不具备推荐全国赛资格，不能将该省级例外套用全国。','https://2026.jsjds.com.cn/account/Register')
eligibility(26,'仅网络技术挑战赛已核实：在校本科生及研究生2—6人，可跨校，按最高学籍分组，1—2名指导；不等同大数据、天梯、移动应用、AI创意等子赛的资格。','32d56e84bf4d6a53396e','参赛对象','subevent_network_2026')
route(26,'32d56e84bf4d6a53396e','net.c4best.cn|报名','web',
      '当前核实网络技术挑战赛官网，团队按其赛项规则报名和提交作品；本目录其他大数据、天梯、移动应用、AI创意子赛独立报名，不能共用一套全国截止。','http://net.c4best.cn',scope='subevent_network_2026')
field(27,'description','第十八届蓝桥杯全国大学生软件和信息技术大赛设软件、电子、人工智能、数字科技创新、视觉艺术设计和专项赛等类别，各类别科目、组别、作品提交及报名时间分开管理；保留已有赛道和科目数据。','b1fce07b565f74f91708','大赛赛项')
field(27,'organizers',['蓝桥杯全国大学生软件和信息技术大赛组委会'],'b1fce07b565f74f91708','中国软件行业协会指导下')
eligibility(27,'第十八届面向具有正式全日制学籍的研究生、本科生、高职高专学生，以报名时在校学籍为准；各科目按学历及院校分组，具体参赛科目和组别分别核对。中国软件行业协会为指导单位，不写为本届主办。','b1fce07b565f74f91708','全日制|参赛对象')
route(27,'f15cb3684f7ab35a2ca2','报名时间说明|报名审核通过','web',
      '第十八届在蓝桥杯官网选择赛项，完成注册、身份审核及报名手续；审核通过且收到报名费才算报名成功。软件/电子/AI/鸿蒙应用开发至2026年12月18日14:00，视觉/数字科技创新至2027年4月26日14:00，主视觉及IP文创专项至2026年11月30日14:00；学校内部报销、审核时间另依本校通知。','https://dasai.lanqiao.cn/')
field(27,'scheduleNote','第十八届官方费用说明：软件赛、电子赛、人工智能、鸿蒙应用开发报名2026年10月8日10:00—12月18日14:00；视觉艺术设计、数字科技创新报名及作品提交2026年10月8日10:00—2027年4月26日14:00；主视觉与赛事IP文创设计专项2026年9月8日14:00—11月30日14:00。第十七届历史赛程不再代表当前第十八届；保留已有各赛道/科目分项信息。','f15cb3684f7ab35a2ca2','报名时间说明')
for name,start,end in [('第十八届软件/电子/AI/鸿蒙报名','2026年10月8日10:00','2026年12月18日14:00'),('第十八届视觉/数字创新报名及作品','2026年10月8日10:00','2027年4月26日14:00'),('第十八届主视觉/IP文创专项','2026年9月8日14:00','2026年11月30日14:00')]:
    ROWS[26]['stages'].append(dict(name=name,start=start,end=end,applicableTo=name,evidence=evidence('f15cb3684f7ab35a2ca2','报名时间说明')))
field(27,'nearestDeadline','2026年11月30日14:00','f15cb3684f7ab35a2ca2','报名时间说明','subevent_visual_IP_2026')
eligibility(28,'按现有2026通知，设本科生研究生组、高职高专组、高校教师组、专业设计师；学生组含在校及毕业五年内相关学生，教师组含高校在职教师及聘任行业导师、兼职教师。各专项要求另核。','9d3820bc050b1011a50a','参赛人员')
route(28,'9d3820bc050b1011a50a','网上报名渠道','web',
      '通过组委会指定的设计者登录页面在线报名及提交作品；学校、赛区选拔后推荐全国评选，本研组与高职组分开评审。','https://milan-aap.org.cn/#/designer/login')
eligibility(29,'2026创意赛每队不超过3人（研究生不超过1人），队长须本专科生；初创赛不超过7人（研究生不超过2人），允许毕业五年内成员，队长须为企业法人且为本专科在校生或毕业五年内全日制毕业生。可跨校，指导1—2人；仅适用于创意/初创赛。','c67855bc9c5bb897a391','参赛|研究生','subevent_creative_startup_2026')
route(29,'c67855bc9c5bb897a391','五、报名方式|其它具体细则','school_unified',
      '2026创意/初创赛长江大学校内参考：先加入校通知竞赛QQ群452997252，群昵称为真名和学号，由校内发布后续资料及组织事项；全国官网用于核对正式细则。现存西北赛区旧入口只服务对应赛区，不能作为本条或全国所有赛区的统一入口。','http://gd.moocollege.com/home/homepage',scope='school_reference')
field(30,'description','集成电路领域创新创业赛事，学生围绕企业赛题开展芯片、电子系统及应用方案设计，提交项目材料并通过初赛、分赛区及全国决赛评审。2026年第十届的赛题和分区安排分别适用。','bd1f360edfbf64be6531','集成电路|赛题')
route(30,'bd1f360edfbf64be6531','报名|univ.ciciec.com','web',
      '通过集成电路创新创业大赛官网注册并选择赛题，填写团队、指导和作品资料，按题目提交要求参加后续评审。校内选拔或组织要求只适用于该校，不代替全国赛题规则。','http://univ.ciciec.com/')
eligibility(31,'中国地质大学（武汉）校内选拔参考：在读本科生，学习过金属材料及热处理等课程，具备金相制备、显微观察、磨制抛光浸蚀等基础。该校课程前置条件不能推广为全国统一资格。','1199207efb6e3f020db6','参赛对象','school_reference')
route(31,'1199207efb6e3f020db6','参赛报名','school_unified',
      '中国地质大学（武汉）2026校内选拔参考：通过校通知QQ群报名，入群注明班级、姓名，校内训练选拔后组织参赛。3月16日仅为本校登记截止；全国统一报名平台与名额规则尚待正式章程。',scope='school_reference')
route(32,'2f08058b9ad0e84f21a7','赛事通道|高校主管','web',
      '从全国大学生信息安全竞赛官网“赛事通道”分别进入作品赛或创新实践能力赛；实践赛学生邀请指导教师后由高校主管在“学校参赛信息—参加创新实践能力赛队伍”审核。第十九届作品赛与第二十届实践赛并列显示，须先确认届次和赛别。','http://www.ciscn.cn/')
route(33,'9c322982c04044bab2e3','我要参赛|学院','web',
      '登录NCDA官网，选择对应赛道“我要参赛”，使用学校/学院标识按要求注册、上传作品和说明；学校审核、赛区评审、全国评审逐级进行，各专项另有通知。','https://www.ncda.org.cn/')
field(33,'description','未来设计师·全国高校数字艺术设计大赛围绕数字艺术、设计创新及相关命题征集师生作品，经学校组织、赛区和全国评审；2026第十四届赛程已录入时间说明，按常规与专项分别适用。','b9c069f993b6ea9148ad','全国高校数字艺术设计大赛|赛程')
eligibility(34,'长春工程学院2026校内预赛面向本校大一至大四本科生、研究生及其他对力学感兴趣同学，要求学过理论力学、材料力学或工程力学等课程，并选择力学相关教师指导。仅为校内预赛要求，不替代全国完整资格。','d02508680710e20a8674','参赛对象|参赛要求','school_reference')
route(34,'d02508680710e20a8674','ccit.yuntop.com','school_unified',
      '长春工程学院校内预赛参考：使用本校云竞赛平台报名，按校内通知参加预赛和选拔；该平台只服务本校。全国第十六届的统一报名和资格须另按正式通知确认。','https://ccit.yuntop.com/',scope='school_reference')
eligibility(35,'2026过程装备实践与创新赛项：本科生、研究生按最高学籍分组，同校组队，每队不超过4名学生和1—2名指导，不跨省/区域重复参赛，先校内选拔再由区域推荐全国。不适用于整个机械工程创新创意系列的所有分赛。','79a6024f9810616dcfe8','参赛对象|参赛团队','subevent_process_equipment_2026')
route(35,'79a6024f9810616dcfe8','gczbds.org|报名','web',
      '2026过程装备实践与创新赛项在该分赛官网按团队注册、提交参赛材料，经校内选拔及省级/区域推荐后进入全国赛。其他机械工程创新创意分赛有独立通道、资格和截止。','http://www.gczbds.org',scope='subevent_process_equipment_2026')
field(36,'description','中国机器人大赛暨RoboCup机器人世界杯中国赛设置多类机器人专项赛事，参赛队按赛项规则完成任务、技术竞技及评审；已核正式通知覆盖2026专项赛，全国资格和规则须按具体项目逐一确认。','3bd7690d62087ec74b6f','中国机器人大赛|专项赛')
field(36,'organizers',['中国自动化学会'],'3bd7690d62087ec74b6f','主办')
route(36,'6feff5dbf885b66e97f8','报名','school_unified',
      '所核高校通知采取校内统一组织：先按本校通知报队伍，再通过机器人赛事注册平台选择对应赛项登记；现存平台不代表所有专项均开放。校内选拔时间、名额只适用于发布学校。','https://robotreg.drct-caa.org.cn/',scope='school_reference')
route(37,'49c457e557aa8c4c8eeb','在线报名|报名表','web',
      '第15届在“中国软件杯”官网在线报名，选官方赛题，填队伍分工，下载报名表；初赛上传电子报名表，决赛提交学校/院系等盖章纸质版。初赛作品按各题页面提交源代码、可执行文件、文档和演示视频等；赛事公益免费，不向冒名收费账户付款。','https://www.cnsoftbei.com/')
route(38,'341a9e325d1fd0740f13','报名|创客','web',
      '按2026中美青年创客大赛通知，从教育部留学服务中心赛事官网选择分赛区，按对应规程报名和提交创客项目，经分赛区选拔推荐决赛。现有链接是赛事首页，尚未核实各分赛区的直达表单，不把长江大学联系人当全国联系人。','https://chinaus-maker.cscse.edu.cn',scope='notice_2026')
eligibility(39,'南通大学2026校内选拔参考：全日制在籍高校学生，每队1—3人，指导1—2人。不同赛项与全国组别限制仍须按RAICOM具体规程确认。','3b2465e6f49302c9e604','参赛对象','school_reference')
route(39,'3b2465e6f49302c9e604','报名方式|校内选拔后','school_unified',
      '南通大学2026参考：队伍由指导教师组队，报名表先报队长学院，学院盖章汇总至校内负责人；校选后参赛队仍需到RAICOM官网填报参赛信息。5月25日仅校内材料截止，全国报名原通知仅到月，未擅自补成某一天。','https://www.raicom.com.cn/',scope='school_reference')
eligibility(40,'湖南工业大学2026校赛参考：各年级本科生、研究生；工程实践和ICT基础赛道2人，产教融合5G+创新应用赛道4—6人。本校通知使用“信科赛”名称，不能直接代替原目录“大唐杯”的全国完整资格。','7b670af7f40dce5927ae','参赛对象|赛道二','school_reference')
route(40,'7b670af7f40dce5927ae','报名方式','school_unified',
      '湖南工业大学2026校赛参考：按通知腾讯文档填写“信科赛”校内报名表，加入校内群接收校赛安排。1月27日23:59为本校截止，校内表仅本校使用；全国“大唐杯/信科赛”的后续关系与通道仍需赛事正式通知确认。','https://docs.qq.com/form/page/DSXRYUkFSVnRSQkhU',scope='school_reference')
field(41,'organizers',['华为技术有限公司'],'f06aaaa0afa0469450d4','华为公司')
eligibility(41,'北京物资学院2026校内通知面向全日制在校本科生、研究生；实践、创新、编程等赛道组队要求不同，不能统一套用人数。全国赛道的完整条件仍按对应规则审核。','f06aaaa0afa0469450d4','参赛对象','school_reference')
route(41,'f06aaaa0afa0469450d4','报名|ict-academy','web',
      '在华为ICT大赛官方页面使用华为账号选择对应赛道，填写参赛信息；实践、创新、编程等赛道分别组队和提交材料，须配合本校竞赛负责人核对资格和队员。','https://e.huawei.com/cn/talent/ict-academy/#/ictcontest?compId=85132018')
route(42,'3480dac56fdf2d2f948f','socchina.net','web',
      '2026 FPGA创新设计赛道在竞赛官网选择该赛道报名，分本科生和研究生组，每队不超过3人，按所选厂商平台赛题提交作品。FPGA、芯片应用、芯片设计三个赛道相互独立，此入口说明仅针对FPGA通知。','https://www.socchina.net/',scope='subevent_FPGA_2026')
field(43,'organizers',['全国高等学校实验物理教学研究会','全国大学生物理实验竞赛组织委员会'],'9c66810d6022685e462a','主办单位')
route(43,'9c66810d6022685e462a','参赛高校负责本校学生','school_unified',
      '第12届物理实验竞赛（创新）由学校组织组队、报名、格式审查和赛前准备；各校按命题、自选、讲课等类别限额统一报送。国际赛道有独立资格，现有PDF未给出可核验的个人直达报名系统，不能用校内QQ群充作全国入口。')
route(44,'browser-bim-regulations','报名时间及方式','web',
      '从全国高校BIM毕业设计创新大赛官网选择相应模块报名。A—H模块截至2026年11月30日16:00；I—J模块同页同时出现2027年1月29日16:00及1月30日，冲突未解决，不能据较晚日期承诺仍可报名。校园负责人推荐名单与个人报名分别办理。','https://gxbsxs.glodonedu.com/')
ROWS[43]['notes'].append('BIM保留草稿：官方同页I—J报名截止同时存在2027年1月29日和30日，当前来源没有消除冲突；A—H截止2026年11月30日16:00已明确。')

eligibility(45,'当前核实的是品牌策划等分项正式规程；品牌策划按学生/团队身份及校级推荐参加，创业研究、会展、国贸和会计管理为独立分项。不同分赛的团队人数、年级与报名材料不能相互套用。','4d228cd94d8251ee0965','参赛|组别','subevent_brand_2026')
route(45,'4d228cd94d8251ee0965','报名|品牌','school_unified',
      '本条为五个分项聚合目录：现有2026赛程主要对应品牌策划，须由学校按该分项规程组织报名、选拔和推荐；创业研究的介绍或入口不能用于其余四个分项。当前不设置虚构的统一五赛报名URL。',scope='subevent_brand_2026')
eligibility(46,'具有本校正式学籍的全日制在校学生，同校组队1—3名学生、1—2名指导，每人限参加1队；学校赛事主管部门先指定并审核校级管理员。','3447c7f1c604e00454c2','报名条件')
route(46,'3447c7f1c604e00454c2','活动报名|学生端','web',
      '学校赛事部门先在学创杯官网“活动报名”申请校级管理员并上传申请表，审核后学生队长组队、邀请成员确认，再由校赛管理员按名额推选省赛。未办校赛学校也须由管理员指派并推选队伍。','http://www.xcbds.com/cyds/info/openPage?flag=1')
field(47,'organizers',['中国高校智能机器人创意大赛组委会'],'89f2ba7ef7dc2dc9b81b','组委会主办')
eligibility(47,'上海海事大学2026校内赛参考：面向本校工科专业在校本科生，人数按各赛项要求，每人限参加一队，鼓励跨专业/年级。全国专本科及研究生各赛道的完整限制尚未从官网JS页面核实。','89f2ba7ef7dc2dc9b81b','参赛对象及要求','school_reference')
route(47,'89f2ba7ef7dc2dc9b81b','报名方式|问卷星','school_unified',
      '上海海事大学2026校内赛由基础实验实训中心组织，扫描校通知图1问卷星二维码登记，再由学校选拔组织区域和全国赛。4月30日为该校截止；未核验的二维码不转换成猜测网址。全国官网另为robotcontest.cn。',scope='school_reference')
route(48,'078942e7d93a198da568','大赛报名与投稿','web',
      '第20届统一在中国好创意官网报名和上传作品，学生单元、教师单元分开。学生参赛遵守学校核定院系名称及校内投稿时间，教师作品按通知直通国赛；不能在学生作品作者栏混填教师。','https://www.cdec.org.cn/')
eligibility(49,'南通大学2026校内选拔参考：全日制在校本科生，每队1—3名学生、1—2名指导，可跨专业、跨年级；全国其他组别与赛项需独立核实，校选后按赛区和全国晋级规则报名。','c58ae17b39f8ddad1149','参赛对象','school_reference')
route(49,'c58ae17b39f8ddad1149','报名方式','school_unified',
      '南通大学2026参考：指导教师组织队伍，填写校内报名表，由学院汇总盖章并交校内负责人；校选后按赛事官网及具体赛项完成信息登记。校内截止不等于全国截止，现有全国决赛通知仅适用于已晋级队伍。','https://www.caairobot.com/',scope='school_reference')
route(50,'8150a5c757a26abef3b4','报名|校内','school_unified',
      '北京石油化工学院2026校内组织参考：项目团队按校内通知报作品申报和支撑材料，学校选拔后统一推荐全国竞赛；不得将本校报名联系人、名额和截止当作全国个人直报规则。',scope='school_reference')
route(51,'cdfa0a0189eae0653066','报名流程|4分钟','web',
      '关注“21世纪杯”微信服务号，底部“活动中心—活动报名”进入大学组。已合作学校学生进入校园选拔赛专区，其他学生按个人通道上传不超过4分钟演讲视频；地区与全国后续晋级分开进行。')
eligibility(52,'创新赛面向在校本硕博学生，创业赛允许毕业5年内学生；创新/创业通常2—5人、最多2名指导，不跨赛区重复报名；挑战赛独立题目和资格，不能统一套用。','ca9d76a41654f23e570c','参赛|指导')
route(52,'ca9d76a41654f23e570c','g-ican.com|报名','web',
      '在iCAN官网选择创新、创业或挑战赛相应入口，填写团队资料、选赛区，按该赛道提交作品。创新创业队与各挑战赛独立报名，2026年8月31日截止仅按所核通知范围使用。','https://www.g-ican.com/')
route(53,'3c9f5d75d8a636c7e48c','报名|gonghangbei','web',
      '通过工行杯大赛官网注册报名，也可按官方介绍从移动端官方渠道进入；选择赛道并提交金融科技项目资料，经审核参加后续评审，项目资格按相应组别核实。','https://www.gonghangbei.com/')
field(54,'organizers',['教育部','国家语言文字工作委员会'],'7bf9e56908eaa1a7cb36','教育部、国家语委决定举办')
eligibility(54,'经典诵写讲按诵读、讲解、书写、篆刻分赛设置学生、教师及社会等组别，具体对象不同；例如书写和篆刻大学生组含高职、研究生、留学生。应按学段、作品类别和分赛规则报名。','018f42f5dcc7215b25c6','参赛对象与组别','series_summary')
route(54,'7bf9e56908eaa1a7cb36','大赛组织|自主报名','web',
      '所有参赛者先在官网注册报名并参加知识测评。诵读赛由赛区选拔推荐；讲解、书写、篆刻在统一组织省份由赛区遴选，不统一组织的省份可官网自主报名并上传作品。先确认所在省和赛项，再执行对应流程。','https://jdsxj.eduyun.cn/')
eligibility(55,'团队现场赛中国学生本科院校组：中国籍、全日制高校在读，学段和年级不限；同校3人，最多1名英语类专业学生，不超过3名指导，不允许跨校。国际学生组、职业院校组、短视频赛独立适用资格。','dfd9e272a3ab9834932e','中国学生|英语类专业','subevent_undergraduate_institutions_2026')
route(55,'dfd9e272a3ab9834932e','报名|院校','school_unified',
      '按外教社杯官方章程，以学校为单位组织选拔和报名，先确认中国学生组、国际学生组或短视频赛对应规则，学校按分赛区要求提交队伍资料；现有原件未核实可供个人自由直报全部赛别的统一网址。')
eligibility(56,'2026大学生赛面向具有正式学籍的全日制本科生、研究生；按个人账户进行程序设计赛事报名，学校校内通知的联系安排仅供该校使用。','efda05e6ed48df23a3ca','参赛对象')
route(56,'efda05e6ed48df23a3ca','astar.baidu.com','web',
      '在百度之星赛事官网注册并登录，选择2026程序设计赛事报名，按初赛场次要求参赛；后续晋级和决赛另按通知执行。','https://astar.baidu.com/')
route(57,'581326240554c6299ed4','注册|加盖公章','school_unified',
      '在工业设计大赛平台注册填写信息，导出系统报名表，由全部作者签字并经学校教务等部门盖章，学校统一汇总报省级选拔；省赛推荐后参加全国评审。不是个人绕过学校直报国赛。','https://cuidc.net/#/')
field(58,'organizers',['全国高等学校计算机教育研究会','系统能力培养研究专家组','系统能力培养研究项目发起高校'],'7ee648e1b31fca6c9b05','主办')
ROWS[57]['scopeIssues'].append('计算机系统能力大赛六赛道独立报名，现只确认CPU官方系统；其余五赛道还需对应章程和系统，不把CPU入口泛化为统一入口。')
route(58,'255a293d3209a74657d4','CPU赛道','web',
      '2026 CPU设计赛（龙芯杯）从官方NSCSCC网站“报名”进入系统，按团体赛或个人赛规则报名；操作系统等其余五赛道独立办理。当前报名链接由同站官方导航明确提供，仅覆盖CPU赛道，未核实其他赛道的完整路径。','https://cpu.xtnl.org.cn/',scope='subevent_CPU_2026')
route(59,'ba6c864dceb07c78f3a6','注册|报名表','web',
      '学生用个人邮箱注册，指导教师账户经人工审核（通知说明约2个工作日）；队长建队并加入成员、指导教师，按要求上传报名表、方案和视频。作品初赛、分赛区及全国评审分阶段进行。','https://iot.sjtu.edu.cn/')
eligibility(60,'第23届线上挑战三个赛项均为个人赛，按中小学生、大学生/研究生及社会等赛区分类；学生需盖章报名表，社会赛区按通知不参加学生奖项评选。不可误设为高校组队赛。','ccde80509c1f0924e14d','个人|报名表')
route(60,'ccde80509c1f0924e14d','报名|个人','web',
      '从ISCC官网进入第23届线上挑战赛，按学历赛区个人注册并提交所需盖章报名表；各线上赛分别计赛，不用团队报名替代个人报名，其他实战/专题赛另按独立通知。','https://www.isclab.org.cn/',scope='subevent_online_challenge_2026')
eligibility(61,'2026大赛面向全国本科院校，参赛者在2026年7月应为在校本科生并上传学信网学籍证明；开发设计竞赛选手不得同时报名其他赛项/子赛项。不同子赛的专业组别和人数要求另见一号通知。','2b31538095f758b8b7ed','四、参赛对象|开发设计竞赛选手')
route(61,'2b31538095f758b8b7ed','五、报名方式|参赛单位审核','school_unified',
      '2026大赛先由学校/学院于5月16—31日登录两委会网站报名系统，指定唯一教师/教管领队，导出并上传盖章表；单人选手/团队组长再录入项目和成员照片、学信网证明，选手6月20日截止，学校6月25日前审核。本轮从学会一号通知扫描PDF第3页辨读核实，不再把空文本当没有报名信息。','http://smt.whu.edu.cn/')
field(61,'scheduleNote','2026一号通知区分：学校报名5月16—31日，选手报名6月20日截止，学校审核6月25日截止。二号通知：7月31日—8月1日在河南理工大学组织线上参赛、线下评审，各赛项具体时刻及初赛/答辩安排见二号通知；不能把学校审核日当学生报名截止。','2b31538095f758b8b7ed','五、报名方式')
ROWS[60]['stages'].append(dict(name='2026选手报名（学校先完成注册）',start=None,end='2026年6月20日',applicableTo='2026本科院校参赛选手；学校先注册、后审核',evidence=evidence('2b31538095f758b8b7ed','截止时间为6月20日')))
field(61,'nearestDeadline','2026年6月20日','2b31538095f758b8b7ed','截止时间为6月20日')
route(62,'21257c078555b01899f7','注册|学校|报名','school_unified',
      '学生同校组队，由学校先组织选拔；队员按通知在大赛平台实名注册和上传材料，学校审核公示后推荐省赛。5月17日是学校推荐节点，不能当作全国个人报名截止。','http://tjjmds.ai-learning.net/')
route(63,'df49f27fd996894f30d5','唯一渠道|作品联系人','web',
      '第13届由作品联系人统一在官网系统实名注册并报名，系统生成作品编号即报名成功；先报名再投稿，报名2026年11月17日—12月16日，作品提交2027年2月22日—3月13日。邮箱不接收报名或投稿，联系人报名后不能更换。','http://energy.qibebt.ac.cn/eneco/contribution/')
route(64,'527feeefceb75d0a75fc','团队注册|竞赛官网','web',
      '第14届团队通过竞赛官网注册、作品报名并提交材料，之后学校审核原创性、资格和材料完整性，再经赛区推荐全国评审。2026年10月23日23:59:59为作品申报阶段截止，后续校赛/赛区赛不是继续接受全国报名。','https://www.cmit.cn/')
route(65,'de601fabf8d8937776bf','湖北分区赛地址','web',
      '2026湖北分区赛：队长在税收风险管控案例大赛网站报名，完成要求的手续后将报名表按本校通知交校内负责人。当前入口和7月10日—9月20日窗口仅核实湖北分区，非全国各赛区共用截止。','http://ssfkds.moocollege.com',scope='regional_Hubei_2026')
route(66,'3b307fe75f16f4398a71','校内初赛报名网站','web',
      '所有校内初赛队伍须在摩课云平台报名；学校指定负责人审核队伍，按各赛道名额组织校内选拔并在系统确认全国复赛资格。研究生仅企业决策研究生组，其余分组不能混报；全国复赛缴费按后续正式通知办理。','https://ibizsim.moocollege.com')
route(67,'6ee493b96a623846ed7f','竞赛报名','school_unified',
      '哈尔滨工业大学（深圳）2026校内赛参考：组建4名学生、1—2名指导的同校团队，按本校群内要求登记并参加校选，学校推荐省赛。6月12日为本校报名，9月国赛仅原通知预计月份。全国独立平台尚未核实。',scope='school_reference')
route(68,'5d3925fbfd80a2b5499e','报名|aicomp.cn','web',
      '2026赛季从全球校园AI算法精英大赛官网选择具体赛道/赛题报名，同校学生组队，按题提交代码、模型或作品材料；各赛题报名、提交和评审时间独立，以已保存的赛道/赛题节点为准，不编造统一父项截止。','https://www.aicomp.cn/')
route(69,'3c4c22ee495b92360d0c','汇总表|申报书提交时间','school_unified',
      '有省赛的地区须先经省选拔，不受理绕过省赛直接申报；无省赛地区由高校领队统一提交盖章PDF及Excel作品汇总表，队伍再按类别上传申报书、研发/设计报告和视频至官网。缴费、作品提交、推荐是不同节点，不能互相代替。','https://uiaec.ujs.edu.cn/')
eligibility(70,'云南大学2026通知所述本科生和研究生分组：全日制在籍，不限专业，不跨校组队，每队4名学生、1—2名指导。本科组经网络选拔至国赛，研究生组本校选出2队直接参加全国赛；本校推荐名额不推广全国。','d085c6e7d9a33ce318df','报名要求|组队方式','school_reference')
route(70,'d085c6e7d9a33ce318df','报名|match.xmkeyun','school_unified',
      '先按学校组织办法组建财会职业能力参赛队并参加校内选拔，再由学校在科云杯赛事平台办理对应组别参赛；本校学生登记表及截止只适用于该校，全国各组报名以平台具体通知核对。','http://match.xmkeyun.com.cn/',scope='school_reference')
field(71,'description','2026第十届一带一路暨金砖国家技能发展与技术创新大赛包括技能类、技术创新类等多批独立赛项，围绕智能制造、人工智能、数字技术及非遗技艺等开展。第二批43个赛项各有组别、人数与报名截止，不能与另一“金砖国家职业技能大赛”混同。','c94b1c0b67ecc90f335f','大赛主题|第二批赛项共设')
field(71,'organizers',['金砖国家工商理事会中方理事会','一带一路暨金砖国家技能发展国际联盟','一带一路暨金砖国家技能发展与技术创新培训中心','金砖+国家科技创新联盟','中国发明协会','教育部中外人文交流中心'],'c94b1c0b67ecc90f335f','主办单位|联合主办单位')
eligibility(71,'2026第二批赛项分别设置中职、高职、本科、教师等组别，各赛项开放组别和团队人数不同，例如部分为单人、双人或三人赛；按附件1对应编号选择，不把某赛项资格推广全部。','c94b1c0b67ecc90f335f','中职组|本科组','batch2_2026')
route(71,'c94b1c0b67ecc90f335f','参赛报名方式','web',
      '在大赛信息服务平台明确选择“2026第十届一带一路暨金砖国家技能发展与技术创新大赛”入口，查看该赛项截止、组别和材料后报名；不得选成另一个金砖职业技能大赛。国际赛预报名另需加盖单位公章，不等于国内赛报名。','https://www.bricsacademy.org.cn/signup/index')
route(72,'a5bf0a24730f6dd4c2c4','报名方式及截止日期|材料要求','offline',
      '第10届由学校向属地省级剧协报送，省剧协汇总后于2026年7月31日前寄出（以邮戳为准）至中国剧协。学校准备盖章申报表1份、演出视频U盘2份及云盘链接/有效提取码，U盘存申报表和剧本；省剧协另分类汇总。无个人直报网址。',
      contact='组委会办公室：010-59759534、010-59759261；中国剧协中国校园戏剧节组委会办公室，邮编100083。详细通讯地址及各省剧协地址见正式通知附件。')


def main():
    if INVALID_ANCHORS:
        raise ValueError('Anchors absent in source caches:\n'+'\n'.join(INVALID_ANCHORS))
    prior = json.loads((ROOT/'artifacts/competition-information-audit-20261117/review-notes.json').read_text(encoding='utf-8'))
    for d,r,note in zip(ROWS,BASE,prior['rows']):
        d['priorTimeAssessment'],d['priorFollowup'] = note[1:3]
        d['priorWarnings'] = []
        old = ROOT/'artifacts/catalog-completion-20261116'/f"{r['id']}.json"
        if old.exists():
            j=json.loads(old.read_text(encoding='utf-8-sig'))
            d['priorWarnings'] = j.get('warnings',j.get('result',{}).get('warnings',[])) if isinstance(j,dict) else []
        checks=[]
        for s in r['sources']:
            if not s.get('url'):continue
            h=hashlib.sha256(s['url'].encode()).hexdigest()[:20]
            c=CACHES.get(h)
            f=OUT/'sources'/f'{h}.json'
            if f.exists():c=json.loads(f.read_text(encoding='utf-8-sig'))
            if c:
                checks.append({k:c.get(k) for k in ['url','checkedAt','status','observation','error']})
        d['sourceChecks']=checks
        d['unresolved'] = []
        keys = {f['key'] for f in d['fields']}
        if not r['organizers'] and 'organizers' not in keys:d['unresolved'].append('全国主办单位尚无可核实的本届明确原文；不将学校内部承办机构或网站页脚当全国主办。')
        if not json.loads(r['eligibilityJson'] or '{}') and 'eligibility' not in keys:d['unresolved'].append('全国详细参赛资格未核实，需本届章程或对应赛项规则。')
        if not d['entries'] and not r['entries']:d['unresolved'].append('可执行的报名路径尚未核实；已保留本轮读取结果与原因，不能视为可报名。')
        if d['scopeIssues']:d['unresolved'] += d['scopeIssues']
        d['unresolved'] += d['notes']
        if not r['nearestDeadline'] and 'nearestDeadline' not in keys:
            d['unresolved'].append('尚无适用于父项的统一精确报名截止；查看分赛/地区/学校的赛程说明，未补造日期。')
    manifest=dict(repairId='FIX-20261117-02',createdAt=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),
                  publicationPolicy='preserve',rowCount=72,rows=ROWS)
    (OUT/'repair-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'rows':72,'fieldDecisions':sum(len(r['fields']) for r in ROWS),'newRoutes':sum(bool(r['entries']) for r in ROWS),
                      'hosts':sum(any(f['key']=='organizers' for f in r['fields']) for r in ROWS),
                      'eligibility':sum(any(f['key']=='eligibility' for f in r['fields']) for r in ROWS)},ensure_ascii=False))


if __name__=='__main__':main()
