"""Compare HTTPS behavior and online data with a fresh pre-deployment baseline.

Credentials are read from a local access file and never written to the report.
Use --capture-baseline before replacing the program, then run without it.
"""

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--access-file", type=Path, required=True)
    parser.add_argument("--release-directory", type=Path, required=True)
    parser.add_argument("--capture-baseline", action="store_true")
    args = parser.parse_args()
    access = json.loads(args.access_file.read_text(encoding="utf-8"))
    base = access["url"].rstrip("/")
    origin = urllib.parse.urlsplit(base)
    origin_url = f"{origin.scheme}://{origin.netloc}"
    token = base64.b64encode((access["username"] + ":" + access["password"]).encode()).decode()
    opener = urllib.request.build_opener(NoRedirect)
    checks = []
    baseline_file = args.release_directory / "https-baseline.json"

    def request(url, *, authorized=True, body=None, extra_headers=None):
        headers = {"Accept": "application/json", "Cache-Control": "no-cache"}
        if authorized:
            headers["Authorization"] = "Basic " + token
        if body is not None:
            headers["Content-Type"] = "application/json"
        headers.update(extra_headers or {})
        message = urllib.request.Request(url, headers=headers, data=None if body is None else json.dumps(body).encode())
        try:
            response = opener.open(message, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def check(label, condition, **details):
        checks.append({"check": label, "passed": bool(condition), **details})

    def api(path, **options):
        status, _, data = request(base + "/api/v1" + path, **options)
        if status not in (200, 201):
            raise RuntimeError(f"API {path.split('?')[0]} returned {status}")
        return json.loads(data)["data"]

    current = {"checkedAt": datetime.now(timezone.utc).isoformat(), "url": base + "/", "queries": {}, "documents": {}}
    for label, query in [
        ("workspace", {"scope": "workspace", "includeExpired": True, "includeLowCredibility": True, "limit": 100}),
        ("published", {"scope": "published", "includeExpired": True, "includeLowCredibility": True, "limit": 100}),
        ("published-default", {"scope": "published", "limit": 100}),
        ("energy", {"scope": "workspace", "includeExpired": True, "keyword": "能源经济", "limit": 100}),
        ("agriculture", {"scope": "workspace", "includeExpired": True, "keyword": "智能农业", "limit": 100}),
    ]:
        result = api("/search/competitions", body=query)
        current["queries"][label] = {"total": result["page"]["total"],
                                      "ids": sorted(item["id"] for item in result["items"])}
    for document in api("/documents"):
        path = document["fileUrl"]
        if not path.startswith("/api/v1/documents/") or ".." in path:
            raise RuntimeError("Unexpected document download path")
        status, _, data = request(base + path)
        check("original document download " + document["id"], status == 200)
        current["documents"][document["id"]] = {"bytes": len(data), "sha256": digest(data)}
    current["unrelatedRoutes"] = {}
    for path in ("/", "/memories/", "/prod-api/"):
        status, _, data = request(origin_url + path, authorized=False)
        current["unrelatedRoutes"][path] = {"status": status, "bytes": len(data), "sha256": digest(data)}
    current["configurationVersion"] = api("/readyz")["configuration"]["version"]
    if args.capture_baseline:
        if baseline_file.exists():
            raise RuntimeError("Baseline exists; inspect it rather than silently overwriting")
        baseline_file.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"baseline": str(baseline_file), "queries": current["queries"],
                          "originals": len(current["documents"]), "configurationVersion": current["configurationVersion"]},
                         ensure_ascii=False, indent=2))
        return
    before = json.loads(baseline_file.read_text(encoding="utf-8"))
    for key in ("queries", "documents", "unrelatedRoutes", "configurationVersion"):
        check("unchanged " + key, current[key] == before[key])
    for path in ("/", "/library", "/api/v1/system/client-bootstrap", "/assets/missing.js"):
        status, _, _ = request(base + path, authorized=False)
        check("authentication required " + path, status == 401, status=status)
    status, headers, _ = request(base.replace("https:", "http:") + "/", authorized=False)
    check("HTTP redirects to HTTPS", status in (301, 308) and headers.get("Location", "").startswith("https:"), status=status)
    status, _, html = request(base + "/")
    check("SPA entry", status == 200 and b'<div id="root">' in html, status=status)
    preparation = json.loads((args.release_directory / "preparation-result.json").read_text(encoding="utf-8"))
    archive_path = Path(preparation["archive"])
    if not archive_path.exists():
        archive_path = args.release_directory / archive_path.name
    with tarfile.open(archive_path, "r:gz") as archive:
        expected_html = archive.extractfile("competition-sj-update/runtime/apps/web/dist/index.html").read()
        check("deployed index matches fresh build", html == expected_html)
        assets = re.findall(rb'(?:src|href)="([^\"]+\.(?:js|css|ico))"', html)
        check("subpath asset declarations", len(assets) >= 3 and all(asset.startswith(b"/competition/") for asset in assets), count=len(assets))
        for asset in assets:
            path = asset.decode()
            status, _, data = request(origin_url + path)
            expected = archive.extractfile("competition-sj-update/runtime/apps/web/dist/" + path.removeprefix("/competition/")).read()
            check("static asset " + path.rsplit("/", 1)[-1], status == 200 and data == expected,
                  bytes=len(data), sha256=digest(data))
        declared = {asset.decode() for asset in assets}
        prefix = "competition-sj-update/runtime/apps/web/dist/"
        for member in archive.getmembers():
            if not member.name.startswith(prefix + "assets/"):
                continue
            path = "/competition/" + member.name.removeprefix(prefix)
            if path in declared:
                continue
            status, _, data = request(origin_url + path)
            expected = archive.extractfile(member).read()
            check("emitted asset " + path.rsplit("/", 1)[-1], status == 200 and data == expected,
                  bytes=len(data), sha256=digest(data))
    for path in ("/library", "/collection", "/settings"):
        status, _, data = request(base + path)
        check("SPA deep link " + path, status == 200 and data == html, status=status)
    bootstrap = api("/system/client-bootstrap")
    check("production bootstrap", bootstrap["profile"] == "prod" and bootstrap["devIdentityAllowed"] is False
          and bootstrap["apiBaseUrl"] == base + "/api/v1")
    ready = api("/readyz")
    check("database and parser ready", ready["status"] == "ok" and
          all(ready["dependencies"][key] == "ready" for key in ("database", "parser")))
    check("production configuration applied", ready["configuration"]["profile"] == "prod" and
          ready["configuration"]["pendingRestart"] == 0 and ready["configuration"]["version"] == before["configurationVersion"])
    spoofed = api("/search/competitions", body={"scope": "workspace", "includeExpired": True,
                  "includeLowCredibility": True, "limit": 100},
                  extra_headers={"X-Actor-Id": "deployment-check", "X-Actor-Roles": "viewer", "X-Team-Id": "deployment-check"})
    check("gateway discards identity headers", spoofed["page"]["total"] == before["queries"]["workspace"]["total"])
    report = {"checkedAt": current["checkedAt"], "releaseId": preparation["releaseId"], "url": base + "/",
              "passed": all(item["passed"] for item in checks), "checks": checks,
              "queries": current["queries"], "originalDocuments": current["documents"], "readiness": ready}
    output = args.release_directory / "public-verification.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(output), "passed": report["passed"], "checks": len(checks),
                      "failed": [item for item in checks if not item["passed"]]}, ensure_ascii=False, indent=2))
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
