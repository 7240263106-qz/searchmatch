"""Production API acceptance after repair; all application requests are read-only."""
import datetime
import json
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT/'artifacts/competition-information-repair-20261117/after'


def main():
    access=json.loads((Path.home()/'.ssh/competition-sj-access.json').read_text(encoding='utf-8-sig'))
    session=requests.Session();session.auth=(access['username'],access['password'])
    base=access['url'].rstrip('/')+'/api/v1'
    baseline=json.loads((ROOT/'artifacts/competition-information-repair-20261117/before/database-snapshot.json').read_text(encoding='utf-8'))['rows']
    originally_draft={r['id'] for r in baseline if r['publishStatus']=='draft'}
    dbby={}
    def get(path,body=None):
        response=session.get(base+path,timeout=40) if body is None else session.post(base+path,json=body,timeout=40)
        response.raise_for_status();return response.json()['data']
    ready=get('/readyz');bootstrap=get('/system/client-bootstrap')
    assert ready['status']=='ok' and ready['dependencies']=={'database':'ready','parser':'ready'}
    assert ready['configuration']['pendingRestart']==0 and bootstrap['profile']=='prod'
    manifest=json.loads((ROOT/'artifacts/competition-information-repair-20261117/repair-manifest.json').read_text(encoding='utf-8'))
    details=json.loads((OUT/'api-details.json').read_text(encoding='utf-8'))['rows']
    database=json.loads((OUT/'database-snapshot.json').read_text(encoding='utf-8'))['rows']
    by={r['id']:r for r in details};dbby={r['id']:r for r in database}
    assert len(database)==len(details)==72
    for d in manifest['rows']:
        row=by[d['id']]
        assert all(isinstance(v,str) for v in row['eligibility'].values())
        assert all(e['note'] and e['lastCheckedAt'] and e['status'] in ('unverified','accessible','login_required','temporarily_unavailable','suspected_invalid') for e in row['entries'])
        assert row['versionNo']==dbby[d['id']]['versionNo']
        if row['publishStatus']!=d['publishStatus']:
            assert row['id'] in originally_draft and row['publishStatus']=='published'
        versions=get('/competitions/'+row['id']+'/versions')
        external_approved=row['publishStatus']!=d['publishStatus']
        assert any(v['versionNo']==row['versionNo']-(2 if external_approved else 0) for v in versions)
        if external_approved:
            response=session.get(base+'/audit-logs',params={'objectType':'competition','objectId':row['id']},timeout=35)
            response.raise_for_status();logs=response.json()['data']
            assert any(x['action']=='competition.publish' for x in logs)
        response=session.get(base+'/audit-logs',params={'objectType':'competition','objectId':row['id']},timeout=35)
        response.raise_for_status();logs=response.json()['data']
        assert any(x['action']=='competition.information_repair' for x in logs)
        assert not any(x in (row.get('description') or '') for x in ['待补充','to_be_announced'])
    for i in [24,27,10,61]:
        d=manifest['rows'][i-1];row=by[d['id']]
        expected=next(f['value'] for f in d['fields'] if f['key']=='nearestDeadline')
        assert row['nearestDeadline']['precision']==('second' if ':' in expected else 'day')
        assert row['nearestDeadline']['rawText']==expected or row['nearestDeadline']['rawText'] is None
        if row['nearestDeadline']['rawText'] is None:
            assert any(s['endAt'] and s['endAt']['rawText']==expected for s in row['stages'])
        assert any(s['endAt'] and s['endAt']['rawText']==expected and s['endAt']['precision']==row['nearestDeadline']['precision'] for s in row['stages'])
    assert by[manifest['rows'][43]['id']]['completeness']=='conflict'
    bim=by[manifest['rows'][43]['id']]
    assert bim['nearestDeadline']['rawText']=='2026年11月30日16:00'
    assert bim['nearestDeadline']['precision']=='second'
    assert any(s['endAt'] and s['endAt']['rawText']=='2026年11月30日16:00' and s['endAt']['precision']=='second' for s in bim['stages'])
    public=get('/competitions?limit=100')
    publicRows=public if isinstance(public,list) else public.get('items',[])
    draftSearch=get('/search/competitions',{'scope':'workspace','includeExpired':True,'includeLowCredibility':True,'limit':100})
    assert len(draftSearch['items'])==72
    external_publications=[{'index':d['index'],'id':d['id'],'name':by[d['id']]['name']} for d in manifest['rows']
        if d['publishStatus']=='draft' and by[d['id']]['publishStatus']=='published']
    result={'at':datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),
        'apiDetails':72,'catalogRows':len(publicRows),'parentRows':72,
        'publishedAtInformationRepairStart':64,'draftsAtInformationRepairStart':8,
        'currentPublished':len(publicRows),'currentDrafts':sum(r['publishStatus']=='draft' for r in details),
        'externalApprovedPublications':external_publications,
        'readyz':ready,'clientProfile':bootstrap['profile'],'allFieldsAndEvidenceReadable':True,
        'allEntryChecksPresent':True,'auditLogsVerified':72,'versionsVerified':72,
        'timePrecisionVerified':[24,27,10,61,44],'draftBimConflictPreserved':True,
        'httpWrites':['POST /search/competitions (read query only)'],'result':'passed'}
    (OUT/'api-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':main()
