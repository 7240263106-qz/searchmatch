"""Replace application code while keeping the deployed database and settings.

Run with sudo on the existing Linux server. --dry-run validates the full archive,
capacity and dependency/schema compatibility without stopping services. This is
an update tool, not a first-install tool or a database migration tool.
"""

import argparse
from datetime import datetime, timezone
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import urllib.request


BASE = Path("/opt/competition-sj")
SERVICES = ["competition-parser.service", "competition-api.service"]
STABLE_TABLES = [
    "Competition", "CompetitionDocument", "CompetitionEdition", "CompetitionGroup",
    "CompetitionOrganizer", "CompetitionSeries", "CompetitionTrack", "CompetitionVersion",
    "DocumentCompetitionLink", "FieldEvidence", "Organizer", "RegistrationStage",
    "ReviewRecord", "SignupEntry", "SourceMaterial", "SystemConfigValue",
    "SystemConfigVersion", "CredentialRef",
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(*arguments, **options):
    return subprocess.run(arguments, check=True, text=True, capture_output=True, **options).stdout.strip()


def read_json(file):
    return json.loads(file.read_text(encoding="utf-8"))


def schema_digest(file):
    text = re.sub(r"generator\s+client\s*\{[^}]*\}", "", file.read_text(encoding="utf-8"))
    tokens = re.findall(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[^\s]', text)
    normalized = json.dumps([token for token in tokens if not token.startswith(("//", "/*"))], separators=(",", ":"))
    return digest(normalized.encode())


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def shared_snapshot():
    database = BASE / "shared/competition.db"
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        connection.execute("BEGIN")
        check(connection.execute("PRAGMA quick_check").fetchone()[0] == "ok", "Database quick_check failed")
        tables = {}
        for table in STABLE_TABLES:
            rows = connection.execute(f'SELECT * FROM "{table}"').fetchall()
            encoded = sorted(json.dumps(row, ensure_ascii=False, default=str) for row in rows)
            tables[table] = {"count": len(rows), "sha256": digest("\n".join(encoded).encode())}
        formal = connection.execute("SELECT publishStatus,count(*) FROM Competition WHERE deletedAt IS NULL AND dataOrigin='formal' AND demoFlag=0 AND parentId IS NULL GROUP BY publishStatus ORDER BY publishStatus").fetchall()
        documents = connection.execute("SELECT id,storageKey FROM CompetitionDocument ORDER BY id").fetchall()
    originals = {}
    for document_id, key in documents:
        file = BASE / "shared/uploads" / key
        check(file.resolve().is_relative_to((BASE / "shared/uploads").resolve()), "Unsafe document storage key")
        originals[document_id] = {"storageKey": key, "bytes": file.stat().st_size, "sha256": digest(file.read_bytes())}
    credentials = {
        file.relative_to(BASE / "shared/credentials").as_posix(): digest(file.read_bytes())
        for file in sorted((BASE / "shared/credentials").rglob("*")) if file.is_file()
    }
    return {"integrity": "ok", "tables": tables, "formalCounts": formal,
            "documents": originals, "credentialFileHashes": credentials}


def readiness(timeout=60):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:3011/api/v1/readyz", timeout=3) as response:
                api = json.load(response)["data"]
            with urllib.request.urlopen("http://127.0.0.1:8011/healthz", timeout=3) as response:
                parser = json.load(response)
            check(api["status"] == "ok" and parser["status"] == "ok", "Service not healthy")
            check(all(api["dependencies"][key] == "ready" for key in ("database", "parser")), "Dependency not ready")
            check(api["configuration"]["profile"] == "prod" and api["configuration"]["pendingRestart"] == 0,
                  "Production configuration is not fully applied")
            return api
        except Exception as error:
            last_error = error
            time.sleep(1)
    raise RuntimeError(f"Readiness timed out: {last_error}")


def point_current(target):
    next_link = BASE / "current.update-next"
    check(not next_link.exists() and not next_link.is_symlink(), "Unexpected temporary current link")
    next_link.symlink_to(target, target_is_directory=True)
    os.replace(next_link, BASE / "current")


def archive_manifest(archive, expected_hash, release_id):
    check(digest(archive.read_bytes()) == expected_hash, "Upload checksum mismatch")
    prefix = "competition-sj-update/"
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        names = [member.name for member in members]
        check(len(set(names)) == len(names), "Duplicate archive entries")
        check(sum(member.size for member in members) < 100 * 1024 * 1024, "Unexpectedly large update payload")
        for member in members:
            path = PurePosixPath(member.name)
            check(member.isfile() and member.name.startswith(prefix) and not path.is_absolute()
                  and ".." not in path.parts, "Unsafe archive entry")
            check(not any(part in {".credentials", "uploads", "storage", "node_modules", ".pnpm-store"}
                          or (part.startswith(".env") and part != ".env.example") for part in path.parts),
                  "Runtime state or credentials in update archive")
            check(not re.search(r"\.(?:db(?:-(?:wal|shm|journal))?|key|pem|pfx|log|pyc)$", path.name),
                  "Unexpected state/credential file")
            check(not re.search(r"\.(?:db|sqlite3?|bak)(?:[.-]|$)", path.name, re.IGNORECASE),
                  "Database snapshot or backup in update archive")
        manifest = json.load(bundle.extractfile(prefix + "UPDATE-MANIFEST.json"))
        check(manifest["releaseId"] == release_id and manifest["type"] == "source-and-build-update-preserve-shared",
              "Wrong release manifest")
        expected = {prefix + item["path"] for item in manifest["files"]} | {prefix + "UPDATE-MANIFEST.json"}
        check(set(names) == expected, "Manifest inventory mismatch")
        for item in manifest["files"]:
            data = bundle.extractfile(prefix + item["path"]).read()
            check(not data.startswith(b"SQLite format 3\x00") and
                  not re.search(rb"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----", data),
                  "Database/private key content in update archive")
            check(len(data) == item["bytes"] and digest(data) == item["sha256"], "Payload hash mismatch: " + item["path"])
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release_id")
    parser.add_argument("archive", type=Path)
    parser.add_argument("sha256")
    parser.add_argument("--expected-current", required=True)
    parser.add_argument("--runtime-lock-sha256", help="Verified installed lock hash, required for legacy releases without a lockfile")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    check(os.geteuid() == 0, "Run with sudo")
    check(re.fullmatch(r"lean-\d{8}-\d{2}", args.release_id), "Invalid release ID")
    check(re.fullmatch(r"[a-f0-9]{64}", args.sha256), "Invalid archive checksum")
    with (BASE / "install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = (BASE / "current").resolve(strict=True)
        releases = (BASE / "releases").resolve(strict=True)
        check(current.parent == releases and current.name == args.expected_current, "Current release changed; inspect before retrying")
        release = releases / args.release_id
        check(not release.exists(), "Release already exists; do not overwrite it")
        manifest = archive_manifest(args.archive, args.sha256, args.release_id)
        free = shutil.disk_usage(BASE).free
        inodes = os.statvfs(BASE).f_favail
        check(free > 512 * 1024 * 1024 + 3 * sum(item["bytes"] for item in manifest["files"]), "Insufficient free disk space")
        check(inodes > 20000, "Insufficient free inodes")
        baseline = manifest["baseline"]
        check(read_json(current / "apps/api/package.json")["dependencies"] == baseline["apiDependencies"],
              "API dependencies changed; use a fresh Linux dependency build")
        check(digest((current / "apps/parser/pyproject.toml").read_bytes()) == baseline["parserProjectSha256"],
              "Parser dependencies changed; a separate environment upgrade is required")
        check(schema_digest(current / "apps/api/node_modules/.prisma/client/schema.prisma") == baseline["schemaNormalizedSha256"],
              "Database schema changed; an explicit migration is required")
        installed_lock = digest((current / "pnpm-lock.yaml").read_bytes()) if (current / "pnpm-lock.yaml").is_file() else args.runtime_lock_sha256
        check(installed_lock == baseline["lockfileSha256"], "Installed dependency lock differs or has not been verified")
        for name, installed in [("nginx-locations.conf", "/etc/nginx/competition-sj/locations.conf"),
                                ("competition-api.service", "/etc/systemd/system/competition-api.service"),
                                ("competition-parser.service", "/etc/systemd/system/competition-parser.service")]:
            expected = next(item["sha256"] for item in manifest["files"] if item["path"] == "source/deploy/" + name)
            check(digest(Path(installed).read_bytes()) == expected, "Gateway/service definition changed; explicit installation required: " + name)
        before_ready = readiness(10)
        result = {"releaseId": args.release_id, "previousRelease": str(current), "availableBytesBefore": free,
                  "freeInodesBefore": inodes, "archiveSha256": args.sha256,
                  "payloadFiles": len(manifest["files"]), "dependencyAndSchemaChecks": "passed"}
        if args.dry_run:
            print(json.dumps({**result, "dryRun": True, "servicesStopped": False}, indent=2))
            return
        backup = BASE / "backups" / args.release_id
        backup.mkdir(mode=0o750, exist_ok=False)
        (backup / "preflight.json").write_text(json.dumps(result, indent=2))
        switched = stopped = False
        try:
            with tempfile.TemporaryDirectory(prefix=args.release_id + "-payload-", dir=releases) as temporary:
                with tarfile.open(args.archive, "r:gz") as bundle:
                    bundle.extractall(temporary)
                payload = Path(temporary) / "competition-sj-update"
                shutil.copytree(current, release, symlinks=True)
                for stale in ["deployment-data", "LEAN-MANIFEST.json", "RELEASE-MANIFEST.json", "UPDATE-MANIFEST.json"]:
                    target = release / stale
                    if target.is_dir() and not target.is_symlink():
                        shutil.rmtree(target)
                    elif target.exists() or target.is_symlink():
                        target.unlink()
                shutil.copytree(payload / "source", release, dirs_exist_ok=True)
                contracts = (release / "apps/api/node_modules/@competition/contracts").resolve(strict=True)
                check(contracts.is_relative_to(release), "Contracts dependency points outside the new release")
                for source, destination in [
                    (payload / "runtime/apps/api/dist", release / "apps/api/dist"),
                    (payload / "runtime/apps/web/dist", release / "apps/web/dist"),
                    (payload / "runtime/packages/contracts/dist", release / "packages/contracts/dist"),
                    (payload / "runtime/packages/contracts/dist", contracts / "dist"),
                ]:
                    if destination.exists():
                        shutil.rmtree(destination)
                    shutil.copytree(source, destination)
                shutil.copy2(payload / "UPDATE-MANIFEST.json", release / "UPDATE-MANIFEST.json")
                for item in manifest["files"]:
                    relative = item["path"].split("/", 1)[1]
                    check(digest((release / relative).read_bytes()) == item["sha256"], "Candidate release differs from package: " + relative)
            run("runuser", "-u", "competition-sj", "--", str(BASE / "runtime/node/bin/node"), "-e",
                "require('@nestjs/core');require('@prisma/client');require('@competition/contracts');console.log('modules-ok')",
                cwd=release / "apps/api")
            run(str(BASE / "runtime/parser-venv/bin/python"), "-c",
                "import ast,pathlib,fastapi,fitz,docx,openpyxl;ast.parse(pathlib.Path('app/main.py').read_text());print('parser-ok')",
                cwd=release / "apps/parser")
            check((BASE / "current").resolve() == current, "Current pointer changed during preparation")
            stopped = True
            run("systemctl", "stop", *SERVICES)
            before = shared_snapshot()
            with sqlite3.connect(BASE / "shared/competition.db") as source, sqlite3.connect(backup / "competition.db") as target:
                source.backup(target)
                check(target.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "Database backup failed")
            os.chmod(backup / "competition.db", 0o600)
            run("tar", "-czf", str(backup / "shared-files.tar.gz"), "-C", str(BASE / "shared"), "uploads", "credentials")
            os.chmod(backup / "shared-files.tar.gz", 0o600)
            (backup / "database-before.json").write_text(json.dumps(before, indent=2))
            shared = BASE / "shared"
            os.chown(shared, 0, grp.getgrnam("competition-sj").gr_gid)
            shared.chmod(0o770)
            run("runuser", "-u", "competition-sj", "--", "python3", "-c",
                "import sqlite3;c=sqlite3.connect('/opt/competition-sj/shared/competition.db');c.execute('BEGIN IMMEDIATE');c.rollback();c.close()")
            public = BASE / "public/competition"
            check(public.is_symlink() and os.readlink(public) == str(BASE / "current/apps/web/dist"),
                  "Unexpected public link; refusing an implicit gateway change")
            point_current(release)
            switched = True
            run("systemctl", "start", *SERVICES)
            after_ready = readiness()
            check(after_ready["configuration"]["version"] == before_ready["configuration"]["version"], "Configuration version changed")
            after = shared_snapshot()
            (backup / "database-after.json").write_text(json.dumps(after, indent=2))
            check(before == after, "Business data, configuration, credentials or original documents changed")
            check(all(run("systemctl", "is-active", service) == "active" for service in SERVICES), "Application service inactive")
            run("nginx", "-t")
            result.update({"state": "deployed", "checkedAt": datetime.now(timezone.utc).isoformat(),
                           "currentRelease": str(release), "backupDirectory": str(backup),
                           "readiness": after_ready, "sharedUnchanged": True,
                           "databaseWriteTransactionRolledBack": True,
                           "formalCounts": after["formalCounts"], "documents": after["documents"],
                           "availableBytesAfter": shutil.disk_usage(BASE).free})
            (backup / "deployment-result.json").write_text(json.dumps(result, indent=2))
            print(json.dumps(result, indent=2))
        except BaseException:
            if stopped:
                run("systemctl", "stop", *SERVICES)
                if switched:
                    point_current(current)
                run("systemctl", "start", *SERVICES)
                readiness()
                (backup / "rollback.json").write_text(json.dumps({"restoredRelease": str(current), "databaseRestored": False}))
            raise


if __name__ == "__main__":
    main()
