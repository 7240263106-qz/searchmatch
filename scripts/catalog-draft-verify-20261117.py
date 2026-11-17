"""Read back production DB and authenticated public API; produce the audit report."""
import collections
import datetime
import json
from pathlib import Path
import requests
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts/catalog-draft-audit-20261117'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


before = read(OUT / 'before.json')
after = read(OUT / 'current.json')
manifest = read(OUT / 'review-manifest.json')
execution = read(OUT / 'execution.json')
original = {r['id']: r for r in before['rows']}
current = {r['id']: r for r in after['rows']}
access = read(Path.home() / '.ssh/competition-sj-access.json')
base = access['url'].rstrip('/') + '/api/v1'
session = requests.Session()
session.auth = (access['username'], access['password'])
session.headers.update({'Accept': 'application/json'})
checks = []


def check(name, passed, **detail):
    checks.append({'check': name, 'passed': bool(passed), **detail})
    if not passed:
        print(json.dumps(checks[-1], ensure_ascii=False))


def api(path, body=None):
    response = session.get(base + path, timeout=40) if body is None else session.post(base + path, json=body, timeout=40)
    response.raise_for_status()
    return response.json()['data']


check('execution completed all 71', len(execution['rows']) == 71 and all(r['status'] == 'completed' for r in execution['rows']))
check('record identities preserved', set(original) == set(current))
for cid, row in original.items():
    next_row = current[cid]
    for key in ['name', 'parentId', 'schoolRecognitionLevel', 'publishStatus', 'ownerId', 'dataOrigin', 'demoFlag', 'deletedAt']:
        check('preserved ' + key, row.get(key) == next_row.get(key), id=cid)
    check('old source links preserved', {s['id'] for s in row['sources']} <= {s['id'] for s in next_row['sources']}, id=cid)
check('unrelated older Blue Bridge record unchanged', before['rows'][0] == after['rows'][0])
check('public ready', api('/readyz')['status'] == 'ok')
cards = api('/search/competitions', {'scope': 'workspace', 'includeExpired': True, 'includeLowCredibility': True, 'limit': 100})
check('workspace count 72', cards['page']['total'] == 72)
card_by_id = {c['id']: c for c in cards['items']}
details = []
canonical = lambda value: unquote(value).rstrip('/') if value else value
for d in manifest['rows']:
    row = current[d['id']]
    item = api('/competitions/' + d['id'])
    details.append(item)
    check('API identity and status', item['id'] == d['id'] and item['name'] == d['name'] and item['publishStatus'] == d['publishStatus'], index=d['index'])
    check('API schedule present and current', item['schedule'] == row['scheduleNote'] and bool(item['schedule']), index=d['index'])
    check('API score agrees', item['credibilityScore'] == row['credibilityScore'] and item['credibility'] == row['credibility'], index=d['index'])
    check('card score agrees', card_by_id[d['id']]['credibilityScore'] == row['credibilityScore'], index=d['index'])
    reviews = [e for e in row['fieldEvidence'] if e['fieldName'] == 'catalogFollowupReview']
    check('one follow-up review', len(reviews) == 1, index=d['index'])
    for p in d['pages']:
        src = next((s for s in row['sources'] if canonical(s['url']) == canonical(p['url'])), None)
        check('captured source saved', src and src['type'] == p['sourceType'], index=d['index'], url=p['url'])
        for f in p['fields']:
            field = {'competitionContent': 'description', 'scheduleNote': 'schedule', 'organizer': 'organizer',
                     'eligibility': 'eligibility', 'signupUrl': 'signupUrl', 'nearestDeadline': 'nearestDeadline'}[f['key']]
            actual = item.get(field)
            if field == 'eligibility':
                actual = actual.get('eligibility')
            elif field == 'signupUrl':
                actual = row['signupUrl']
                check('API signup entry saved', any(canonical(e.get('url')) == canonical(f['value']) for e in item['entries']), index=d['index'])
                check('field readback ' + field, canonical(actual) == canonical(f['value']), index=d['index'])
                evidence_field = 'signupUrl'
                check('signup quote linked', src and any(e['sourceId'] == src['id'] and e['fieldName'] == evidence_field
                      and e['snippet'] == f['quote'] for e in row['fieldEvidence']), index=d['index'])
                continue
            elif field == 'nearestDeadline':
                dt = datetime.datetime.fromisoformat(actual['at'].replace('Z', '+00:00'))
                expected = row['nearestDeadline'] / 1000
                check('exact deadline saved', abs(dt.timestamp() - expected) < 0.001, index=d['index'])
                continue
            check('field readback ' + field, actual == f['value'], index=d['index'])
            evidence_field = {'competitionContent': 'description', 'scheduleNote': 'schedule'}.get(f['key'], f['key'])
            check('quote and source linked', src and any(e['sourceId'] == src['id'] and e['fieldName'] == evidence_field
                      and e['snippet'] == f['quote'] and e['fieldValue'] == f['value'] for e in row['fieldEvidence']), index=d['index'])
    check('no unscoped new deadline', bool(row['nearestDeadline']) == bool(original[row['id']]['nearestDeadline']) or d['index'] in (44, 48), index=d['index'])
    for timing in d['stages']:
        check('scoped registration saved', any(s['name'] == timing['name'] and s['applicableTo'] == timing['applicableTo'] for s in row['stages']), index=d['index'])

school_before = [r for r in before['rows'] if r.get('schoolRecognitionLevel') in ('A类', 'B类', 'C类')]
school_after = [current[r['id']] for r in school_before]
counts = lambda rows: {'total': len(rows), 'credibility': dict(collections.Counter(r['credibility'] for r in rows)),
                       'noSchedule': sum(not r['scheduleNote'] for r in rows),
                       'noExactRegistrationDeadline': sum(not r['nearestDeadline'] for r in rows),
                       'publishStatus': dict(collections.Counter(r['publishStatus'] for r in rows))}
summary = {'reviewId': manifest['reviewId'], 'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'passed': all(c['passed'] for c in checks), 'checks': len(checks),
           'before': counts(school_before), 'after': counts(school_after), 'reviewed': len(manifest['rows']),
           'contentUpdated': sum(bool(d['pages']) for d in manifest['rows']),
           'serviceFieldWrites': sum(len(p['fields']) for d in manifest['rows'] for p in d['pages']),
           'newScopedRegistrationWindows': 2, 'publicationChanged': 0,
           'failedChecks': [c for c in checks if not c['passed']], 'backup': before['backup']}
(OUT / 'api-readback.json').write_text(json.dumps(details, ensure_ascii=False, indent=2), encoding='utf-8')
(OUT / 'verification.json').write_text(json.dumps({'summary': summary, 'checks': checks}, ensure_ascii=False, indent=2), encoding='utf-8')
(OUT / 'final-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')

lines = ['# 71项学校竞赛目录后续审核与补录', '', '执行日期：2026年11月17日。目标：已部署线上系统。', '',
         '## 已完成', '',
         f'- 逐项复核71条，{summary["contentUpdated"]}条补录实质字段，原生采集服务保存{summary["serviceFieldWrites"]}个字段；另纠正校园戏剧报名方式及说明。',
         f'- 时间说明空白：25 → {summary["after"]["noSchedule"]}；低可信：8 → {summary["after"]["credibility"].get("low",0)}。',
         f'- 学校目录当前高可信{summary["after"]["credibility"].get("high",0)}条、中可信{summary["after"]["credibility"].get("medium",0)}条。可信度不等同资料完整或当前仍可报名。',
         '- 8条原草稿仍为草稿，63条原发布记录维持发布；未发布新条目，未删除条目。目录外另一条蓝桥杯未改动。',
         '- 新增BIM A—H模块、好创意第21届常规赛的两条有范围说明的报名时段，其余无统一截止的父项不造日期。',
         '- 线上数据库及HTTPS API逐项回读，检查结果：' + ('通过' if summary['passed'] else '存在失败') + f'（{len(checks)}项）。', '',
         '## 跳过原因与处理', '',
         '按原采集任务保存的warnings核对；旧JSONL部分runId与该批任务不重合，未伪造逐任务日志归属。', '',
         '| 原因 | 此批任务警告条数（可重复） |', '|---|---:|']
for reason, count in sorted(manifest['logReasons'].items(), key=lambda x: -x[1]):
    lines.append(f'| {reason.replace(chr(124), "/")} | {count} |')
lines += ['', '主要补救：用浏览器渲染BIM、好创意动态页；下载并逐页核读智能机器人、未来设计师扫描通知；官网证书失败改用主办/承办方原始通知或高校保存的签发原件；跨年赛事按2027届检索；全国、校内、赛区和子赛项分别标注。', '',
          '## 尚未确认的范围', '',
          '- 物流设计目前只有核实过的2025第九届历史通知，新一届尚未核实；挑战杯2027全国日期未核实。',
          '- BIM第十三届I—J截止在官网同页出现2027年1月29日16:00与1月30日两种表述，保留冲突并维持中可信。A—H截止2026年11月30日16:00有明确依据。',
          '- 睿抗、工创、智能汽车室外赛、中美创客等部分赛程仅明确到月份或为预通知；校园戏剧尚未核得实际展演日。',
          '- RoboCon、商业精英其余四类子竞赛，以及部分全国后续阶段仍需各自通知；父项日期说明不表示所有子项均已补全。',
          '- 没有精确报名截止不等于没有比赛时间：聚合赛事、校级选拔和省级报送不得强行填为全国学生截止。', '',
          '## 逐项结果', '', '| 目录序号 | 比赛 | 结果/可信度 | 时间与未完成说明 |', '|---:|---|---|---|']
for d in manifest['rows']:
    row = current[d['id']]
    content = row['scheduleNote'] or '未核实'
    notes = '；'.join(d['notes'])
    result = ('补录并复核' if d['pages'] else '复核已有证据') + f'；{row["credibility"]}/{row["credibilityScore"]}'
    lines.append(f'| {d["index"] - 1} | {d["name"]} | {result} | {(content + ("；" + notes if notes else "")).replace(chr(124), "/").replace(chr(10), " ")} |')
lines += ['', '## 本次新增来源', '']
for d in manifest['rows']:
    if d['pages']:
        lines += [f'### {d["index"]-1}. {d["name"]}', '']
        for p in d['pages']:
            lines.append(f'- {p["title"]}：{p["url"]}；类型 `{p["sourceType"]}`；缓存 `{p["cacheFile"]}`。')
        lines.append('')
lines += ['## 备份与执行证据', '', f'- 修改前数据库备份：`{before["backup"]}`。',
          '- `before.json` 修改前全量快照；`current.json` 修改后快照。',
          '- `review-manifest.json` 字段、原文摘录、来源哈希、版本和原任务警告。',
          '- `execution.json` 每项执行步骤和前后值；`verification.json` 验证详情；`api-readback.json` 线上逐项回读。',
          '- 没有修改解析器、搜索器或采集规则代码；本轮为有证据的资料补录和审核，不能宣称根治未来自动采集失败。']
(OUT / '审核补录报告.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False, indent=2))
if not summary['passed']:
    raise SystemExit(1)
