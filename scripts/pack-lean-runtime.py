import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tarfile


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    root = Path(sys.argv[1]).resolve()
    archive = Path(sys.argv[2]).resolve()
    if archive.exists():
        raise RuntimeError('Archive already exists')
    inventory = []
    skipped = []

    def walk(directory):
        for entry in sorted(os.scandir(directory), key=lambda item: item.name):
            path = Path(entry.path)
            relative = path.relative_to(root).as_posix()
            if entry.name in {'.credentials', '__pycache__'} or entry.name.startswith('.env'):
                skipped.append(relative)
                continue
            if path.suffix in {'.dll', '.exe', '.map'} or path.name.endswith(('.dll.node', '.d.ts', '.tsbuildinfo')):
                skipped.append(relative)
                continue
            metadata = path.lstat()
            if metadata.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                target = path.resolve()
                if not target.is_relative_to(root):
                    raise RuntimeError('Link outside package: ' + relative)
                value = os.path.relpath(target, path.parent).replace('\\', '/')
                inventory.append({'path': relative, 'type': 'symlink', 'target': value})
            elif entry.is_dir(follow_symlinks=False):
                walk(path)
            else:
                inventory.append({'path': relative, 'type': 'file', 'bytes': metadata.st_size,
                                  'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})

    walk(root)
    manifest = {'releaseType': 'prebuilt-linux-runtime', 'linuxEngine': 'debian-openssl-3.0.x',
                'runtimeDependencyInstallRequired': False, 'files': inventory}
    manifest_path = root / 'LEAN-MANIFEST.json'
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    with tarfile.open(archive, 'w:gz', compresslevel=9) as output:
        for item in inventory:
            path = root / item['path']
            name = 'competition-sj/' + item['path']
            info = tarfile.TarInfo(name)
            info.mtime = 0
            if item['type'] == 'symlink':
                info.type = tarfile.SYMTYPE
                info.linkname = item['target']
                info.mode = 0o777
                output.addfile(info)
            else:
                info.size = item['bytes']
                info.mode = 0o644
                with path.open('rb') as source:
                    output.addfile(info, source)
        info = output.gettarinfo(str(manifest_path), arcname='competition-sj/LEAN-MANIFEST.json')
        info.uid = info.gid = 0
        info.uname = info.gname = ''
        info.mode = 0o644
        with manifest_path.open('rb') as source:
            output.addfile(info, source)
    result = {'archive': str(archive), 'archiveBytes': archive.stat().st_size,
              'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
              'unpackedBytes': sum(item.get('bytes', 0) for item in inventory) + manifest_path.stat().st_size,
              'files': sum(item['type'] == 'file' for item in inventory) + 1,
              'links': sum(item['type'] == 'symlink' for item in inventory),
              'windowsTargetsExcluded': True, 'credentialsExcluded': True,
              'excludedFiles': len(skipped)}
    (archive.parent / 'lean-package-result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
