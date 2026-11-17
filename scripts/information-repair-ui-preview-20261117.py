"""Loopback-only, read-only acceptance proxy. Credentials are loaded, never returned."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import requests

ACCESS=json.loads((Path.home()/'.ssh/competition-sj-access.json').read_text(encoding='utf-8-sig'))
ORIGIN=ACCESS['url'].rstrip('/')
PORT=8769


class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass

    def serve(self):
        if not self.path.startswith('/competition/') or self.command=='POST':
            self.send_error(405);return
        if self.command not in ('GET','HEAD'):
            self.send_error(405);return
        response=requests.request(self.command,ORIGIN+self.path[len('/competition'):],data=body,
            headers={'Content-Type':self.headers.get('Content-Type','application/json')},
            auth=(ACCESS['username'],ACCESS['password']),timeout=40)
        content=response.content
        if self.path.split('?')[0]=='/competition/api/v1/system/client-bootstrap' and response.status_code==200:
            payload=response.json();payload['data']['apiBaseUrl']=f'http://127.0.0.1:{PORT}/competition/api/v1';content=json.dumps(payload).encode()
        self.send_response(response.status_code)
        self.send_header('Content-Type',response.headers.get('Content-Type','application/octet-stream'))
        self.send_header('Content-Length',str(len(content)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(content)

    do_GET=serve
    do_POST=serve


if __name__=='__main__':
    print(f'Read-only production UI acceptance proxy listening on loopback:{PORT}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',PORT),Handler).serve_forever()
