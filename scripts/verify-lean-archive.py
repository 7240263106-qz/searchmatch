import hashlib
import json
from pathlib import Path, PurePosixPath
import posixpath
import sqlite3
import sys
import tarfile


def main():
    archive = Path(sys.argv[1]).resolve()
    root = Path(__file__).resolve().parent.parent
    if not archive.is_relative_to(root / 'artifacts' / 'deployments'):
        raise RuntimeError('Only deployment artifacts can be verified')
    prefix = 'competition-sj/'
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        paths = {member.name for member in members}
        if len(paths) != len(members):
            raise RuntimeError('Duplicate archive entries')
        manifest_name = prefix + 'LEAN-MANIFEST.json'
        manifest = json.load(bundle.extractfile(manifest_name))
        expected = {prefix + item['path'] for item in manifest['files']} | {manifest_name}
        if paths != expected:
            raise RuntimeError('Archive inventory differs from manifest')
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not member.name.startswith(prefix):
                raise RuntimeError('Unsafe archive path')
            if any(part == '.credentials' or part.startswith('.env') for part in path.parts):
                raise RuntimeError('Credentials or environment file in archive')
            if member.name.endswith(('.exe', '.dll', '.dll.node', '.map', '.d.ts', '.tsbuildinfo')):
                raise RuntimeError('Unexpected development or Windows target')
            if not member.isfile() and not member.issym():
                raise RuntimeError('Unexpected archive entry type')
        for item in manifest['files']:
            member = bundle.getmember(prefix + item['path'])
            if item['type'] == 'symlink':
                if not member.issym() or member.linkname != item['target']:
                    raise RuntimeError('Symlink differs from manifest')
                target = posixpath.normpath(posixpath.join(posixpath.dirname(member.name), member.linkname))
                if member.linkname.startswith('/') or not target.startswith(prefix):
                    raise RuntimeError('Symlink escapes archive')
                if target not in paths and not any(name.startswith(target + '/') for name in paths):
                    raise RuntimeError('Broken archive symlink: ' + member.name)
            else:
                data = bundle.extractfile(member).read()
                if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
                    raise RuntimeError('File differs from manifest: ' + member.name)
        engine = bundle.extractfile(prefix + 'apps/api/node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node').read(20)
        if engine[:6] != b'\x7fELF\x02\x01' or int.from_bytes(engine[18:20], 'little') != 62:
            raise RuntimeError('Incorrect Linux engine architecture')
        source = root / 'artifacts/deployments/server-20261117-02/competition-sj/deployment-data'
        snapshot = source / 'competition.db'
        bundled_database = bundle.extractfile(prefix + 'deployment-data/competition.db').read()
        if hashlib.sha256(bundled_database).digest() != hashlib.sha256(snapshot.read_bytes()).digest():
            raise RuntimeError('Reviewed database snapshot changed')
        with sqlite3.connect(f'file:{snapshot.as_posix()}?mode=ro', uri=True) as database:
            if database.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Database integrity check failed')
            originals = database.execute('SELECT storageKey FROM CompetitionDocument').fetchall()
        for (key,) in originals:
            data = bundle.extractfile(prefix + 'deployment-data/uploads/' + key).read()
            if hashlib.sha256(data).digest() != hashlib.sha256((source / 'uploads' / key).read_bytes()).digest():
                raise RuntimeError('Original document changed')
        result = json.loads((archive.parent / 'lean-package-result.json').read_text())
        if hashlib.sha256(archive.read_bytes()).hexdigest() != result['archiveSha256']:
            raise RuntimeError('Archive checksum differs from package result')
        result.update({
            'archiveBytes': archive.stat().st_size,
            'unpackedBytes': sum(member.size for member in members if member.isfile()),
            'files': sum(member.isfile() for member in members),
            'links': sum(member.issym() for member in members),
            'archiveVerified': True,
            'linuxEngineArchitecture': 'ELF64 x86-64',
            'reviewedSnapshotUnchanged': True,
            'originalDocumentHashesVerified': len(originals),
            'linuxExecutionVerified': False,
        })
    (archive.parent / 'lean-package-result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
