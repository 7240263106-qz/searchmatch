#!/usr/bin/env bash
set -euo pipefail
umask 022
release_id=${1:?release id required}
archive_sha=${2:?archive SHA256 required}
resume=${3:-false}
[[ "$release_id" =~ ^(server|lean)-[a-z0-9-]+$ ]] || exit 2
[[ "$archive_sha" =~ ^[a-f0-9]{64}$ ]] || exit 2
base=/opt/competition-sj
mkdir -p "$base"
exec 9>"$base/install.lock"
flock -n 9 || { echo 'Another deployment is running'; exit 2; }
release="$base/releases/$release_id"
archive="/tmp/$release_id.tar.gz"
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum -c -
if [ -e "$release" ]; then
    [ "$resume" = resume ] || { echo 'Release exists; inspect before explicitly resuming'; exit 2; }
fi
test -r /etc/nginx/competition-sj/htpasswd
nginx_user=$(awk '/^[[:space:]]*user[[:space:]]/{print $2; exit}' /etc/nginx/nginx.conf | tr -d ';')
if [ -n "$nginx_user" ]; then
    chown root:"$(id -gn "$nginx_user")" /etc/nginx/competition-sj/htpasswd
    chmod 640 /etc/nginx/competition-sj/htpasswd
fi
id competition-sj >/dev/null 2>&1 || useradd --system --home-dir "$base/shared" --shell /usr/sbin/nologin competition-sj
mkdir -p "$base/releases" "$base/runtime" "$base/shared/uploads" "$base/shared/credentials" "$base/shared/agent-logs" "$base/backups" "$base/public"
chmod 770 "$base/shared"
chmod 750 "$base/backups"
chown root:competition-sj "$base/shared"
chown -R competition-sj:competition-sj "$base/shared/uploads" "$base/shared/credentials" "$base/shared/agent-logs"
if ! swapon --show=NAME --noheadings | grep -q .; then
    if [ ! -e "$base/swapfile" ]; then
        fallocate -l 2G "$base/swapfile"
        chmod 600 "$base/swapfile"
        mkswap "$base/swapfile"
    fi
    swapon "$base/swapfile"
    grep -Fq "$base/swapfile none swap sw 0 0" /etc/fstab || printf '%s\n' "$base/swapfile none swap sw 0 0" >> /etc/fstab
fi
if [ ! -x "$base/runtime/node/bin/node" ]; then
    cd "$base/runtime"
    curl -fL --retry 3 --connect-timeout 20 --max-time 300 -o node.tar.xz https://nodejs.org/dist/v22.23.5/node-v22.23.5-linux-x64.tar.xz
    echo 'cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8  node.tar.xz' | sha256sum -c -
    mkdir node
    tar -xJf node.tar.xz -C node --strip-components=1
fi
export PATH="$base/runtime/node/bin:$PATH"
export NODE_OPTIONS=--max-old-space-size=256
export UV_THREADPOOL_SIZE=2
node --version
if [ ! -e "$release" ]; then
    mkdir "$release"
    tar -xzf "$archive" -C "$release" --strip-components=1
fi
cd "$release"
python3 - <<'PY'
import hashlib,json,os,pathlib
root=pathlib.Path('.')
lean=(root/'LEAN-MANIFEST.json').is_file()
manifest=json.loads((root/('LEAN-MANIFEST.json' if lean else 'RELEASE-MANIFEST.json')).read_text())
if lean:
    assert manifest['releaseType']=='prebuilt-linux-runtime'
    assert manifest['runtimeDependencyInstallRequired'] is False
else:
    assert manifest['built'] is True
for item in manifest['files']:
    file=root/item['path']
    assert file.resolve().is_relative_to(root.resolve()),item['path']
    if item.get('type')=='symlink':
        assert file.is_symlink() and os.readlink(file)==item['target'],item['path']
        assert file.exists(),item['path']
    else:
        assert file.is_file() and hashlib.sha256(file.read_bytes()).hexdigest()==item['sha256'],item['path']
if lean:
    assert (root/'apps/api/node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node').is_file()
print('manifest verified:',len(manifest['files']),'entries; prebuilt:',lean)
PY
export DATABASE_URL="file:$base/shared/competition.db"
if [ -f LEAN-MANIFEST.json ]; then
    node -e "require('./apps/api/node_modules/@prisma/client'); console.log('Prebuilt Linux runtime: skipping package installation and Prisma generation')"
else
    if [ ! -f "$base/runtime/pnpm/node_modules/pnpm/bin/pnpm.cjs" ]; then
        npm install --prefix "$base/runtime/pnpm" --no-audit --no-fund --ignore-scripts pnpm@10.32.1
    fi
    node "$base/runtime/pnpm/node_modules/pnpm/bin/pnpm.cjs" install --filter @competition/api... --frozen-lockfile --ignore-scripts --reporter=append-only --network-concurrency=4 --child-concurrency=1
    node "$base/runtime/pnpm/node_modules/pnpm/bin/pnpm.cjs" --filter @competition/api exec prisma generate --schema prisma/schema.prisma
fi
if [ ! -f "$base/shared/competition.db" ]; then
    install -o competition-sj -g competition-sj -m 640 deployment-data/competition.db "$base/shared/competition.db"
    cp -an deployment-data/uploads/. "$base/shared/uploads/"
    chown -R competition-sj:competition-sj "$base/shared/uploads"
fi
test -s "$base/shared/competition.db"
python3 - "$base" "$release_id" <<'PY'
import pathlib,sqlite3,sys
base=pathlib.Path(sys.argv[1]); name=sys.argv[2]
source=sqlite3.connect(base/'shared/competition.db')
backup=base/'backups'/f'{name}-before-config.db'
exists=backup.exists()
target=sqlite3.connect(backup)
if not exists:
    source.backup(target)
assert target.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
target.close(); source.close()
PY
node deploy/configure-production.cjs
chown competition-sj:competition-sj "$base/shared/competition.db"*
test -L apps/api/uploads || ln -s "$base/shared/uploads" apps/api/uploads
test -L apps/api/.credentials || ln -s "$base/shared/credentials" apps/api/.credentials
mkdir -p artifacts/runtime
test -L artifacts/runtime/agent-logs || ln -s "$base/shared/agent-logs" artifacts/runtime/agent-logs
install -d -o competition-sj -g competition-sj -m 750 "$base/shared/config-gate"
rm -rf artifacts/config-gate
ln -s "$base/shared/config-gate" artifacts/config-gate
if [ ! -x "$base/runtime/uv/uv" ]; then
    python3 - "$base" <<'PY'
import hashlib,io,json,pathlib,sys,urllib.request,zipfile
base=pathlib.Path(sys.argv[1])
with urllib.request.urlopen('https://pypi.org/pypi/uv/json',timeout=45) as response:
    package=json.load(response)
wheel=next(item for item in package['urls'] if item['filename'].endswith('manylinux_2_17_x86_64.manylinux2014_x86_64.whl'))
with urllib.request.urlopen(wheel['url'],timeout=180) as response:
    data=response.read()
assert hashlib.sha256(data).hexdigest()==wheel['digests']['sha256']
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    member=next(name for name in archive.namelist() if name.endswith('/bin/uv'))
    binary=base/'runtime/uv/uv'; binary.parent.mkdir(exist_ok=True)
    binary.write_bytes(archive.read(member)); binary.chmod(0o755)
(base/'runtime/uv-release.json').write_text(json.dumps({'version':package['info']['version'],'filename':wheel['filename'],'sha256':wheel['digests']['sha256']},indent=2))
print('uv wheel verified:',package['info']['version'])
PY
fi
export UV_PYTHON_INSTALL_DIR="$base/runtime/python"
export UV_CACHE_DIR="$base/runtime/uv-cache"
"$base/runtime/uv/uv" python install 3.12
if [ ! -d "$base/runtime/parser-venv" ]; then
    "$base/runtime/uv/uv" venv --python 3.12 "$base/runtime/parser-venv"
fi
"$base/runtime/uv/uv" pip compile apps/parser/pyproject.toml --python "$base/runtime/parser-venv/bin/python" --generate-hashes --output-file "$base/shared/parser-requirements.lock" > "$base/shared/parser-resolution.log"
"$base/runtime/uv/uv" pip sync --python "$base/runtime/parser-venv/bin/python" --require-hashes "$base/shared/parser-requirements.lock"
"$base/runtime/parser-venv/bin/python" --version
chmod -R a+rX "$base/runtime/python" "$base/runtime/parser-venv"
install -m 644 deploy/competition-api.service /etc/systemd/system/competition-api.service
install -m 644 deploy/competition-parser.service /etc/systemd/system/competition-parser.service
if [ -L "$base/current" ]; then
    readlink "$base/current" > "$base/backups/$release_id-previous-release.txt"
fi
ln -s "$release" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
ln -s "$base/current/apps/web/dist" "$base/public/competition.next"
mv -Tf "$base/public/competition.next" "$base/public/competition"
systemctl daemon-reload
systemctl enable competition-parser.service competition-api.service
systemctl restart competition-parser.service competition-api.service
for attempt in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:3011/api/v1/readyz > "$base/shared/readiness.json" && curl -fsS http://127.0.0.1:8011/healthz >/dev/null; then
        cat "$base/shared/readiness.json"
        break
    fi
    sleep 2
done
curl -fsS http://127.0.0.1:3011/api/v1/readyz
curl -fsS http://127.0.0.1:8011/healthz
python3 - "$base/shared/readiness.json" <<'PY'
import json,sys
result=json.load(open(sys.argv[1]))['data']
assert result['status']=='ok'
assert result['dependencies']['database']=='ready'
assert result['dependencies']['parser']=='ready'
assert result['configuration']['profile']=='prod'
assert result['configuration']['pendingRestart']==0
PY
install -m 644 deploy/nginx-locations.conf /etc/nginx/competition-sj/locations.conf
python3 - "$base" "$release_id" <<'PY'
import pathlib,sys
base=pathlib.Path(sys.argv[1]); release=sys.argv[2]
file=pathlib.Path('/etc/nginx/conf.d/webserver.conf')
content=file.read_bytes()
include=b'    include /etc/nginx/competition-sj/locations.conf;\n'
if include not in content:
    anchor=b'    location / {'
    assert content.count(anchor)==1,'cannot locate original root route uniquely'
    (base/'backups'/f'{release}-webserver.conf').write_bytes(content)
    file.write_bytes(content.replace(anchor,include+anchor,1))
PY
if ! nginx -t; then
    if [ -f "$base/backups/$release_id-webserver.conf" ]; then
        cp "$base/backups/$release_id-webserver.conf" /etc/nginx/conf.d/webserver.conf
        nginx -t
    fi
    exit 1
fi
systemctl reload nginx
systemctl is-active competition-api competition-parser nginx
systemctl is-enabled competition-api competition-parser
ss -ltn | grep -E '3011|8011'
printf '\nDEPLOYMENT_READY %s\n' "$release_id"
