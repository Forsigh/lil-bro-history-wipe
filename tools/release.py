"""One release, one command.

Bump, note, test, build, table, publish, deliver. Each of those was a manual step, and each
of them has failed at least once: a zip rebuilt under a version that already existed, a
manifest written with CRLF that the packager refused, a probe that broke on a pinned version
literal, and a version that got a row and a changelog entry but never a GitHub release. This
script does them in order and stops at the first thing that is not true.

Usage, from the extension root:

    python tools/release.py 1.5.9                  the normal release
    python tools/release.py 1.5.9 --probe 9521     drive the real extension in a browser first
    python tools/release.py 1.5.9 --dry-run        print the steps and change nothing

Write the release note before running it: builds/release-notes-<version>.md, a short paragraph
or three saying what changed and why, in the voice the changelog uses. The script copies that
note into CHANGELOG.md and into the GitHub release. It will not write release copy for you, and
it will not invent a licence, a version or a feature list.

What it refuses: a version that is not greater than the current one, a version whose zip already
exists, a missing or stub note, a dirty tree, a suite that is not green, a probe that fails, a
zip the packager will not write, and a release the GitHub API does not confirm.
"""

import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DESKTOP = pathlib.Path.home() / "Desktop" / "lil-bro-store-images"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# Set once the version is known, so a failure can clean up after the run.
VERSION = None


def refresh_handover(version, artifact, digest):
    """Re-derive the Desktop handover's own claims from the artifact just built.

    The README and the version table are the two files a person reads at upload time, and
    both had drifted: the delivery rewrote the file names in the README but left the last
    release's byte count and hash sitting beside the new one, and the table had not been
    copied across since 1.5.7. The numbers are mechanical, so they are re-derived here.
    Everything else in that file is prose, which is listed rather than guessed at.
    """
    import datetime

    if not DESKTOP.exists():
        return
    shutil.copy2(ROOT / "docs" / "VERSIONS.md", DESKTOP / "VERSIONS.md")
    readme = DESKTOP / "README.txt"
    if not readme.exists():
        return
    text = readme.read_text(encoding="utf-8")
    size = artifact.stat().st_size
    text = re.sub(r"\(\d[\d,]* bytes, sha256 [0-9a-f]{16,}\)", f"({size} bytes, sha256 {digest})", text)
    today = datetime.date.today()
    text = re.sub(
        r"Last sorted: \d+ [A-Z][a-z]+ \d{4}, \d+\.\d+\.\d+",
        f"Last sorted: {today.day} {today.strftime('%B')} {today.year}, {version}",
        text,
    )
    # One more number in that file is mechanical: the standing instructions are phrased
    # without a version at all, and this sentence carries one only as a fact of the span
    # built so far.
    text = re.sub(r"1\.0\.1 through \d+\.\d+\.\d+", f"1.0.1 through {version}", text)
    readme.write_bytes(text.encode("utf-8"))
    stale = sorted({m.group(0) for m in re.finditer(r"\b1\.\d+\.\d+\b", text) if m.group(0) != version})
    if stale:
        say(f"handover README also names {', '.join(stale)}: re-read those lines before uploading")


def say(message):
    print(f"  {message}", flush=True)


def die(message):
    """Stop, and leave nothing half-done behind.

    A release that fails after the version was bumped used to leave the manifest and the
    changelog modified, so the next run refused to start on a dirty tree and the version
    had been spent on nothing. Both go back to what they were, and a zip built by a run that
    failed goes with them, because one version number is one zip.
    """
    subprocess.run(
        ["git", "checkout", "--", "manifest.json", "CHANGELOG.md", "docs/VERSIONS.md"],
        cwd=ROOT,
        capture_output=True,
    )
    if VERSION:
        stray = ROOT / "builds" / f"lil-bro-wipe-{VERSION}.zip"
        if stray.exists():
            stray.unlink()
        for pattern in (f"builds/.probe-{VERSION}-*", f"builds/.sheets-{VERSION}-*"):
            for path in ROOT.glob(pattern):
                shutil.rmtree(path, ignore_errors=True)
    print(f"\n  stopped: {message}", file=sys.stderr)
    sys.exit(1)


def run(command, **kwargs):
    """Run a command, echo it, and hand back the finished process."""
    printable = " ".join(str(c) for c in command)
    say(f"$ {printable}")
    return subprocess.run(command, cwd=ROOT, text=True, capture_output=True, **kwargs)


def read(rel):
    return (ROOT / rel).read_bytes().decode("utf-8")


def write(rel, text):
    # Bytes, always: a text write on Windows puts CRLF into a shipped file and the packager
    # refuses the build for it.
    (ROOT / rel).write_bytes(text.encode("utf-8"))


def semver(value):
    return tuple(int(part) for part in value.split("."))


def git(*args, check=True):
    done = subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True)
    if check and done.returncode:
        die(f"git {' '.join(args)} failed: {done.stderr.strip()}")
    return done.stdout.strip()


def token():
    """The token git already uses to push. Never printed, never written anywhere."""
    done = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        text=True,
        capture_output=True,
        cwd=ROOT,
    )
    match = re.search(r"^password=(.+)$", done.stdout, re.M)
    if not match:
        die("no GitHub token in the credential store")
    return match.group(1).strip()


def github(method, path, payload=None, raw=None, content_type=None):
    url = path if path.startswith("http") else f"https://api.github.com{path}"
    data = raw if raw is not None else (json.dumps(payload).encode() if payload else None)
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", f"token {token()}")
    request.add_header("Accept", "application/vnd.github+json")
    if content_type:
        request.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(request) as response:
            body = response.read().decode()
            return json.loads(body) if body.strip().startswith(("{", "[")) else body
    except urllib.error.HTTPError as error:
        die(f"{method} {url} returned {error.code}: {error.read().decode()[:300]}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("version", help="the new version, for example 1.5.9")
    parser.add_argument("--probe", type=int, help="port for a real-browser probe before building")
    parser.add_argument("--dry-run", action="store_true", help="print the steps, save nothing")
    parser.add_argument("--no-push", action="store_true", help="stop before pushing and publishing")
    args = parser.parse_args()

    version = args.version
    global VERSION
    VERSION = version
    current = json.loads(read("manifest.json"))["version"]
    note_path = ROOT / f"builds/release-notes-{version}.md"
    zip_name = f"lil-bro-wipe-{version}.zip"

    # --- the gates, all of them before anything is written ---------------------
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        die(f"{version} is not a version number")
    if semver(version) <= semver(current):
        die(f"{version} is not newer than {current}, which is what the manifest says")
    if (ROOT / "builds" / zip_name).exists():
        die(f"builds/{zip_name} already exists: one version number is one zip, never reuse it")
    if not note_path.exists():
        die(f"no release note at builds/release-notes-{version}.md. Write it first: what changed,"
            " and why it matters to someone using it.")
    note = note_path.read_bytes().decode("utf-8").strip()
    if len(note) < 200:
        die("the release note is a stub. Say what changed in a sentence or two before releasing.")
    if git("status", "--porcelain"):
        die("the working tree has uncommitted changes. Commit the code first, so the release"
            " commit contains only the version, the table and the changelog.")
    if not (ROOT / "store-listing").is_dir():
        die("store-listing/ is missing, so the listing could not be checked or delivered")

    say(f"releasing {current} -> {version}")
    say(f"note: {len(note)} characters")

    if args.dry_run:
        for step in (
            f"bump manifest.json to {version}",
            "insert the note into CHANGELOG.md",
            "run every suite",
            "probe the real extension in a browser" if args.probe else "skip the probe (no --probe)",
            f"package builds/{zip_name}",
            "write the row into docs/VERSIONS.md",
            "commit and push",
            f"publish the GitHub release {version} with the zip attached",
            f"deliver to {DESKTOP}",
        ):
            say(f"would {step}")
        return

    # --- 1. the version, then the prose ---------------------------------------
    write("manifest.json", re.sub(r'("version":\s*)"[^"]+"', rf'\g<1>"{version}"', read("manifest.json")))
    changelog = read("CHANGELOG.md")
    if f"## {version}" in changelog:
        die(f"CHANGELOG.md already has a section for {version}")
    head, rest = changelog.split("\n## ", 1)
    body = note if note.startswith("## ") else f"## {version}\n\n{note}\n"
    write("CHANGELOG.md", f"{head}\n{body.rstrip()}\n\n## {rest}")
    say("manifest and changelog updated")

    # --- 2. the suites, before anything is built ------------------------------
    # Every suite except the release agreement, which cannot pass until the table row exists
    # and that row needs the hash of a zip that does not exist yet. The list comes out of
    # package.json, so this can never disagree with what CI runs.
    chain = json.loads(read("package.json"))["scripts"]["test"]
    suites = re.findall(r"node (tests/[\w.-]+\.mjs)", chain)
    if not suites:
        die("package.json has no suite list to run")
    for suite in [s for s in suites if "release" not in s]:
        done = run(["node", suite])
        if done.returncode:
            print(done.stdout[-3000:], done.stderr[-2000:])
            die(f"{suite} is not green, so nothing was built")
    say(f"{len(suites) - 1} suites passed")

    # --- 3. the real browser, when asked --------------------------------------
    # Twice, because the harness occasionally reads the service worker's manifest before its
    # context is ready and gets an Uncaught for it. A flaky browser is not a broken extension,
    # and a real failure fails twice.
    def probe(lang, out):
        return run([
            "node", "tools/live_probe.mjs", str(args.probe), "",
            str(out).replace("\\", "/"), lang,
        ])

    sheets = None
    if args.probe:
        sheets = {}
        for lang in ("en", "pl"):
            out = ROOT / f"builds/.probe-{version}-{lang}"
            shutil.rmtree(out, ignore_errors=True)
            out.mkdir(parents=True)
            for attempt in (1, 2):
                done = probe(lang, out)
                if done.returncode == 0 and "checks passed" in done.stdout:
                    for line in done.stdout.strip().splitlines()[-3:]:
                        say(line.strip()[:110])
                    break
                say(f"{lang} probe attempt {attempt} failed, retrying" if attempt == 1 else "")
            else:
                print(done.stdout[-2500:], done.stderr[-1500:])
                die(f"the {lang} probe failed twice, so nothing was built")
            sheet_dir = ROOT / f"builds/.sheets-{version}-{lang}"
            shutil.rmtree(sheet_dir, ignore_errors=True)
            sheet_dir.mkdir(parents=True)
            done = run([sys.executable, "tools/make_shot_sheets.py",
                        str(out).replace("\\", "/"), str(sheet_dir).replace("\\", "/")])
            if done.returncode:
                print(done.stdout[-2000:], done.stderr[-1500:])
                die(f"the {lang} screenshot sheets failed")
            sheets[lang] = sheet_dir

    # --- 4. the artifact ------------------------------------------------------
    # sys.executable, not "python": under subprocess the name resolves through PATH to whatever
    # interpreter Windows finds first, which on this machine is one without PIL, while the
    # composer needs it. Running these under the interpreter that is running this script means
    # the two agree on what is installed.
    done = run([sys.executable, "tools/package.py", f"builds/{zip_name}"])
    print(done.stdout.strip())
    if done.returncode:
        die("the packager refused, so there is no zip to release")
    artifact = ROOT / "builds" / zip_name
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    git("add", "-A")
    git("commit", "-q", "-m", version)
    build_commit = git("rev-parse", "--short", "HEAD")
    say(f"built {zip_name}, {artifact.stat().st_size} bytes, sha256 {digest[:16]}, commit {build_commit}")

    # --- 5. the table ---------------------------------------------------------
    today = __import__("datetime").datetime.now()
    stamp = f"{today.day} {MONTHS[today.month - 1]}"
    summary = next((l for l in note.splitlines() if l.strip() and not l.startswith("#")), "")[:180]
    row = f"| {version} | {stamp} | `{build_commit}` | `{digest[:16]}` | {summary} |\n"
    versions = read("docs/VERSIONS.md")
    if f"| {version} |" in versions:
        die(f"docs/VERSIONS.md already has a row for {version}")
    lines = versions.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if re.match(r"^\|\s*\d+\.\d+\.\d+\s*\|", line):
            lines.insert(index, row)
            break
    else:
        die("could not find the version table in docs/VERSIONS.md")
    versions = "".join(lines)
    versions = re.sub(
        r"The current code is numbered \d+\.\d+\.\d+\.",
        f"The current code is numbered {version}.",
        versions,
    )
    write("docs/VERSIONS.md", versions)
    say("table row written, with the hash of the zip that was actually built")

    # --- 5b. the agreement, now that there is something to agree with ---------
    for suite in [s for s in suites if "release" in s]:
        done = run(["node", suite])
        if done.returncode:
            print(done.stdout[-3000:], done.stderr[-2000:])
            die(f"{suite} is not green: the manifest, the zip, the table, the changelog and the"
                " tag do not agree. Nothing has been pushed or published.")
    say("the release agrees with itself")

    git("add", "-A")
    git("commit", "-q", "-m", f"the row for {version}")
    say(f"row committed at {git('rev-parse', '--short', 'HEAD')}")

    if args.no_push:
        say("--no-push: stopping here, with the release built and documented locally")
        return

    # --- 6. publish -----------------------------------------------------------
    git("push", "-q", "origin", "main")
    say(f"pushed, head {git('rev-parse', '--short', 'HEAD')}")
    release = github(
        "POST",
        "/repos/Forsigh/lil-bro-history-wipe/releases",
        {"tag_name": version, "name": version, "target_commitish": "main", "body": note},
    )
    if "id" not in release:
        die(f"the release was not created: {str(release)[:300]}")
    github(
        "POST",
        f"https://uploads.github.com/repos/Forsigh/lil-bro-history-wipe/releases/{release['id']}"
        f"/assets?name={zip_name}",
        raw=artifact.read_bytes(),
        content_type="application/zip",
    )
    back = github("GET", f"/repos/Forsigh/lil-bro-history-wipe/releases/tags/{version}")
    assets = back.get("assets") or []
    if not assets or assets[0]["size"] != artifact.stat().st_size:
        die(f"the release read back without the zip attached: {str(assets)[:200]}")
    say(f"release {version} published with {assets[0]['name']} ({assets[0]['size']} bytes)")

    # --- 7. deliver -----------------------------------------------------------
    (DESKTOP / "builds").mkdir(parents=True, exist_ok=True)
    shutil.copy2(artifact, DESKTOP / "builds" / zip_name)
    unpacked = DESKTOP / "builds" / f"load-unpacked-{version}"
    # Built off to one side and moved into place in one step. A browser can be pointed at
    # that folder, and a folder that is unpacked in place appears file by file: one loaded
    # in the middle reads a manifest that is not there yet and comes up broken, which is
    # what happened here. A rename cannot be caught half done.
    staging = unpacked.with_name(unpacked.name + ".part")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    shutil.unpack_archive(str(artifact), str(staging))
    # An archive that unpacks to nothing leaves an empty folder that still looks loadable,
    # and two of those were left here by an earlier release. The copy is checked against
    # the zip it came from and removed rather than left behind when it does not match.
    wanted = [n for n in zipfile.ZipFile(artifact).namelist() if not n.endswith("/")]
    got = [p for p in staging.rglob("*") if p.is_file()]
    if len(got) != len(wanted) or not (staging / "manifest.json").exists():
        shutil.rmtree(staging, ignore_errors=True)
        die(f"the unpacked copy came out incomplete: {len(got)} of {len(wanted)} files")
    shutil.rmtree(unpacked, ignore_errors=True)
    staging.rename(unpacked)
    upload = DESKTOP / f"UPLOAD-{version}"
    shutil.rmtree(upload, ignore_errors=True)
    (upload / "all-languages").mkdir(parents=True)
    (upload / "pl").mkdir(parents=True)
    shots_en = sheets["en"] if sheets else DESKTOP / "screenshots" / "en"
    shots_pl = sheets["pl"] if sheets else DESKTOP / "screenshots" / "pl"
    if not sheets:
        say("no probe ran, so the screenshots on the Desktop were reused as they are")
    for name in sorted(p.name for p in pathlib.Path(shots_en).glob("*.png")):
        shutil.copy2(pathlib.Path(shots_en) / name, upload / "all-languages" / name)
        shutil.copy2(pathlib.Path(shots_en) / name, DESKTOP / "screenshots" / "en" / name)
    for name in sorted(p.name for p in pathlib.Path(shots_pl).glob("*.png")):
        shutil.copy2(pathlib.Path(shots_pl) / name, upload / "pl" / name)
        shutil.copy2(pathlib.Path(shots_pl) / name, DESKTOP / "screenshots" / "pl" / name)
    for lang, dest in (("en", upload / "all-languages"), ("pl", upload / "pl")):
        marquee = DESKTOP / "graphics" / lang / "marquee-1400x560.png"
        promo = DESKTOP / "graphics" / lang / "promo-440x280.png"
        if marquee.exists():
            shutil.copy2(marquee, dest / "marquee-1400x560.png")
        if promo.exists() and lang == "en":
            shutil.copy2(promo, dest / "small-promo-440x280.png")
        src_promo = DESKTOP / "graphics" / lang / "promo-440x280.png"
        if src_promo.exists() and lang == "pl":
            shutil.copy2(src_promo, dest / "small-promo-440x280.png")
    listing_dst = DESKTOP / "store-listing"
    shutil.rmtree(listing_dst, ignore_errors=True)
    shutil.copytree(ROOT / "store-listing", listing_dst)
    # The three identical dashboard-fields copies the Desktop folder used to carry are gone:
    # one file per thing, and this script copies the set that the suite checked.
    for stale in ("en/dashboard-fields.md", "all-languages/dashboard-fields.md", "pl/dashboard-fields.md"):
        (listing_dst / stale).unlink(missing_ok=True)
    readme = DESKTOP / "README.txt"
    if readme.exists():
        text = readme.read_text(encoding="utf-8")
        text = re.sub(r"lil-bro-wipe-1\.\d+\.\d+\.zip", zip_name, text)
        text = re.sub(r"load-unpacked-1\.\d+\.\d+", f"load-unpacked-{version}", text)
        text = re.sub(r"UPLOAD-1\.\d+\.\d+", f"UPLOAD-{version}", text)
        readme.write_bytes(text.encode("utf-8"))
    # The table and the README's numbers are re-derived from the artifact just built
    # rather than assumed to be current: that is the pair that went stale here.
    refresh_handover(version, artifact, digest)
    say(f"delivered to {DESKTOP}")

    print()
    say(f"{version} is out.")
    say(f"zip      builds/{zip_name}, {artifact.stat().st_size} bytes")
    say(f"sha256   {digest}")
    say(f"release  https://github.com/Forsigh/lil-bro-history-wipe/releases/tag/{version}")
    say(f"upload   {upload}")


if __name__ == "__main__":
    main()
