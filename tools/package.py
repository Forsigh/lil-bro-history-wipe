"""Build the Chrome Web Store package for the current manifest version.

    python tools/package.py

Reads the version straight out of manifest.json, zips the explicit file list the
store needs (manifest at the root), and then verifies the result against the
working tree: every entry has to be byte-identical to the file on disk, and
nothing from store/ or docs/ may sneak in.
"""

import hashlib
import json
import pathlib
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Everything the extension needs to run, and nothing else.
FILES = [
    "manifest.json",
    "src/service-worker.js",
    "src/matcher.js",
    "src/store.js",
    "src/confirm-gate.js",
    "src/lock.js",
    "src/i18n.js",
    "src/options.html",
    "src/options.js",
    "src/popup.html",
    "src/popup.js",
    "src/styles.css",
    "_locales/en/messages.json",
    "_locales/pl/messages.json",
    "src/icons/icon16.png",
    "src/icons/icon32.png",
    "src/icons/icon48.png",
    "src/icons/icon128.png",
]

TEXT_SUFFIXES = {".json", ".js", ".html", ".css", ".md"}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    out = ROOT / "builds" / f"lil-bro-wipe-{version}.zip"
    out.parent.mkdir(exist_ok=True)

    crlf = []
    for name in FILES:
        path = ROOT / name
        if not path.is_file():
            print(f"MISSING {name}")
            return 1
        if path.suffix in TEXT_SUFFIXES and b"\r\n" in path.read_bytes():
            crlf.append(name)
    if crlf:
        print("CRLF line endings found (the package must be LF):")
        for name in crlf:
            print("  ", name)
        return 1

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in FILES:
            zf.write(ROOT / name, arcname=name)

    with zipfile.ZipFile(out) as zf:
        names = zf.namelist()
        if names != FILES:
            print("unexpected zip contents:")
            for name in names:
                print("  ", name)
            return 1
        stray = [n for n in names if n.startswith(("store/", "docs/"))]
        if stray:
            print("store/docs content leaked into the package:", stray)
            return 1
        mismatched = []
        for name in names:
            if sha256(zf.read(name)) != sha256((ROOT / name).read_bytes()):
                mismatched.append(name)
    if mismatched:
        print("zip does not match the working tree:", mismatched)
        return 1

    data = out.read_bytes()
    print(f"{out.name}  {len(data):,} bytes  {len(names)} files  v{version}")
    print("sha256", sha256(data))
    print("every entry matches the working tree; no CRLF; nothing from store/ or docs/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
