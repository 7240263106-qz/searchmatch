"""Generate the Chinese itemized acceptance package from the final captured state."""
import collections
import csv
import datetime
import json
import shutil
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'artifacts/competition-information-repair-20261117'


def read(path):return json.loads(path.read_text(encoding='utf-8-sig'))


def present(value):
    return bool(value and str(value).strip() not in ('to_be_announced','待补充','待公布','待定','暂无','详见官网','以官方通知为准'))


def main():
    before=read(OUT/'before/database-snapshot.json')['rows'];after=read(OUT/'after/database-snapshot.json')['rows']
    manifest=read(OUT/'repair-manifest.json');probes={r['url']:r for r in read(OUT/'entry-probes.json')['rows']}
    verify=read(OUT/'after/verification.json');api=read(OUT/'after/api-verification.json')
    def metrics(rows):
        return {'description':sum(present(r['description']) for r in rows),
            'organizers':sum(bool(r['organizers']) for r in rows),
            'eligibility':sum(present(read_value(r)) for r in rows),
            'substantiveSignupNote':sum(present(r['signupNote']) for r in rows),
            'checkedEntries':sum(bool(e['lastCheckedAt'] and e['internalReason']) for r in rows for e in r['entries'])}
    def read_value(r):return json.loads(r['eligibilityJson']).get('eligibility')
    # read_value is defined before this function executes; metrics is called below.
    old,new=metrics(before),metrics(after)
    scopes=collections.Counter(d['entries'][0]['scope'] for d in manifest['rows'])
    with (OUT/'逐项修复验收清单.csv').open('w',encoding='utf-8-sig',newline='') as f:
        w=csv.writer(f);w.writerow(['序号','比赛名称','发布状态','完整性','可信度','主办方','比赛介绍','参赛条件','报名方式','报名路径与步骤','报名链接','报名核验状态与原因','赛程说明','最近截止（适用阶段）','新增/修正来源','原文摘录及SHA256','适用范围','仍需补核/跳过原因'])
        for r,d in zip(after,manifest['rows']):
            entries=r['entries'];checked=[]
            for e in entries:
                reason=json.loads(e['internalReason']) if e['internalReason'] else {}
                observation=reason.get('observation',{})
                checked.append(f"{e['url'] or '无个人网页'}｜{e['status']}｜{e['lastCheckedAt']}｜{observation.get('reason') or observation}")
            sources=[];quotes=[]
            for field in d['fields']:
                ev=field['evidence'];sources.append(ev['url']);quotes.append(f"{field['key']}｜{ev['url']}｜{ev['sha256']}｜{ev['snippet']}")
            deadline=next((f"{s['endRawText']}｜{s['applicableTo']}" for s in r['stages'] if s['endAt']==r['nearestDeadline']),r['nearestDeadline'] or '未设置父项统一截止；见分赛/校内说明')
            w.writerow([d['index'],r['name'],r['publishStatus'],r['completeness'],r['credibility'],
                '；'.join(o['name'] for o in r['organizers']) or '未核实本届主办方',r['description'],read_value(r) or '未核实完整参赛资格',
                r['signupMethod'],r['signupNote'],'\n'.join(e['url'] or '组织/线下流程' for e in entries),'\n'.join(checked),
                r['scheduleNote'],deadline,'\n'.join(dict.fromkeys(sources)),'\n\n'.join(quotes),
                d['entries'][0]['scope'],'\n'.join(d['unresolved']) or '本轮字段范围内未发现新增缺口'])
    lines=['# 竞赛缺陷修复与验收报告','',
        '- 任务：FIX-20261117-02；执行日期：2026-11-17（Asia/Shanghai）。',
        '- 线上版本：`lean-20261117-03`；应用：`https://wonderofyou.xyz/competition/`。',
        '- 结论：72条正式父项（学校目录71项＋1条历史蓝桥父项）全部完成本轮核验并写回。',
        f"- 发布边界：修复前64已发布、8草稿，修复脚本均保留；另一批人工审核流程随后将8草稿批准发布，当前{api['currentPublished']}已发布、{api['currentDrafts']}草稿。本轮未擅自撤销该独立审核决定。",
        f"- 数据与来源验收：{verify['passed']}/{verify['checks']}项通过；API与日志验收：{api['result']}。",
        '- 重要边界：校内参考、单赛站/分赛项或历史流程不等于全国完整规则；公开网址可达不等于报名开放。','',
        '## 实际修复','',
        f"- 主修复263项字段决策；验收追加资格展示、可信度及3项原文交叉补录。",
        f"- 实质比赛介绍：{old['description']}→{new['description']}；主办方：{old['organizers']}→{new['organizers']}；参赛条件：{old['eligibility']}→{new['eligibility']}。",
        f"- 实质报名流程说明：{old['substantiveSignupNote']}→{new['substantiveSignupNote']}；所有72项均有流程或明确步骤。",
        f"- 报名入口记录现有{sum(len(r['entries']) for r in after)}条，{new['checkedEntries']}条均有本轮核验时间和真实原因；无网址的学校/线下流程不冒充网页已验证。",
        '- 每项写入ReviewRecord、FieldEvidence、CompetitionVersion、OutboxEvent及链式AuditEntry；历史证据、赛道、原件未删除，发布另见独立审核版本记录。',
        '- 日期：服务外包延至3月31日16:00；蓝桥第18届分赛道截止；BIM A—H为11月30日16:00。匹配阶段保留second/day精度和原文。',
        '- 代码：修复列表/草稿/详情的阶段时间精度、占位字段完整性判定、报名网址遮住步骤；报名范围元数据从资格正文中分离。','',
        '## 范围与缺口','',
        f"- 全国流程{scopes['national']}项；校内参考{scopes['school_reference']}项；其余{72-scopes['national']-scopes['school_reference']}项限定分赛项、地区或历史届次。逐行范围见CSV。",
        f"- 仍有{72-new['organizers']}项未核实本届明确主办方、{72-new['eligibility']}项没有可补录的资格正文；均保留缺项，不拿校内机构或页脚冒充。",
        '- 58项没有适用于父项的统一精确截止。聚合赛、分赛项和校级安排不能伪造统一日期；可核实阶段另存RegistrationStage。',
        '- BIM仍保留conflict：同一官方页I—J截止同时出现2027年1月29日16:00与1月30日，未擅自选择。其发布状态变化由另一批审核执行，不代表冲突已消除。',
        '- 结构设计全国章程、系统能力除CPU外的其余赛道、测绘扫描件全文以外细目等仍待对应正式通知；日志记录已读、空壳/受阻和不采用原因。','',
        '## 验证记录','',
        '- 本地：13个测试文件、141项测试通过；typecheck、build通过。生产前端另以`--base=/competition/`构建并逐资源SHA256一致。',
        '- 副本：先复制生产备份，隔离执行、回读和验收后才写生产；本轮信息修复脚本没有发布草稿或执行真实报名/缴费。',
        '- 生产：`readyz`数据库/解析器均ready，配置profile=prod，pendingRestart=0；DB quick_check=ok。',
        '- 页面：真实生产API只读代理至本机浏览器验收，确认网址＋步骤＋联系方式同时显示；截图时BIM仍为草稿，之后独立审核才发布，冲突提示仍保留。未把本机验收地址当公开链接。',
        '- 版本限制：后续独立审核publish未生成对应CompetitionVersion，故`GET /competitions/:id/versions`不展示最终发布版本；当前发布值、ReviewRecord与链式审计已在DB/API核验，不伪称版本接口完整。','',
        '## 证据与回滚','',
        '- `repair-manifest.json`、`execution.json`、`postflight-execution.json`、`supplement-execution.json`：逐项决策与执行。',
        '- `sources/`、`entry-probes.json`：来源正文、附件和公开入口探测；扫描PDF辨读方法、页图和PDF哈希另存。',
        '- `after/verification.json`、`after/api-verification.json`、`after/deployed-web-verification.json`、`after/ui-*.jpg`：最终验收。',
        '- `逐项修复验收清单.csv`：72项完整字段、来源、原文摘录、范围与剩余问题。',
        '- 生产修复前备份：`/opt/competition-sj/backups/information-repair-20261117-before.db`；旧版本目录保留。回滚须先停写/核对当前修订，不直接覆盖后续用户修改。','']
    (OUT/'竞赛缺陷修复与验收报告.md').write_text('\n'.join(lines),encoding='utf-8')
    evidence=ROOT/'project-os/evidence/T-20261117-INFORMATION-REPAIR';evidence.mkdir(parents=True,exist_ok=True)
    for name in ['repair-manifest.json','execution.json','postflight-execution.json','supplement-execution.json','deadline-normalization-execution.json','entry-probes.json','api-tests.log','typecheck.log','build.log','web-production-build.log','逐项修复验收清单.csv','竞赛缺陷修复与验收报告.md']:
        shutil.copy2(OUT/name,evidence/name)
    for name in ['database-snapshot.json','api-details.json','verification.json','api-verification.json','health.json','deployed-web-verification.json','ui-signup-note.jpg','ui-bim-draft.jpg']:
        if (OUT/'after'/name).exists():shutil.copy2(OUT/'after'/name,evidence/name)
    print(json.dumps({'before':old,'after':new,'databaseChecks':verify['checks'],'api':api['result'],'scopes':dict(scopes)},ensure_ascii=False))


if __name__=='__main__':main()
