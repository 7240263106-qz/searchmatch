"""Package current source and fresh builds without a database or credentials.

Usage: python scripts/prepare-update-release.py lean-YYYYMMDD-NN
The server updater reuses a verified existing Linux dependency installation.
"""

import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tarfile
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parent.parent
EXCLUDED = {
    "node_modules", ".pnpm-store", ".credentials", ".codeartsdoer", ".git",
    "__pycache__", ".venv", ".pytest_cache", ".cache", ".vite", "dist",
    "build", "coverage", "uploads", "storage", "artifacts", "evidence",
}


def source_files():
    for current, directories, files in os.walk(ROOT, followlinks=False):
        directories[:] = sorted(name for name in directories if name not in EXCLUDED)
        for name in sorted(files):
            file = Path(current) / name
            if file.is_symlink() or (hasattr(file, "is_junction") and file.is_junction()):
                raise RuntimeError(f"Unexpected source link: {file.relative_to(ROOT)}")
            if name.startswith(".env") and name != ".env.example":
                continue
            if re.search(r"\.(?:db|sqlite3?|bak)(?:[.-]|$)", name, re.IGNORECASE):
                continue
            if re.search(r"\.(?:db(?:-(?:wal|shm|journal))?|log|pyc|pyo|tsbuildinfo|zip|gz)$", name):
                continue
            if name == "COMPETITION_CATALOG_COMPLETION_REPORT.md":
                continue
            yield file


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def normalized_schema(data):
    data = re.sub(r"generator\s+client\s*\{[^}]*\}", "", data)
    tokens = re.findall(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[^\s]', data)
    return json.dumps([token for token in tokens if not token.startswith(("//", "/*"))], separators=(",", ":"))


def main():
    release_id = sys.argv[1]
    if not re.fullmatch(r"lean-\d{8}-\d{2}", release_id):
        raise RuntimeError("Use a unique lean-YYYYMMDD-NN release ID")
    output = ROOT / "artifacts/deployments" / release_id
    output.mkdir(parents=True, exist_ok=False)
    archive = output / f"{release_id}-update.tar.gz"
    inputs = [(file, "source/" + file.relative_to(ROOT).as_posix()) for file in source_files()]
    for directory in ("apps/api/dist", "apps/web/dist", "packages/contracts/dist"):
        path = ROOT / directory
        if not path.is_dir():
            raise RuntimeError(f"Missing fresh build: {directory}")
        for file in sorted(path.rglob("*")):
            if file.is_file() and not re.search(r"(?:\.test\.js|\.map|\.tsbuildinfo)$", file.name):
                inputs.append((file, "runtime/" + file.relative_to(ROOT).as_posix()))
    web = (ROOT / "apps/web/dist/index.html").read_text(encoding="utf-8")
    assets = re.findall(r'(?:src|href)="([^\"]+\.(?:js|css|ico))"', web)
    if len(assets) < 3 or not all(asset.startswith("/competition/") for asset in assets):
        raise RuntimeError("Web build must use the /competition/ base path")
    manifest = {
        "releaseId": release_id,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "type": "source-and-build-update-preserve-shared",
        "databaseIncluded": False,
        "credentialsIncluded": False,
        "baseline": {
            "apiDependencies": json.loads((ROOT / "apps/api/package.json").read_text())["dependencies"],
            "parserProjectSha256": sha256((ROOT / "apps/parser/pyproject.toml").read_bytes()),
            "schemaNormalizedSha256": sha256(normalized_schema((ROOT / "apps/api/prisma/schema.prisma").read_text(encoding="utf-8")).encode()),
            "lockfileSha256": sha256((ROOT / "pnpm-lock.yaml").read_bytes()),
        },
        "files": [],
    }
    with tarfile.open(archive, "w:gz", compresslevel=9) as bundle:
        for file, name in inputs:
            data = file.read_bytes()
            if data.startswith(b"SQLite format 3\x00") or re.search(rb"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----", data):
                raise RuntimeError("Database/private key found in source or build: " + name)
            manifest["files"].append({"path": name, "bytes": len(data), "sha256": sha256(data)})
            info = tarfile.TarInfo("competition-sj-update/" + name)
            info.size = len(data)
            info.mode = 0o644
            bundle.addfile(info, io.BytesIO(data))
        data = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
        info = tarfile.TarInfo("competition-sj-update/UPDATE-MANIFEST.json")
        info.size = len(data)
        info.mode = 0o644
        bundle.addfile(info, io.BytesIO(data))
    with tarfile.open(archive, "r:gz") as bundle:
        entries = {entry.name: entry for entry in bundle.getmembers()}
        if len(entries) != len(manifest["files"]) + 1:
            raise RuntimeError("Archive contains duplicate or missing entries")
        for item in manifest["files"]:
            data = bundle.extractfile(entries["competition-sj-update/" + item["path"]]).read()
            if len(data) != item["bytes"] or sha256(data) != item["sha256"]:
                raise RuntimeError("Archive failed read-back verification")
    result = {"releaseId": release_id, "archive": str(archive), "bytes": archive.stat().st_size,
              "sha256": sha256(archive.read_bytes()), "files": len(manifest["files"]),
              "unpackedBytes": sum(item["bytes"] for item in manifest["files"]),
              "databaseIncluded": False, "credentialsIncluded": False, "verified": True}
    (output / "preparation-result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
