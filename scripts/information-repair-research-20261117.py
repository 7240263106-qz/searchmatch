"""Evidence capture only. Fetch explicit notice URLs; never mutate app data."""
import concurrent.futures
import datetime
import hashlib
import json
import re
import sys
import io
import zipfile
from pathlib import Path
from urllib.parse import urljoin

import bs4
import fitz
import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts/competition-information-repair-20261117'
SOURCES = OUT / 'sources'
SOURCES.mkdir(parents=True, exist_ok=True)
TZ = datetime.timezone(datetime.timedelta(hours=8))


def load(p):
    return json.loads(p.read_text(encoding='utf-8-sig'))


def capture(url):
    file = SOURCES / (hashlib.sha256(url.encode()).hexdigest()[:20] + '.json')
    if file.exists():
        return load(file)
    record = {'url': url, 'checkedAt': datetime.datetime.now(TZ).isoformat(), 'text': '', 'links': []}
    try:
        response = requests.get(url, timeout=(10, 25), headers={'User-Agent': 'Mozilla/5.0'}, allow_redirects=True)
        record.update(status=response.status_code, finalUrl=response.url,
                      contentType=response.headers.get('Content-Type', ''), bytes=len(response.content))
        response.raise_for_status()
        if response.content[:4] == b'%PDF':
            doc = fitz.open(stream=response.content, filetype='pdf')
            record['text'] = '\n'.join(p.get_text() for p in doc)
            record['method'] = 'pdf_text'
        elif response.content[:4] == b'PK\x03\x04' and url.lower().endswith('.zip'):
            parts = []
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                for member in archive.infolist():
                    if member.filename.lower().endswith('.pdf') and member.file_size < 30_000_000:
                        with fitz.open(stream=archive.read(member), filetype='pdf') as doc:
                            parts.append(member.filename + '\n' + '\n'.join(p.get_text() for p in doc))
            record['text'] = '\n\n'.join(parts)
            record['method'] = 'zip_pdf_text'
        else:
            if not response.encoding or response.encoding.lower() in ('iso-8859-1', 'ascii'):
                response.encoding = response.apparent_encoding or 'utf-8'
            soup = bs4.BeautifulSoup(response.text, 'html.parser')
            record['title'] = soup.title.get_text(' ', strip=True) if soup.title else None
            record['links'] = [{'text': a.get_text(' ', strip=True), 'url': urljoin(response.url, a['href'])}
                               for a in soup.select('a[href]') if not a['href'].startswith(('javascript:', '#'))]
            for item in soup(['script', 'style', 'nav', 'header', 'footer']):
                item.decompose()
            record['text'] = soup.get_text('\n', strip=True)
            record['method'] = 'html_text'
        record['sha256'] = hashlib.sha256(record['text'].encode()).hexdigest()
        record['observation'] = ('readable_notice' if len(record['text']) > 450 else 'short_or_javascript_shell')
    except Exception as exc:
        record['error'] = type(exc).__name__ + ': ' + str(exc)[:250]
    file.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    return record


def main():
    rows = load(OUT / 'before/database-snapshot.json')['rows']
    urls = list(dict.fromkeys(s['url'] for r in rows for s in r['sources'] if s.get('url')))
    extra = OUT / 'extra-urls.json'
    if extra.exists():
        urls.extend(u for u in load(extra) if u not in urls)
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(capture, urls))
    print(json.dumps({'captured': len(results), 'readable': sum(len(r.get('text','')) > 450 for r in results),
                      'errors': sum('error' in r for r in results)}, ensure_ascii=False))
    old = list((ROOT / 'artifacts/catalog-draft-audit-20261117/sources').glob('*.json'))
    caches = [dict(load(p), cacheFile=str(p.relative_to(ROOT)).replace('\\', '/')) for p in old + list(SOURCES.glob('*.json'))]
    by_url = {}
    for c in caches:
        by_url.setdefault(c['url'].rstrip('/'), []).append(c)
    index = []
    for i, row in enumerate(rows, 1):
        sources = []
        for source in row['sources']:
            for c in by_url.get((source.get('url') or '').rstrip('/'), []):
                text = c.get('text','')
                excerpts = []
                for match in re.finditer(r'主办|参赛对[象像]|参赛资[格质]|报名方式|报名[流办]|注册|报名[网地]|参赛[条要]|联系|邮寄|全日制|在校|报名时间', text):
                    a, b = max(0, match.start()-30), min(len(text), match.start()+420)
                    if excerpts and a <= excerpts[-1][1]:
                        excerpts[-1] = (excerpts[-1][0], max(b, excerpts[-1][1]))
                    else:
                        excerpts.append((a,b))
                sources.append({'url': c['url'], 'cacheFile': c['cacheFile'], 'length': len(text),
                                'excerpts': [text[a:b] for a,b in excerpts]})
        index.append({'index': i, 'id': row['id'], 'name': row['name'], 'sources': sources})
    (OUT / 'research-index.json').write_text(json.dumps(index,ensure_ascii=False,indent=2),encoding='utf-8')
    if len(sys.argv)>1:
        a,b = map(int,sys.argv[1].split(':'))
        for r in index[a-1:b]:
            print(json.dumps(r,ensure_ascii=False,indent=2))


if __name__ == '__main__':
    main()
