"""Final evidence cross-check: three additional explicit facts in already captured notices."""
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('decisions',ROOT/'scripts/information-repair-manifest-20261117.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
snapshot=json.loads((m.OUT/'production-postflight/database-snapshot.json').read_text(encoding='utf-8'))['rows']
items=[]


def decision(index,key,value,cache,anchor,scope):
    r=snapshot[index-1]
    items.append(dict(index=index,id=r['id'],name=r['name'],expectedVersion=r['versionNo'],publishStatus=r['publishStatus'],
        key=key,value=value,scope=scope,evidence=m.evidence(cache,anchor)))


decision(25,'organizers',['中国大学生计算机设计大赛组织委员会'],'dfcbc20c20b8b9648e61','委员会主办','national')
decision(7,'eligibility','2026第51届ICPC南昌站第一轮仅面向依据2026 Asia EC网络预选赛学校排名取得正式/奖励名额的高校；第二轮外卡由高校教练申请，参考网络预选赛或南昌邀请赛排名。此为赛站名额资格，不替代全球个人学籍和年限规则，其他赛站独立适用。','5a003cdb6a26c66ee929','第一轮报名|外卡发放将参考','subevent_Nanchang_2026')
decision(36,'eligibility','河北大学2026校赛参考：具有正式学籍的全日制在校本科生、研究生均可报名，先校赛推荐、再完成各赛项在线技术资格认证。仅本校专项赛选拔口径；RoboCup及其他赛项的全国组别、人数须逐项核对。','6feff5dbf885b66e97f8','参赛对象','school_reference')
if m.INVALID_ANCHORS:raise ValueError(m.INVALID_ANCHORS)
(m.OUT/'supplement-manifest.json').write_text(json.dumps(dict(repairId='FIX-20261117-02.2',rows=items),ensure_ascii=False,indent=2),encoding='utf-8')
print('Source anchors verified; three supplemental field decisions saved.')
