"""Capture and verify the exact repair, including preservation and evidence integrity."""
import collections
import datetime
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT/'artifacts/competition-information-repair-20261117'
HOST = 'admin@47.116.143.62'


def read(p): return json.loads(p.read_text(encoding='utf-8-sig'))


def capture(db, folder):
    code = '''
import sqlite3,json,sys,datetime
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
c.execute('PRAGMA query_only=ON');c.execute('BEGIN')
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'databaseQuickCheck':[r[0] for r in c.execute('PRAGMA quick_check')],'rows':[]}
for raw in c.execute("SELECT * FROM Competition WHERE deletedAt IS NULL AND demoFlag=0 AND dataOrigin='formal' ORDER BY createdAt,id").fetchall():
 r=dict(raw)
 for table,key in [('SourceMaterial','sources'),('FieldEvidence','fieldEvidence'),('RegistrationStage','stages'),('ReviewRecord','reviews'),('SignupEntry','entries')]:
  r[key]=[dict(x) for x in c.execute('SELECT * FROM '+table+' WHERE competitionId=?',(r['id'],))]
 r['organizers']=[dict(x) for x in c.execute('SELECT o.name,o.officialSite,co.role FROM CompetitionOrganizer co JOIN Organizer o ON o.id=co.organizerId WHERE co.competitionId=?',(r['id'],))]
 r['documents']=[dict(x) for x in c.execute('SELECT d.id,d.fileName,d.parseStatus,l.locationNote FROM DocumentCompetitionLink l JOIN CompetitionDocument d ON d.id=l.documentId WHERE l.competitionId=?',(r['id'],))]
 r['repairVersions']=[dict(x) for x in c.execute("SELECT * FROM CompetitionVersion WHERE competitionId=? AND reason LIKE '%FIX-20261117-02%'",(r['id'],))]
 r['repairAudits']=[dict(x) for x in c.execute("SELECT * FROM AuditEntry WHERE objectId=? AND action='competition.information_repair'",(r['id'],))]
 r['repairPostflight']=[dict(x) for x in c.execute("SELECT * FROM AuditEntry WHERE objectId=? AND action='competition.information_repair_postflight'",(r['id'],))]
 r['repairSupplement']=[dict(x) for x in c.execute("SELECT * FROM AuditEntry WHERE objectId=? AND action='competition.information_repair_supplement'",(r['id'],))]
 r['repairDateNormalization']=[dict(x) for x in c.execute("SELECT * FROM AuditEntry WHERE objectId=? AND action='competition.information_repair_date_normalization'",(r['id'],))]
 r['repairOutbox']=[dict(x) for x in c.execute("SELECT * FROM OutboxEvent WHERE objectId=? AND payloadJson LIKE '%FIX-20261117-02%'",(r['id'],))]
 out['rows'].append(r)
print(json.dumps(out,ensure_ascii=False))
'''
    p = subprocess.run(['ssh','-o','BatchMode=yes',HOST,'sudo -n python3 - '+db],input=code,
                       capture_output=True,encoding='utf-8',timeout=100)
    if p.returncode: raise RuntimeError(p.stderr[:500])
    folder.mkdir(parents=True,exist_ok=True)
    (folder/'database-snapshot.json').write_text(p.stdout,encoding='utf-8')


def instant(raw, end=False):
    parts = re.findall(r'\d+',raw)
    y,m,d=map(int,parts[:3]); h,mi,s=(list(map(int,parts[3:]))+[0,0,0])[:3]
    if end and len(parts)==3: h,mi,s=23,59,59
    return int(datetime.datetime(y,m,d,h,mi,s,tzinfo=datetime.timezone(datetime.timedelta(hours=8))).timestamp()*1000)


def verify(folder):
    before=read(OUT/'before/database-snapshot.json')['rows']; after=read(folder/'database-snapshot.json')
    rows=after['rows']; by={r['id']:r for r in rows}; manifest=read(OUT/'repair-manifest.json')
    probes={p['url']:p for p in read(OUT/'entry-probes.json')['rows']}; checks=[]
    def check(ok,name,index=None):
        checks.append(dict(ok=bool(ok),name=name,index=index))
    check(after['databaseQuickCheck']==['ok'],'SQLite quick_check')
    check(len(rows)==72 and {r['id'] for r in before}==set(by),'72父项身份保持')
    summary=[]
    for b,d in zip(before,manifest['rows']):
        a=by[b['id']];i=d['index']
        check(a['name']==b['name'] and a['parentId']==b['parentId'],'比赛名称与父子关系保持',i)
        extra=len(a.get('repairPostflight',[]))+len(a.get('repairSupplement',[]))+len(a.get('repairDateNormalization',[]))
        externally_published=b['publishStatus']=='draft' and a['publishStatus']=='published'
        check(extra<=3 and a['versionNo']==b['versionNo']+1+extra+(2 if externally_published else 0),'修复版本与后续审核发布可追溯',i)
        check(all(isinstance(v,str) for v in json.loads(a['eligibilityJson']).values()),'资格保持字符串展示契约',i)
        if externally_published:
            check(b['publishStatus']=='draft' and a['publishStatus']=='published' and a['publishedAt'],'独立审核发布状态与记录一致',i)
        else:check(a['publishStatus']==b['publishStatus'] and a['publishedAt']==b['publishedAt'],'发布状态及发布时间保持',i)
        check(a['documents']==b['documents'],'原件及文档关联保留',i)
        check(all(s in a['sources'] for s in b['sources']),'原有来源原样保留',i)
        check(all(e in a['fieldEvidence'] for e in b['fieldEvidence']),'原证据及赛道原样保留',i)
        check(all(o in a['organizers'] for o in b['organizers']),'原主办关系保持',i)
        check({e['id'] for e in b['entries']} <= {e['id'] for e in a['entries']},'旧报名入口未删除',i)
        check(all(s in a['stages'] for s in b['stages']) if i!=24 else len(a['stages'])==len(b['stages']),'已有阶段保留（24按正式延期修正）',i)
        for f in d['fields']:
            k,v=f['key'],f['value'];actual=a.get(k)
            if k=='organizers': ok=all(any(o['name']==n and o['role']=='host' for o in a['organizers']) for n in v)
            elif k=='eligibility':ok=json.loads(a['eligibilityJson']).get('eligibility')==v
            elif k=='nearestDeadline':ok=actual==instant(v)
            else:ok=actual==v
            check(ok,'决策字段值:'+k,i)
            cache=read(ROOT/f['evidence']['cacheFile'])
            check(hashlib.sha256(cache['text'].encode()).hexdigest()==f['evidence']['sha256'],'来源正文SHA256:'+k,i)
            compact=re.sub(r'\s+','',cache['text'])
            check(all(re.sub(r'\s+','',s) in compact for s in f['evidence']['selectedAnchors']),'原文锚点存在:'+k,i)
            evs=[e for e in a['fieldEvidence'] if e['fieldName']==('organizer' if k=='organizers' else k) and e.get('locationJson') and json.loads(e['locationJson']).get('repairId')==manifest['repairId']]
            check(any(e['snippet']==f['evidence']['snippet'] and json.loads(e['locationJson']).get('scope')==f['scope'] for e in evs),'字段证据及范围已写入:'+k,i)
        for s in d['stages']:
            stage=next((x for x in a['stages'] if x['name']==s['name']),{})
            check(stage.get('endAt')==instant(s['end']) and stage.get('endPrecision')==('second' if ':' in s['end'] else 'day') and stage.get('applicableTo')==s['applicableTo'],'阶段精度及适用范围:'+s['name'],i)
        for e in a['entries']:
            check(bool(e['lastCheckedAt'] and e['internalReason']),'报名入口有真实核验时间与原因',i)
            if e['url']:
                check(e['status']==probes[e['url']]['status'],'报名状态与实际探测一致',i)
            else:check(e['status']=='unverified','组织/线下流程未伪装网页已验证',i)
        for e in d['entries']:
            check(any(x['note']==e['note'] and x['method']==e['method'] and x['url']==e['url'] for x in a['entries']),'报名步骤及方法实际入库',i)
        logs=[e for e in a['fieldEvidence'] if e['fieldName']=='informationRepairReview']
        check(len(logs)==1 and json.loads(logs[0]['fieldValue'])['repairId']==manifest['repairId'],'本轮逐项审核日志',i)
        check(len(a['repairVersions'])==1+extra and len(a['repairAudits'])==1,'本轮修复版本及审计完整',i)
        check(len(a['repairOutbox'])==1+extra,'修复事件完整',i)
        check(len(a['reviews'])==len(b['reviews'])+1+extra+(2 if externally_published else 0) and all(x in a['reviews'] for x in b['reviews']),'历史审核、修复与后续发布记录保留',i)
        if d['scopeIssues'] or any(f['scope']!='national' for f in d['fields']):check(a['completeness']!='complete','局部信息不冒充全国完整',i)
        summary.append(dict(index=i,id=a['id'],name=a['name'],publishStatus=a['publishStatus'],
            fields=len(d['fields']),route=a['signupNote'],scope=next((e['scope'] for e in d['entries']),None),
            completeness=a['completeness'],credibility=a['credibility'],unresolved=d['unresolved']))
    check(by[before[43]['id']]['completeness']=='conflict','BIM日期冲突未抹除')
    if any(r.get('repairSupplement') for r in rows):
        for d in read(OUT/'supplement-manifest.json')['rows']:
            a=by[d['id']]
            check(len(a.get('repairSupplement',[]))==1,'补充审核可追溯',d['index'])
            check(json.loads(a['eligibilityJson']).get('eligibility')==d['value'] if d['key']=='eligibility' else
                  all(any(o['name']==n for o in a['organizers']) for n in d['value']),'最终交叉检查补录字段一致',d['index'])
            cache=read(ROOT/d['evidence']['cacheFile'])
            check(hashlib.sha256(cache['text'].encode()).hexdigest()==d['evidence']['sha256'],'补充原文SHA256',d['index'])
    api_path=folder/'api-details.json'
    if api_path.exists():
        api_by={r['id']:r for r in read(api_path)['rows']}
        check(len(api_by)==72,'API包含72父项')
        for a in rows:
            detail=api_by[a['id']]
            check(detail['name']==a['name'] and detail['publishStatus']==a['publishStatus'] and detail['versionNo']==a['versionNo'],'API身份版本状态一致',a['id'])
            check(detail['description']==a['description'] and detail['schedule']==a['scheduleNote'],'API介绍与赛程一致',a['id'])
            check(detail['signupMethod']==a['signupMethod'],'API报名方式一致',a['id'])
            check(detail['eligibility'].get('eligibility')==json.loads(a['eligibilityJson']).get('eligibility'),'API资格正文一致',a['id'])
            check({e['id'] for e in detail['entries']}=={e['id'] for e in a['entries']},'API报名入口关系一致',a['id'])
            for entry in detail['entries']:
                old=next(e for e in a['entries'] if e['id']==entry['id'])
                check(entry['note']==old['note'] and entry['contact']==old['contact'],'API报名步骤/联系人与DB一致',a['id'])
            api_deadline=detail['nearestDeadline']
            if a['nearestDeadline'] is None:check(api_deadline is None,'无统一截止保持为空',a['id'])
            else:
                stage=next((s for s in a['stages'] if s['endAt']==a['nearestDeadline']),None)
                if stage:
                    expected=datetime.datetime.fromtimestamp(stage['endAt']/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
                    check(api_deadline=={'at':expected,'precision':stage['endPrecision'],'timezone':stage['endTimezone'] or 'Asia/Shanghai','rawText':stage['endRawText']},'API截止精度与匹配阶段一致',a['id'])
                else:check(api_deadline and api_deadline['at']==datetime.datetime.fromtimestamp(a['nearestDeadline']/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),'API回退截止值一致',a['id'])
    failures=[c for c in checks if not c['ok']]
    result=dict(checkedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),checks=len(checks),passed=len(checks)-len(failures),failures=failures,
        published=dict(collections.Counter(r['publishStatus'] for r in rows)),rows=summary)
    (folder/'verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:result[k] for k in ['checks','passed','failures','published']},ensure_ascii=False))
    if failures:raise SystemExit(1)


if __name__=='__main__':
    phase=sys.argv[1];folder=OUT/phase
    if len(sys.argv)>2:capture(sys.argv[2],folder)
    verify(folder)
