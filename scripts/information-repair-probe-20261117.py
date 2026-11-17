"""Read-only URL reachability check; never logs in, registers or submits a form."""
import concurrent.futures
import datetime
import hashlib
import json
from pathlib import Path
from urllib.parse import urlparse

import bs4
import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts/competition-information-repair-20261117'
TZ = datetime.timezone(datetime.timedelta(hours=8))


def probe(url):
    item = dict(url=url, checkedAt=datetime.datetime.now(TZ).isoformat(), status='unverified',
                submissionTested=False, registrationOpenVerified=False)
    try:
        p = urlparse(url)
        if p.scheme not in ('http', 'https') or not p.hostname:
            raise ValueError('Not a public HTTP(S) URL')
        r = requests.get(url, timeout=(10, 22), allow_redirects=True, headers={'User-Agent': 'Mozilla/5.0'})
        item.update(httpStatus=r.status_code, finalUrl=r.url, bytes=len(r.content))
        if not r.encoding or r.encoding.lower() in ('iso-8859-1', 'ascii'):
            r.encoding = r.apparent_encoding or 'utf-8'
        soup = bs4.BeautifulSoup(r.text[:2_000_000], 'html.parser')
        item['title'] = soup.title.get_text(' ', strip=True) if soup.title else None
        for tag in soup(['script', 'style', 'noscript']): tag.decompose()
        text = soup.get_text(' ', strip=True)
        item['textLength'] = len(text)
        item['bodySha256'] = hashlib.sha256(r.content).hexdigest()
        if r.status_code in (401, 403):
            item['status'], reason = 'temporarily_unavailable', 'HTTP访问限制，未绕过认证/访问控制'
        elif r.status_code >= 400:
            item['status'], reason = 'temporarily_unavailable', 'HTTP错误，未据一次失败判定域名永久无效'
        elif len(text) < 150 or any(s in r.text.lower() for s in ('enable javascript', "doesn't work properly without javascript")):
            item['status'], reason = 'unverified', 'HTTP成功但为短页面/JavaScript外壳，未完成浏览器表单验证'
        elif soup.select('input[type="password"]') or any(s in (item['title'] or '') for s in ('登录', 'Login', 'Sign in')):
            item['status'], reason = 'login_required', '公开页可达，报名/账户操作需要登录'
        else:
            item['status'], reason = 'accessible', '公开页面可达；仅验证入口可达，不代表报名仍开放或表单可成功提交'
        item['reason'] = reason
    except Exception as exc:
        item.update(status='temporarily_unavailable', reason=type(exc).__name__ + ': ' + str(exc)[:220])
    return item


def main():
    before = json.loads((OUT/'before/database-snapshot.json').read_text(encoding='utf-8'))['rows']
    manifest = json.loads((OUT/'repair-manifest.json').read_text(encoding='utf-8'))
    urls = {r['signupUrl'] for r in before if r.get('signupUrl')}
    urls |= {e['url'] for r in before for e in r['entries'] if e.get('url')}
    urls |= {e['url'] for r in manifest['rows'] for e in r['entries'] if e.get('url')}
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(probe, sorted(urls)))
    (OUT/'entry-probes.json').write_text(json.dumps(dict(checkedAt=datetime.datetime.now(TZ).isoformat(),
        rows=results), ensure_ascii=False, indent=2), encoding='utf-8')
    from collections import Counter
    print(json.dumps(dict(urls=len(results), statuses=dict(Counter(r['status'] for r in results))), ensure_ascii=False))


if __name__ == '__main__': main()
