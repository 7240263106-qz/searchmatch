import base64
import json
import os
from pathlib import Path
import secrets
import sys

import paramiko


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    request = json.load(sys.stdin)
    client = paramiko.SSHClient()
    client.load_host_keys(str(Path.home() / '.ssh' / 'known_hosts'))
    client.connect(request.get('host', '47.116.143.62'), username='root',
                   password=request['password'], look_for_keys=False,
                   allow_agent=False, timeout=90, banner_timeout=90, auth_timeout=60)
    try:
        action = request['action']
        if action == 'upload':
            with client.open_sftp() as sftp:
                for item in request['files']:
                    sftp.put(item['local'], item['remote'])
                    print(json.dumps({'uploaded': item['remote'], 'bytes': os.path.getsize(item['local'])}), flush=True)
        elif action == 'download':
            with client.open_sftp() as sftp:
                sftp.get(request['remote'], request['local'])
            print(json.dumps({'downloaded': request['local']}))
        elif action == 'setup_access':
            path = Path(request['accessFile'])
            if path.exists():
                access = json.loads(path.read_text(encoding='utf-8'))
            else:
                url = request.get('url') or os.environ.get('COMPETITION_URL')
                username = request.get('username') or os.environ.get('COMPETITION_USERNAME')
                if not url or not username:
                    raise ValueError('COMPETITION_URL 与 COMPETITION_USERNAME 必须在请求或环境变量中提供')
                access = {'url': url, 'username': username, 'password': secrets.token_urlsafe(24)}
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open('x', encoding='utf-8') as file:
                    json.dump(access, file, indent=2)
            script = "import crypt,json,os,sys; x=json.load(sys.stdin); os.makedirs('/etc/nginx/competition-sj',exist_ok=True); p='/etc/nginx/competition-sj/htpasswd'; open(p,'w').write(x['username']+':'+crypt.crypt(x['password'],crypt.mksalt(crypt.METHOD_SHA512))+'\\n'); os.chown(p,0,__import__('grp').getgrnam('www-data').gr_gid); os.chmod(p,0o640)"
            encoded = base64.b64encode(script.encode()).decode()
            stdin, stdout, stderr = client.exec_command("python3 -c \"import base64;exec(base64.b64decode('" + encoded + "'))\"")
            stdin.write(json.dumps(access))
            stdin.channel.shutdown_write()
            error = stderr.read().decode(errors='replace')
            if stdout.channel.recv_exit_status() != 0:
                raise RuntimeError(error)
            print(json.dumps({'accessFile': str(path), 'username': access['username'], 'passwordPrinted': False}))
        elif action == 'exec':
            _, stdout, _ = client.exec_command(request['command'], timeout=request.get('timeout', 1800))
            stdout.channel.set_combine_stderr(True)
            for line in iter(stdout.readline, ''):
                print(line, end='', flush=True)
            status = stdout.channel.recv_exit_status()
            print('\nREMOTE_EXIT_STATUS=' + str(status), flush=True)
            if status:
                raise SystemExit(status)
        else:
            raise ValueError('Unknown action')
    finally:
        client.close()


if __name__ == '__main__':
    main()
