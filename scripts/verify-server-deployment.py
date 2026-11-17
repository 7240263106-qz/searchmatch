import base64
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    access = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    root = Path(__file__).resolve().parent.parent
    release_id = sys.argv[2]
    output = root / 'artifacts' / 'deployments' / release_id / 'public-verification.json'
    base = access['url'].rstrip('/')
    token = base64.b64encode((access['username'] + ':' + access['password']).encode()).decode()
    opener = urllib.request.build_opener(NoRedirect)
    checks = []

    def request(url, *, authorized=True, body=None, extra_headers=None):
        headers = {'Accept': 'application/json'}
        if authorized:
            headers['Authorization'] = 'Basic ' + token
        if body is not None:
            headers['Content-Type'] = 'application/json'
        headers.update(extra_headers or {})
        message = urllib.request.Request(url, headers=headers,
                                         data=None if body is None else json.dumps(body).encode())
        try:
            response = opener.open(message, timeout=45)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def check(label, passed, **details):
        checks.append({'check': label, 'passed': bool(passed), **details})
        print(json.dumps(checks[-1], ensure_ascii=False), flush=True)

    def api(path, **options):
        status, headers, data = request(base + '/api/v1' + path, **options)
        if status not in (200, 201):
            raise RuntimeError(f'API {path.split("?")[0]} returned {status}')
        return json.loads(data)['data']

    for path in ['/', '/api/v1/system/client-bootstrap', '/assets/missing.js', '/library']:
        status, headers, data = request(base + path, authorized=False)
        check('unauthenticated ' + path, status == 401, status=status)

    status, headers, data = request(base.replace('https:', 'http:') + '/', authorized=False)
    check('HTTP redirects to HTTPS', status == 301 and headers.get('Location', '').startswith('https:'), status=status)
    status, headers, html = request(base + '/')
    check('authenticated SPA', status == 200 and b'<div id="root">' in html, status=status)
    assets = re.findall(rb'(?:src|href)="([^\"]+\.(?:js|css|ico))"', html)
    check('subpath assets declared', len(assets) >= 3 and all(asset.startswith(b'/competition/') for asset in assets), count=len(assets))
    for asset in assets:
        path = asset.decode()
        status, headers, data = request('https://wonderofyou.xyz' + path)
        check('asset ' + path.rsplit('/', 1)[-1], status == 200 and len(data) > 100 and not data.startswith(b'<!doctype html'), status=status, bytes=len(data))
    for path in ['/library', '/collection', '/settings']:
        status, headers, data = request(base + path)
        check('deep link ' + path, status == 200 and data == html, status=status)

    bootstrap = api('/system/client-bootstrap')
    check('production bootstrap', bootstrap['profile'] == 'prod' and bootstrap['devIdentityAllowed'] is False
          and bootstrap['apiBaseUrl'] == base + '/api/v1', bootstrap=bootstrap)
    readiness = api('/readyz')
    check('API database and parser ready', readiness['status'] == 'ok' and
          all(readiness['dependencies'].get(key) == 'ready' for key in ['database', 'parser']), readiness=readiness)
    queries = [
        ('workspace all records', {'scope': 'workspace', 'includeExpired': True, 'includeLowCredibility': True, 'limit': 100}, 72),
        ('published all records', {'scope': 'published', 'includeExpired': True, 'includeLowCredibility': True, 'limit': 100}, 64),
        ('published default filter', {'scope': 'published', 'limit': 100}, 57),
        ('energy competition', {'scope': 'workspace', 'includeExpired': True, 'keyword': '能源经济', 'limit': 100}, None),
        ('agriculture competition', {'scope': 'workspace', 'includeExpired': True, 'keyword': '智能农业', 'limit': 100}, None),
    ]
    for label, query, expected in queries:
        result = api('/search/competitions', body=query)
        total = result['page']['total']
        check(label, total == expected if expected is not None else total > 0, total=total,
              names=[item['name'] for item in result['items']] if expected is None else None)

    documents = api('/documents')
    check('original document inventory', len(documents) == 2, count=len(documents))
    snapshot = root / 'artifacts' / 'deployments' / release_id / 'competition-sj' / 'deployment-data'
    with sqlite3.connect(f'file:{(snapshot / "competition.db").as_posix()}?mode=ro', uri=True) as database:
        expected_files = dict(database.execute('SELECT id, storageKey FROM CompetitionDocument'))
    for document in documents:
        download = document['fileUrl']
        if not download.startswith('/api/v1/documents/'):
            raise RuntimeError('Unexpected document download path')
        status, headers, data = request(base + download)
        expected = (snapshot / 'uploads' / expected_files[document['id']]).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        check('original document download', status == 200 and digest == hashlib.sha256(expected).hexdigest(),
              documentId=document['id'], bytes=len(data), sha256=digest)

    spoofed = api('/search/competitions', body={'scope': 'workspace', 'includeExpired': True, 'includeLowCredibility': True, 'limit': 100},
                  extra_headers={'X-Actor-Id': 'attacker', 'X-Actor-Roles': 'viewer', 'X-Team-Id': 'attacker'})
    check('gateway removes client identity headers', spoofed['page']['total'] == 72, total=spoofed['page']['total'])
    for path, expected_bytes in [('/', 5423), ('/memories/', 39813), ('/prod-api/', 105)]:
        status, headers, data = request('https://wonderofyou.xyz' + path, authorized=False)
        check('existing route ' + path, status == 200 and len(data) == expected_bytes, status=status, bytes=len(data))

    report = {'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'url': base + '/',
              'releaseId': release_id, 'passed': all(item['passed'] for item in checks), 'checks': checks}
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'report': str(output), 'passed': report['passed'], 'checks': len(checks)}, ensure_ascii=False))
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
