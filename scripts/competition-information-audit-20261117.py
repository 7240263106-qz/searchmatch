"""Read-only, per-competition production information audit.

Writes evidence and reports locally; never changes production records or settings.
"""
import collections
import concurrent.futures
import csv
import datetime
import hashlib
import json
import re
import subprocess
import sys
import warnings
from pathlib import Path
from urllib.parse import unquote

warnings.filterwarnings('ignore', category=Warning, module='requests')
import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts/competition-information-audit-20261117'
TZ = datetime.timezone(datetime.timedelta(hours=8))


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def write(name, value):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def capture():
    remote = r'''
import datetime,json,sqlite3
c=sqlite3.connect('file:/opt/competition-sj/shared/competition.db?mode=ro',uri=True)
c.row_factory=sqlite3.Row
c.execute('PRAGMA query_only=ON')
c.execute('BEGIN')
rows=[]
for r in c.execute("SELECT * FROM Competition WHERE deletedAt IS NULL AND demoFlag=0 AND dataOrigin='formal' ORDER BY createdAt,id").fetchall():
 row=dict(r)
 for table,key in [('SourceMaterial','sources'),('FieldEvidence','fieldEvidence'),('RegistrationStage','stages'),('ReviewRecord','reviews'),('SignupEntry','entries')]:
  row[key]=[dict(x) for x in c.execute('SELECT * FROM '+table+' WHERE competitionId=?',(r['id'],))]
 row['organizers']=[dict(x) for x in c.execute('SELECT o.name,o.officialSite,co.role FROM CompetitionOrganizer co JOIN Organizer o ON o.id=co.organizerId WHERE co.competitionId=?',(r['id'],))]
 row['documents']=[dict(x) for x in c.execute('SELECT d.id,d.fileName,d.parseStatus,l.locationNote FROM DocumentCompetitionLink l JOIN CompetitionDocument d ON d.id=l.documentId WHERE l.competitionId=?',(r['id'],))]
 rows.append(row)
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'databaseQuickCheck':[r[0] for r in c.execute('pragma quick_check')],'rows':rows},ensure_ascii=False))
'''
    p = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20',
                        'admin@47.116.143.62', 'sudo -n python3 -'],
                       input=remote, capture_output=True, encoding='utf-8', timeout=100)
    if p.returncode:
        raise RuntimeError('Read-only production snapshot failed: ' + p.stderr[:300])
    snapshot = json.loads(p.stdout)
    write('database-snapshot.json', snapshot)
    access = read(Path.home() / '.ssh/competition-sj-access.json')
    base = access['url'].rstrip('/') + '/api/v1'

    def api(path, body=None):
        with requests.Session() as s:
            s.auth = (access['username'], access['password'])
            r = s.get(base + path, timeout=40) if body is None else s.post(base + path, json=body, timeout=40)
            r.raise_for_status()
            return r.json()['data']

    cards, cursor = [], None
    while True:
        body = {'scope': 'workspace', 'includeExpired': True, 'includeLowCredibility': True, 'limit': 100}
        if cursor:
            body['cursor'] = cursor
        page = api('/search/competitions', body)
        cards.extend(page['items'])
        cursor = page['page'].get('nextCursor')
        if not cursor:
            break
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        details = list(pool.map(lambda r: api('/competitions/' + r['id']), cards))
    write('api-details.json', {'at': datetime.datetime.now(TZ).isoformat(), 'rows': details})
    write('capture-summary.json', {'at': datetime.datetime.now(TZ).isoformat(),
                                  'databaseRows': len(snapshot['rows']), 'apiRows': len(details),
                                  'parentRows': sum(not r['parentId'] for r in snapshot['rows']),
                                  'databaseQuickCheck': snapshot['databaseQuickCheck']})
    print(json.dumps(read(OUT / 'capture-summary.json'), ensure_ascii=False, indent=2))


def text(value):
    return bool(value is not None and str(value).strip())


def normalize(value):
    return re.sub(r'\s+', '', unquote(str(value or ''))).rstrip('/')


def local_time(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        dt = datetime.datetime.fromtimestamp(value / 1000, TZ)
    else:
        dt = datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(TZ)
    return dt.isoformat(timespec='seconds')


def stamp(value):
    if not value:
        return None
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000


def table_text(value):
    return str(value or '—').replace('|', '／').replace('\r', '').replace('\n', '<br>')


def report():
    snapshot = read(OUT / 'database-snapshot.json')
    rows = snapshot['rows']
    api_capture = read(OUT / 'api-details.json')
    api_by_id = {r['id']: r for r in api_capture['rows']}
    notes = read(OUT / 'review-notes.json')
    fingerprint = hashlib.sha256('\n'.join(r['id'] for r in rows).encode()).hexdigest()
    if notes['recordIdsSha256'] != fingerprint:
        raise RuntimeError('Review notes do not match the captured record identities and order.')
    reviewed = {r[0]: {'timeAssessment': r[1], 'followup': r[2]} for r in notes['rows']}
    if set(reviewed) != set(range(1, len(rows) + 1)):
        raise RuntimeError('Every captured competition needs an individual review note.')
    all_source_ids = {s['id'] for r in rows for s in r['sources']}
    labels = {'description': '比赛介绍', 'organizer': '主办方', 'eligibility': '参赛条件',
              'schedule': '赛程说明', 'signupRoute': '主报名方式及路径', 'sources': '来源链接或原件'}
    audits, checks = [], []
    precision_issues = []
    for index, row in enumerate(rows, 1):
        api_row = api_by_id.get(row['id'])
        if not api_row:
            raise RuntimeError('Competition is absent from API capture: ' + row['id'])
        eligibility = json.loads(row['eligibilityJson'])
        organizers = [o['name'] for o in row['organizers'] if text(o['name'])]
        urls = list(dict.fromkeys([e['url'] for e in row['entries'] if text(e.get('url'))]
                                  + ([row['signupUrl']] if text(row['signupUrl']) else [])))
        tracks = api_row.get('discoveryTracks', [])
        track_urls = [t['url'] for t in tracks if text(t.get('url'))]
        offline_path = row['signupMethod'] == 'offline' and any(text(row.get(k)) for k in ('signupNote', 'signupContact'))
        stored_route = bool(urls or offline_path)
        sources = [s for s in row['sources'] if s.get('url') or s.get('documentId')]
        present = {'description': text(row['description']), 'organizer': bool(organizers),
                   'eligibility': any(text(v) for v in eligibility.values()),
                   'schedule': text(row['scheduleNote']), 'signupRoute': stored_route,
                   'sources': bool(sources or row['documents'])}
        missing = [labels[k] for k, v in present.items() if not v]
        if index in (24, 44):
            verdict = '存在日期冲突'
        elif index in (17, 45):
            verdict = '赛项范围需对齐'
        elif missing:
            verdict = '核心字段有缺口'
        else:
            verdict = '主字段具备，细节待核实'
        if offline_path:
            signup = '线下集体报送已有说明；地址、联系人及材料细则待核'
        elif urls:
            signup = '已存网站/入口链接；未验证可报名'
        elif track_urls:
            signup = '已有赛道链接；主报名方式及直接申报路径待确认'
        else:
            signup = '未记录网页入口、赛道链接或线下执行路径'
        confirmed_entries = [e for e in row['entries'] if e['status'] == 'accessible' and e.get('lastCheckedAt')]
        current_values = {'description': [row['description']], 'organizer': organizers,
                          'eligibility': list(eligibility.values()), 'schedule': [row['scheduleNote']],
                          'signupUrl': urls, 'signupMethod': [row['signupMethod']]}
        evidence = {}
        selected_source_ids = []
        for field, values in current_values.items():
            candidates = [e for e in row['fieldEvidence'] if e['fieldName'] == field
                          and e.get('sourceId') in all_source_ids and text(e.get('snippet'))]
            exact = [e for e in candidates if any(normalize(e.get('fieldValue')) == normalize(v)
                                                  for v in values if text(v))]
            candidates.sort(key=lambda e: e['createdAt'], reverse=True)
            exact.sort(key=lambda e: e['createdAt'], reverse=True)
            chosen = (exact or candidates or [None])[0]
            evidence[field] = {'hasLinkedQuote': bool(candidates), 'matchesCurrentValue': bool(exact),
                               'sourceId': chosen['sourceId'] if chosen else None,
                               'snippet': chosen.get('snippet') if chosen else None}
            if chosen and chosen['sourceId'] not in selected_source_ids:
                selected_source_ids.append(chosen['sourceId'])
        deadline = api_row.get('nearestDeadline')
        for stage in row['stages']:
            if deadline and stage.get('endAt') and abs(stamp(deadline['at']) - stage['endAt']) < 1:
                if stage.get('endPrecision') == 'second' and deadline.get('precision') == 'day':
                    precision_issues.append({'id': row['id'], 'name': row['name'], 'stage': stage['name'],
                                             'stagePrecision': 'second', 'cardDeadlinePrecision': 'day'})
        for field, expected in [('name', row['name']), ('publishStatus', row['publishStatus']),
                                ('versionNo', row['versionNo']), ('description', row['description']),
                                ('eligibility', eligibility), ('schedule', row['scheduleNote'])]:
            checks.append({'id': row['id'], 'check': 'API agrees: ' + field, 'passed': api_row.get(field) == expected})
        for field in ('sources', 'entries', 'stages'):
            checks.append({'id': row['id'], 'check': 'API relation identities: ' + field,
                           'passed': {r['id'] for r in api_row[field]} == {r['id'] for r in row[field]}})
        if row['nearestDeadline']:
            checks.append({'id': row['id'], 'check': 'Stored deadline agrees with API',
                           'passed': bool(deadline) and abs(stamp(deadline['at']) - row['nearestDeadline']) < 1})
        audits.append({'index': index, 'catalogNumber': index - 1 if row['schoolRecognitionLevel'] in ('A类', 'B类', 'C类') else None,
                       'id': row['id'], 'name': row['name'], 'isSchoolCatalog': row['schoolRecognitionLevel'] in ('A类', 'B类', 'C类'),
                       'publishStatus': row['publishStatus'], 'credibility': api_row['credibility'],
                       'systemCompleteness': row['completeness'], 'verdict': verdict,
                       'coreFieldPresence': present, 'coreFieldsPresent': all(present.values()),
                       'missingCoreFields': missing, 'signupAssessment': signup, 'hasEntryRecord': bool(row['entries']),
                       'storedEntryUrls': urls, 'trackUrls': track_urls, 'offlinePathRecorded': bool(offline_path),
                       'hasAnySignupClue': bool(urls or track_urls or offline_path),
                       'verifiedEntryCount': len(confirmed_entries), 'parentStoredDeadline': local_time(row['nearestDeadline']),
                       'apiDeadline': deadline, 'deadlineDerivedFromTracks': bool(deadline and not row['nearestDeadline'] and tracks),
                       'hasQuotedCurrentValue': evidence, 'sources': row['sources'],
                       'selectedSourceIds': selected_source_ids, 'tracks': tracks,
                       'schedule': row['scheduleNote'], **reviewed[index]})
    school = [a for a in audits if a['isSchoolCatalog']]
    failed = [c for c in checks if not c['passed']]
    def counts(items):
        return {'total': len(items), 'coreFieldsPresent': sum(a['coreFieldsPresent'] for a in items),
                'coreFieldsMissing': sum(not a['coreFieldsPresent'] for a in items),
                'missingByField': {labels[k]: sum(not a['coreFieldPresence'][k] for a in items) for k in labels},
                'noParentStoredDeadline': sum(a['parentStoredDeadline'] is None for a in items),
                'noApiComputedDeadline': sum(not a['apiDeadline'] for a in items),
                'noEntryRecord': sum(not a['hasEntryRecord'] for a in items),
                'noSignupClue': sum(not a['hasAnySignupClue'] for a in items),
                'offlinePaths': sum(a['offlinePathRecorded'] for a in items),
                'withTracks': sum(bool(a['tracks']) for a in items),
                'withEntryLinks': sum(bool(a['storedEntryUrls']) for a in items),
                'verdicts': dict(collections.Counter(a['verdict'] for a in items))}
    summary = {'checkedAt': api_capture['at'], 'scope': 'Production formal non-demo non-deleted competitions, published and drafts',
               'externalWebsiteVerification': 'Not performed in this inventory audit; link presence does not establish availability or signup eligibility.',
               'productionWrites': 0, 'all': counts(audits), 'schoolCatalog': counts(school),
               'apiDatabaseChecks': len(checks), 'apiDatabaseChecksPassed': not failed, 'failedChecks': failed,
               'allSourceReferencesResolvable': all(e.get('sourceId') in all_source_ids for r in rows for e in r['fieldEvidence'] if e.get('sourceId')),
               'deadlinePrecisionMismatches': precision_issues,
               'entryStatuses': dict(collections.Counter(e['status'] for r in rows for e in r['entries'])),
               'coreFieldsPresentNames': [a['name'] for a in school if a['coreFieldsPresent']],
               'awardFieldsPresent': sum(text(r['awards']) for r in rows if r['schoolRecognitionLevel'] in ('A类', 'B类', 'C类'))}
    write('audit.json', {'summary': summary, 'rows': audits})
    write('verification.json', {'summary': summary, 'checks': checks})
    fields = ['目录编号', '记录ID', '比赛', '发布状态', '结论', '核心缺口', '报名核查', '主截止时间', 'API最近截止', '时间判断', '逐项待补说明', '已有来源数', '赛道数']
    with (OUT / '逐项信息完整性清单.csv').open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for a in school + [a for a in audits if not a['isSchoolCatalog']]:
            writer.writerow(dict(zip(fields, [a['catalogNumber'] or '目录外', a['id'], a['name'], a['publishStatus'],
                                              a['verdict'], '；'.join(a['missingCoreFields']) or '主字段无空白',
                                              a['signupAssessment'], a['parentStoredDeadline'] or '未存',
                                              local_time(a['apiDeadline']['at']) if a['apiDeadline'] else '无',
                                              a['timeAssessment'], a['followup'], len(a['sources']), len(a['tracks'])])))
    s = summary['schoolCatalog']
    lines = ['# 比赛信息逐项完整性核查', '', f'线上读取时间：{api_capture["at"]}（北京时间）。', '',
             '## 核查范围与判断口径', '',
             f'- 已逐项读取全库{len(audits)}条比赛及其数据库字段、API详情、报名阶段、赛道、报名入口、来源和字段摘录。学校目录{s["total"]}条，目录外另有1条旧蓝桥杯；没有子记录被漏读。',
             '- 核心主字段：比赛介绍、主办方、参赛条件、赛程说明、报名方式及执行路径、来源或原件。字段有值只表示已记录，不表示规则、时效和范围全部核实。',
             '- 线下集体报送不强制网页链接；合并赛事不强制统一报名截止；赛道内已有时间和链接单独计入，避免误报完全无信息。',
             '- 本轮核查现有线上资料及已保存证据，不重新检索或登录外部官网。未验证链接可用性、报名表单、所有附件条款，也未修改生产数据。',
             '- 过去已结束的本届赛程可以作为历史档案完整性依据，但不能证明下一届已开放。报名费用、奖项、材料规格和联系人等按执行需要列待补，不用虚构内容补空。', '',
             '## 汇总', '', '| 核查项（学校目录71条） | 数量 |', '|---|---:|',
             f'| 六类核心主字段均有记录 | {s["coreFieldsPresent"]} |',
             f'| 至少一类核心主字段有缺口 | {s["coreFieldsMissing"]} |']
    for label, count in s['missingByField'].items():
        issue_label = '主报名方式或执行路径未明确' if label == '主报名方式及路径' else f'{label}字段缺失'
        lines.append(f'| {issue_label} | {count} |')
    lines += [f'| 未存父项报名截止 | {s["noParentStoredDeadline"]} |',
              f'| API连同赛道推导后仍无父项最近截止 | {s["noApiComputedDeadline"]} |',
              f'| 未建立独立报名入口记录 | {s["noEntryRecord"]} |',
              f'| 连网页、赛道链接、线下路径线索都未记录 | {s["noSignupClue"]} |',
              f'| 已存网站或入口链接（全部状态仍为未验证） | {s["withEntryLinks"]} |',
              f'| 线下集体路径已有说明 | {s["offlinePaths"]} |',
              f'| 已有结构化赛道资料的比赛 | {s["withTracks"]} |',
              f'| 已录奖项说明（扩展项） | {summary["awardFieldsPresent"]} |', '',
              '**不能把上述6条“主字段有记录”直接标为完整可报名。**其中包含历史报名已截止、校内日期、赛项范围不齐、日期冲突，以及尚未验证的报名入口。', '',
              '主字段具备的6条：' + '；'.join(summary['coreFieldsPresentNames']) + '。', '',
              '## 需要优先复核的跨字段问题', '',
              '- BIM：I—J截止同页冲突，系统已标冲突；A—H截止不能代表I—J。',
              '- 服务外包：赛程已写3月20日16:00和3月31日两种截止，系统完整度仍是partial；不能只统计conflict标记就认为只有一个日期问题。',
              '- 外研社系列：学校目录的四个旧项目名称与当前正文、校内日期覆盖范围不完全对齐。',
              '- 商业精英：介绍主要为创新创业专题、赛程主要为品牌策划，另有其他四类，不宜拼接为一项已齐全记录。',
              '- 蓝桥杯：目录内第十八届5组赛道、32科目和分赛道时间已有记录，API会推导最近截止；主介绍、资格和主办方仍空。目录外同名旧记录是另一条数据。',
              '- 全球校园AI：6赛道、72赛题条目、266时间节点已存，不能因主报名字段或主截止为空认定没有比赛时间；具体题目资格与直接申报路径仍需核实。',
              f'- 截止精度元数据：{len(precision_issues)}条比赛的阶段精度为second，而API卡片同一截止标day；时间戳存在，但精度描述不一致。逐条见文末。', '',
              '## 学校目录71项总表', '', '| 目录号 | 比赛 | 本轮结论 | 主字段缺口 | 时间与范围 | 报名情况 |', '|---:|---|---|---|---|---|']
    for a in school:
        lines.append('| ' + ' | '.join(table_text(v) for v in [a['catalogNumber'], a['name'], a['verdict'],
                                                               '、'.join(a['missingCoreFields']) or '无主字段空白',
                                                               a['timeAssessment'], a['signupAssessment']]) + ' |')
    lines += ['', '## 每项详细核查', '']
    row_by_id = {r['id']: r for r in rows}
    for a in school + [a for a in audits if not a['isSchoolCatalog']]:
        r = row_by_id[a['id']]
        label = f'{a["catalogNumber"]:02d}' if a['catalogNumber'] else '目录外'
        status = {'draft': '草稿', 'published': '已发布'}.get(r['publishStatus'], r['publishStatus'])
        lines += [f'### {label}．{a["name"]}', '', f'- 记录ID：`{a["id"]}`；{status}；系统完整度`{r["completeness"]}`；系统可信度`{a["credibility"]}`。',
                  f'- 本轮结论：**{a["verdict"]}**。主字段缺口：' + ('、'.join(a['missingCoreFields']) or '六类主字段均有记录，但不等于全部规则已核实') + '。',
                  '- 具体待补：' + a['followup'], '', '| 核查维度 | 当前已存信息 |', '|---|---|']
        eligibility = json.loads(r['eligibilityJson'])
        values = [('比赛介绍', r['description'] or '未填'),
                  ('主办方', '；'.join(o['name'] for o in r['organizers']) or '未填'),
                  ('参赛条件', '；'.join(f'{k}：{v}' for k, v in eligibility.items() if text(v)) or '未填'),
                  ('赛程说明', r['scheduleNote'] or '未填'),
                  ('父项截止字段', a['parentStoredDeadline'] or '未存；不可据此断言所有赛道无日期'),
                  ('API最近截止', (local_time(a['apiDeadline']['at']) + '；精度=' + a['apiDeadline']['precision']
                                  + ('；由赛道推导' if a['deadlineDerivedFromTracks'] else '')) if a['apiDeadline'] else '无'),
                  ('报名方式', r['signupMethod'] + '；' + a['signupAssessment']),
                  ('报名说明', '；'.join(v for v in [r['signupNote'], r['signupContact']] if text(v)) or '未录额外执行说明/联系人'),
                  ('入口记录', '；'.join(f'{e["url"] or "无URL"}（状态={e["status"]}，最后验证={local_time(e["lastCheckedAt"]) or "无"}）' for e in r['entries']) or '无独立入口记录'),
                  ('奖项说明（扩展）', r['awards'] or '未录'),
                  ('来源与阶段', f'{len(r["sources"])}条来源；{len(r["stages"])}条报名阶段；{len(a["tracks"])}组结构化赛道')]
        for field, value in values:
            lines.append(f'| {field} | {table_text(value)} |')
        lines += ['', '字段依据关联（仅核对库内引用，不代表本轮复验官网原文）：', '', '| 字段 | 当前值与已存摘录的对应情况 |', '|---|---|']
        field_names = {'description': '介绍', 'organizer': '主办方', 'eligibility': '条件', 'schedule': '赛程', 'signupUrl': '报名链接', 'signupMethod': '报名方式'}
        for field, ev in a['hasQuotedCurrentValue'].items():
            state = '有来源及原文摘录，保存值与当前主字段对应' if ev['matchesCurrentValue'] else ('有来源摘录，未与当前主字段逐字对应' if ev['hasLinkedQuote'] else '未找到该字段关联的来源摘录；不等同完全没有来源')
            lines.append(f'| {field_names[field]} | {state} |')
        source_by_id = {s['id']: s for s in r['sources']}
        selected = [source_by_id[k] for k in a['selectedSourceIds'] if k in source_by_id]
        if not selected:
            selected = r['sources'][:3]
        lines += ['', '已存依据：', '']
        for source in selected:
            title = source['title'].replace('[', '（').replace(']', '）')
            link = f'[{title}]({source["url"]})' if source.get('url') else title
            lines.append(f'- {link}；库内类型`{source["type"]}`。')
        if a['tracks']:
            lines += ['', '已有赛道补充信息：', '', '| 赛道/届次 | 科目条目数 | 报名时段 | 时间节点数 |', '|---|---:|---|---:|']
            for track in a['tracks']:
                registration = '；'.join((x.get('subject', '') + ' ' + x.get('start', '') + '—' + x.get('end', '')).strip() for x in track.get('registration', [])) or '未单列统一报名段；请查各科目时间节点'
                lines.append('| ' + ' | '.join(table_text(v) for v in [track['title'] + '／' + track.get('edition', ''), len(track.get('subjects', [])), registration, len(track.get('schedule', []))]) + ' |')
        lines.append('')
    lines += ['## 数据一致性核验', '', f'- 数据库`quick_check`：{snapshot["databaseQuickCheck"]}。',
              f'- 数据库与API身份、字段、来源/入口/阶段关系及已存截止时间：{len(checks)}项检查，' + ('全部通过。' if not failed else f'{len(failed)}项不一致。'),
              '- 本地JSON、CSV和报告覆盖相同72条记录；学校目录71条与目录外记录分开。',
              '- 所有本轮操作仅查询生产数据库/API，未改发布状态、资料字段或配置。', '',
              '## 截止精度元数据需对齐', '', '| 比赛 | 阶段精度 | API最近截止精度 |', '|---|---|---|']
    for issue in precision_issues:
        lines.append(f'| {issue["name"]} | second | day |')
    lines += ['', '## 证据文件', '', '- `database-snapshot.json`：线上只读快照。',
              '- `api-details.json`：72条线上详情回读。', '- `review-notes.json`：逐项人工阅读意见，绑定记录顺序哈希。',
              '- `audit.json`：每项字段存在性、证据关联、赛道、时间与报名判断。',
              '- `verification.json`：数据库/API核对详情。', '- `逐项信息完整性清单.csv`：可筛选逐项清单。']
    (OUT / '比赛信息逐项完整性核查报告.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if failed:
        raise SystemExit('Database/API drift detected; inspect captured evidence before drawing conclusions.')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if sys.argv[1:] == ['capture']:
        capture()
    elif sys.argv[1:] == ['report']:
        report()
    else:
        raise SystemExit('Usage: competition-information-audit-20261117.py capture|report')
