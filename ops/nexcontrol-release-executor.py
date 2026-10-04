#!/usr/bin/env python3
import argparse, base64, hashlib, io, json, os, pathlib, re, shutil, subprocess, sys, tarfile, tempfile, time, urllib.request

ALLOWED_ROOTS = ("/opt/nex/releases/", "/opt/nex/apps/", "/opt/nex/current/")
IDENT = re.compile(r"^[A-Za-z0-9._-]{1,120}$")
SERVICE = re.compile(r"^[A-Za-z0-9@_.:-]+\.service$")

def fail(msg):
    raise RuntimeError(msg)

def run(cmd, cwd=None, timeout=900):
    p = subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str), text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
                       executable="/bin/bash" if isinstance(cmd, str) else None)
    if p.returncode != 0:
        fail(f"command_failed[{p.returncode}]: {cmd}\nstdout={p.stdout[-4000:]}\nstderr={p.stderr[-4000:]}")
    return {"code": p.returncode, "stdout": p.stdout[-12000:], "stderr": p.stderr[-12000:]}

def safe_abs(value, label):
    p = os.path.abspath(str(value or ""))
    if not any(p.startswith(root) for root in ALLOWED_ROOTS):
        fail(f"unsafe_{label}:{p}")
    return p

def safe_ident(value, label):
    s = str(value or "")
    if not IDENT.fullmatch(s):
        fail(f"invalid_{label}")
    return s

def safe_service(value):
    s = str(value or "")
    if not SERVICE.fullmatch(s):
        fail("invalid_service")
    return s

def b64_payload(raw):
    pad = "=" * ((4 - len(raw) % 4) % 4)
    return json.loads(base64.urlsafe_b64decode((raw + pad).encode()).decode())

def download(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": "NexControl-Release-Executor/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def copy_component(src, dst):
    ignore = shutil.ignore_patterns(".git", "node_modules", ".nexcontrol", "*.log")
    shutil.copytree(src, dst, symlinks=True, ignore=ignore)

def safe_extract_xz(data, dst):
    root = os.path.realpath(dst)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as tf:
        for member in tf.getmembers():
            target = os.path.realpath(os.path.join(dst, member.name))
            if not (target == root or target.startswith(root + os.sep)):
                fail("archive_path_traversal")
        tf.extractall(dst)

def locate_component(root, component):
    component = str(component or ".").strip("/")
    if component in ("", "."):
        return root
    direct = os.path.join(root, component)
    if os.path.isdir(direct):
        return direct
    children = [os.path.join(root, x) for x in os.listdir(root)]
    dirs = [x for x in children if os.path.isdir(x)]
    if len(dirs) == 1:
        nested = os.path.join(dirs[0], component)
        if os.path.isdir(nested):
            return nested
    fail("component_not_found:" + component)

def source_git(cfg, work, release):
    owner = safe_ident(cfg["repoOwner"], "repo_owner")
    repo = safe_ident(cfg["repoName"], "repo_name")
    sha = str(cfg["commitSha"])
    if not re.fullmatch(r"[0-9a-fA-F]{40}", sha):
        fail("invalid_commit_sha")
    repo_dir = os.path.join(work, "repo")
    os.mkdir(repo_dir)
    run(["git", "init", "-q"], cwd=repo_dir, timeout=60)
    run(["git", "remote", "add", "origin", f"https://github.com/{owner}/{repo}.git"], cwd=repo_dir, timeout=30)
    run(["git", "fetch", "--depth=1", "origin", sha], cwd=repo_dir, timeout=180)
    run(["git", "checkout", "-q", "--detach", "FETCH_HEAD"], cwd=repo_dir, timeout=60)
    src = locate_component(repo_dir, cfg.get("componentPath", "."))
    copy_component(src, release)

def source_bundle(cfg, work, release):
    owner = safe_ident(cfg["repoOwner"], "repo_owner")
    repo = safe_ident(cfg["repoName"], "repo_name")
    sha = str(cfg["commitSha"])
    if not re.fullmatch(r"[0-9a-fA-F]{40}", sha):
        fail("invalid_commit_sha")
    count = int(cfg.get("bundlePartCount") or 0)
    pattern = str(cfg.get("bundlePartsPattern") or "")
    if not 1 <= count <= 100 or ("{index}" not in pattern and "*" not in pattern):
        fail("invalid_bundle_spec")
    chunks = []
    for i in range(count):
        name = pattern.replace("{index}", f"{i:02d}") if "{index}" in pattern else pattern.replace("*", f"{i:02d}", 1)
        if "/" in name or "\\" in name or ".." in name:
            fail("unsafe_bundle_part")
        raw = download(f"https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{name}")
        clean = b"".join(raw.split())
        chunks.append(base64.b64decode(clean, validate=True))
    extracted = os.path.join(work, "bundle")
    os.mkdir(extracted)
    safe_extract_xz(b"".join(chunks), extracted)
    src = locate_component(extracted, cfg.get("componentPath", "."))
    copy_component(src, release)

def run_project_command(command, release, label):
    command = str(command or "").strip()
    if not command:
        return {"skipped": True}
    if len(command) > 4000 or any(x in command for x in ("\x00", "\r")):
        fail("invalid_" + label + "_command")
    return run(command, cwd=release, timeout=1200)

def atomic_switch(current_path, release_path):
    parent = os.path.dirname(current_path)
    os.makedirs(parent, exist_ok=True)
    previous = os.path.realpath(current_path) if os.path.islink(current_path) else None
    if os.path.lexists(current_path) and not os.path.islink(current_path):
        fail("current_path_not_symlink")
    tmp_link = current_path + ".nxc-next-" + str(os.getpid())
    try:
        if os.path.lexists(tmp_link):
            os.unlink(tmp_link)
        os.symlink(release_path, tmp_link)
        os.replace(tmp_link, current_path)
    finally:
        if os.path.lexists(tmp_link):
            os.unlink(tmp_link)
    return previous

def local_health(checks):
    results = []
    for check in checks or []:
        if check.get("enabled") is False:
            continue
        typ = str(check.get("type") or "")
        target = str(check.get("target") or "")
        timeout = max(1, min(30, int(check.get("timeout") or 10)))
        if typ == "process":
            safe_service(target)
            r = subprocess.run(["systemctl", "is-active", "--quiet", target], timeout=timeout)
            results.append({"name": check.get("name"), "type": typ, "target": target, "ok": r.returncode == 0})
        elif typ == "http":
            expected = int((check.get("config") or {}).get("expectedStatus", 200))
            try:
                req = urllib.request.Request(target, method=str((check.get("config") or {}).get("method", "GET")))
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    status = int(resp.status)
                results.append({"name": check.get("name"), "type": typ, "target": target, "ok": status == expected, "status": status})
            except Exception as e:
                results.append({"name": check.get("name"), "type": typ, "target": target, "ok": False, "error": type(e).__name__})
        else:
            results.append({"name": check.get("name"), "type": typ, "target": target, "ok": True, "deferred": True})
    return results

def rollback_only(cfg):
    current = safe_abs(cfg["currentPath"], "current_path")
    previous = safe_abs(cfg["previousTarget"], "previous_target")
    service = safe_service(cfg["service"])
    if not os.path.isdir(previous):
        fail("rollback_target_missing")
    tmp_link = current + ".nxc-rollback-" + str(os.getpid())
    if os.path.lexists(current) and not os.path.islink(current):
        fail("current_path_not_symlink")
    try:
        if os.path.lexists(tmp_link):
            os.unlink(tmp_link)
        os.symlink(previous, tmp_link)
        os.replace(tmp_link, current)
    finally:
        if os.path.lexists(tmp_link):
            os.unlink(tmp_link)
    run(["systemctl", "restart", service], timeout=120)
    time.sleep(2)
    health = local_health(cfg.get("healthChecks") or [])
    local_required = [x for x in health if not x.get("deferred")]
    ok = not any(not x.get("ok") for x in local_required)
    report = {
        "ok": ok, "operation": "rollback", "currentPath": current,
        "previousTarget": previous, "service": service, "health": health,
        "completedAt": time.time()
    }
    print(json.dumps(report, separators=(",", ":")))
    return 0 if ok else 1

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--payload", required=True)
    args = ap.parse_args()
    cfg = b64_payload(args.payload)
    if str(cfg.get("operation") or "deploy") == "rollback":
        return rollback_only(cfg)
    release = safe_abs(cfg["releasePath"], "release_path")
    current = safe_abs(cfg["currentPath"], "current_path")
    service = safe_service(cfg["service"])
    slug = safe_ident(cfg["projectSlug"], "project_slug")
    deployment_id = str(cfg["deploymentId"])
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", deployment_id):
        fail("invalid_deployment_id")
    if os.path.lexists(release):
        fail("release_path_exists")
    os.makedirs(os.path.dirname(release), exist_ok=True)

    switched = False
    previous = None
    report = {
        "ok": False, "deploymentId": deployment_id, "project": slug,
        "releasePath": release, "currentPath": current, "service": service,
        "commitSha": cfg.get("commitSha"), "steps": {}, "startedAt": time.time()
    }
    work = tempfile.mkdtemp(prefix="nxc-release-")
    try:
        source_type = str(cfg.get("sourceType") or "")
        if source_type == "git_root":
            source_git(cfg, work, release)
        elif source_type == "bundle_component":
            source_bundle(cfg, work, release)
        else:
            fail("unsupported_source_type")
        report["steps"]["source"] = {"ok": True, "type": source_type}

        metadata = {
            "deploymentId": deployment_id, "project": slug,
            "repository": f'{cfg["repoOwner"]}/{cfg["repoName"]}',
            "commitSha": cfg["commitSha"], "createdAt": time.time()
        }
        pathlib.Path(release, "RELEASE_METADATA").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

        report["steps"]["install"] = run_project_command(cfg.get("installCommand"), release, "install")
        report["steps"]["build"] = run_project_command(cfg.get("buildCommand"), release, "build")
        report["steps"]["validate"] = run_project_command(cfg.get("predeployCommand"), release, "predeploy")

        previous = atomic_switch(current, release)
        switched = True
        report["previousTarget"] = previous
        report["steps"]["switch"] = {"ok": True}

        run(["systemctl", "restart", service], timeout=120)
        report["steps"]["restart"] = {"ok": True}

        time.sleep(2)
        health = local_health(cfg.get("healthChecks") or [])
        report["steps"]["health"] = health
        local_required = [x for x in health if not x.get("deferred")]
        if any(not x.get("ok") for x in local_required):
            fail("local_health_failed")

        report["steps"]["postdeploy"] = run_project_command(cfg.get("postdeployCommand"), release, "postdeploy")
        report["ok"] = True
        report["completedAt"] = time.time()
        print(json.dumps(report, separators=(",", ":")))
        return 0
    except Exception as e:
        report["error"] = str(e)[:4000]
        if switched and previous and os.path.isdir(previous):
            try:
                tmp_link = current + ".nxc-rollback-" + str(os.getpid())
                if os.path.lexists(tmp_link):
                    os.unlink(tmp_link)
                os.symlink(previous, tmp_link)
                os.replace(tmp_link, current)
                run(["systemctl", "restart", service], timeout=120)
                report["rollback"] = {"ok": True, "target": previous}
            except Exception as rexc:
                report["rollback"] = {"ok": False, "error": str(rexc)[:2000]}
        else:
            report["rollback"] = {"ok": False, "notRequired": not switched, "previousTarget": previous}
        report["completedAt"] = time.time()
        print(json.dumps(report, separators=(",", ":")))
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)

if __name__ == "__main__":
    sys.exit(main())
