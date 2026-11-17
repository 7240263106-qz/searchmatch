"""Read-only web research. Cached original text is mandatory for field writes."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import sys
import urllib.parse
import warnings

warnings.filterwarnings('ignore', module='requests')
import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'artifacts' / 'catalog-draft-audit-20261117'
SOURCES = OUTPUT / 'sources'
QUERIES = {
    2: '中国国际大学生创新大赛 2026 教育部 通知 赛程',
    3: '挑战杯 全国大学生课外学术科技作品竞赛 2027 2025 赛程',
    5: '中国青年志愿服务项目大赛 第八届 2026 通知 时间',
    7: 'ICPC 2026 亚洲 区域赛 赛程 北京 官方',
    11: '全国大学生结构设计竞赛 2026 第十九届 通知',
    13: '全国大学生智能汽车竞赛 第二十一届 2026 决赛 通知',
    15: '中国大学生工程实践与创新能力大赛 2027 通知 赛程',
    16: '全国大学生物流设计大赛 第九届 第十届 2026 2027 通知',
    19: 'RoboMaster RoboCon 2026 全国大学生机器人大赛 赛程',
    21: '全国大学生先进成图技术与产品信息建模创新大赛 2026 第十九届 通知',
    30: '全国大学生集成电路创新创业大赛 第十届 2026 赛程 通知',
    33: '未来设计师 全国高校数字艺术设计大赛 2026 第十四届 参赛 通知',
    38: '中美青年创客大赛 2026 通知 比赛时间',
    39: '睿抗机器人开发者大赛 RAICOM 2026 通知 比赛时间',
    44: '全国高校BIM毕业设计创新大赛 2026 第十二届 通知',
    45: '全国高校商业精英挑战赛 2026 品牌策划 会展 国际贸易 赛程',
    46: '学创杯 全国大学生创业综合模拟大赛 2026 第十三届 通知',
    47: '中国高校智能机器人创意大赛 第九届 2026 竞赛通知',
    48: '中国好创意暨全国数字艺术设计大赛 第二十届 2026 通知',
    49: '中国机器人及人工智能大赛 第二十八届 2026 全国决赛 通知',
    50: '全国大学生节能减排社会实践与科技竞赛 第十九届 2026 通知',
    54: '中华经典诵写讲大赛 第八届 2026 教育部 通知',
    56: '百度之星 程序设计大赛 2026 报名 时间',
    66: '全国企业竞争模拟大赛 2026 赛程 通知',
    72: '中国校园戏剧节 第九届 第十届 2026 2027 中国戏剧家协会',
}


def search(item):
    index, query = item
    file = OUTPUT / 'search' / f'{index}.json'
    if file.exists():
        return json.loads(file.read_text(encoding='utf-8'))
    result = {'index': index, 'query': query}
    try:
        response = requests.get('https://www.bing.com/search?q=' + urllib.parse.quote(query), timeout=25)
        response.raise_for_status()
        soup = BeautifulSoup(response.content, 'html.parser')
        result['results'] = []
        for entry in soup.select('li.b_algo')[:10]:
            link = entry.select_one('h2 a')
            if link:
                result['results'].append({'title': link.get_text(' ', strip=True), 'url': link.get('href'),
                                          'text': entry.get_text(' ', strip=True)})
        result['status'] = 'ok' if result['results'] else 'empty_or_challenge'
    except Exception as error:
        result['status'] = 'failed'
        result['error'] = str(error)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return result


def fetch(url):
    file = SOURCES / (hashlib.sha256(url.encode()).hexdigest()[:20] + '.json')
    if file.exists():
        return json.loads(file.read_text(encoding='utf-8'))
    result = {'url': url}
    try:
        response = requests.get(url, timeout=25)
        result['httpStatus'] = response.status_code
        response.raise_for_status()
        result['finalUrl'] = response.url
        if response.content.startswith(b'%PDF-'):
            import fitz
            doc = fitz.open(stream=response.content, filetype='pdf')
            result.update(title=url.rsplit('/', 1)[-1], text='\n'.join(p.get_text() for p in doc), links=[], pages=len(doc))
        else:
            # A number of official Chinese sites use GBK but omit an HTTP charset.
            initial = response.content[:6000].decode('ascii', errors='ignore')
            charset = re.search(r'charset\s*=\s*["\']?([\w-]+)', initial, re.I)
            encoding = charset.group(1) if charset else ('utf-8' if b'\xef\xbb\xbf' == response.content[:3] else response.apparent_encoding)
            html = response.content.decode(encoding or 'utf-8', errors='replace')
            soup = BeautifulSoup(html, 'html.parser')
            result['title'] = soup.title.get_text(' ', strip=True) if soup.title else url
            result['links'] = [{'title':a.get_text(' ', strip=True), 'url':urllib.parse.urljoin(response.url,a['href'])}
                               for a in soup.select('a[href]') if not a['href'].startswith(('javascript:', '#'))]
            for element in soup(['script', 'style', 'noscript']):
                element.decompose()
            result['text'] = soup.get_text('\n', strip=True)
        result['sha256'] = hashlib.sha256(response.content).hexdigest()
        result['status'] = 'ok' if len(result['text']) > 100 else 'empty_body'
    except Exception as error:
        result['status'] = 'failed'
        result['error'] = str(error)
    SOURCES.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return result


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    command = sys.argv[1]
    if command == 'search':
        selected = {int(x) for x in sys.argv[2:]} or set(QUERIES)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(search, [(i,q) for i,q in QUERIES.items() if i in selected]))
        for result in sorted(results,key=lambda x:x['index']):
            print(json.dumps(result, ensure_ascii=False))
    elif command == 'fetch':
        urls = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for result in pool.map(fetch, urls):
                print(json.dumps({k:v for k,v in result.items() if k not in ('text','links')}, ensure_ascii=False)
                      + ' characters=' + str(len(result.get('text',''))))
    else:
        raise SystemExit('Usage: ... search [indexes] | fetch urls.json')


if __name__ == '__main__':
    main()
