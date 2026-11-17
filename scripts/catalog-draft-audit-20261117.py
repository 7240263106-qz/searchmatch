"""Evidence-backed follow-up audit of the deployed school competition catalog."""
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'artifacts' / 'catalog-draft-audit-20261117'
HOST = 'admin@47.116.143.62'


def remote_python(code):
    result = subprocess.run(
        ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', HOST,
         'sudo -n python3 -'], input=code, encoding='utf-8',
        capture_output=True, timeout=120)
    if result.returncode:
        raise RuntimeError(result.stderr or result.stdout)
    return json.loads(result.stdout)


def write(name, value):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def snapshot():
    result = remote_python(r'''
import collections,datetime,json,os,sqlite3
from pathlib import Path
now=datetime.datetime.now(datetime.timezone.utc).isoformat()
p=Path('/opt/competition-sj/shared/competition.db')
c=sqlite3.connect('file:'+p.as_posix()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
backup=Path('/opt/competition-sj/backups/catalog-draft-audit-20261117-before.db')
if not backup.exists():
    with sqlite3.connect(backup) as dest: c.backup(dest)
rows=[]
for item in c.execute("SELECT * FROM Competition WHERE deletedAt IS NULL AND demoFlag=0 AND parentId IS NULL AND dataOrigin='formal' ORDER BY createdAt,id").fetchall():
    row=dict(item)
    for table,key in [('SourceMaterial','sources'),('FieldEvidence','fieldEvidence'),('RegistrationStage','stages'),('ReviewRecord','reviews'),('SignupEntry','entries')]:
        row[key]=[dict(r) for r in c.execute('SELECT * FROM '+table+' WHERE competitionId=?',(row['id'],))]
    row['organizers']=[dict(r) for r in c.execute('SELECT o.name,o.officialSite,co.role FROM CompetitionOrganizer co JOIN Organizer o ON o.id=co.organizerId WHERE co.competitionId=?',(row['id'],))]
    rows.append(row)
logs=[]
for file in sorted(Path('/opt/competition-sj/shared/agent-logs').glob('*.jsonl')):
    counts=collections.Counter();samples=[]
    for line in file.open(encoding='utf-8'):
        try: item=json.loads(line)
        except ValueError: continue
        if item.get('reason'): counts[item['reason']]+=1
        if item.get('level') in ('error','warning'): samples.append({k:item.get(k) for k in ['at','runId','competitionId','stage','reason','message','url']})
    logs.append({'file':file.name,'reasons':dict(counts),'warnings':samples})
print(json.dumps({'at':now,'target':'production','backup':str(backup),'rows':rows,'logs':logs},ensure_ascii=False))
''')
    if (OUTPUT / 'before.json').exists():
        write('current.json', result)
    else:
        write('before.json', result)
    rows = result['rows']
    catalog = [r for r in rows if r.get('schoolRecognitionLevel') in ('A类', 'B类', 'C类')]
    summary = {
        'records': len(rows), 'schoolCatalog': len(catalog),
        'statuses': dict(__import__('collections').Counter(r['publishStatus'] for r in rows)),
        'credibility': dict(__import__('collections').Counter(r['credibility'] for r in rows)),
        'noSchedule': [{'id':r['id'],'name':r['name']} for r in catalog if not r['scheduleNote']],
        'logFiles': [{'file':r['file'],'reasons':r['reasons']} for r in result['logs']],
        'backup':result['backup'],
    }
    write('inventory.json', summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if sys.argv[1:] == ['snapshot']:
        snapshot()
    else:
        raise SystemExit('Usage: catalog-draft-audit-20261117.py snapshot')
