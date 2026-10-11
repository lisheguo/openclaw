"""Download only the locked public source files; never install or modify Core."""
import concurrent.futures
import hashlib
import json
import pathlib
import sys
import urllib.request

lock = json.loads(pathlib.Path(__file__).with_name("source-lock.json").read_text())
assert lock["commit"] == "bcfc88812a35243893585dbeca87ca41b48272ca"
if len(sys.argv) != 2:
    raise SystemExit("Usage: python3 test/integration/fetch-source.py /tmp/glpi-openclaw-source")
destination = pathlib.Path(sys.argv[1]).resolve()
repository = pathlib.Path(__file__).resolve().parents[2]
if destination == repository or repository in destination.parents:
    raise SystemExit("Choose a disposable directory outside this repository")


def fetch(item):
    name, expected = item
    relative = pathlib.PurePosixPath(name)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("Invalid locked path")
    target = destination / name
    if target.exists():
        if hashlib.sha256(target.read_bytes()).hexdigest() != expected:
            raise ValueError(f"Existing source differs; refusing overwrite: {name}")
        return
    url = f"https://raw.githubusercontent.com/openclaw/openclaw/{lock['commit']}/{name}"
    with urllib.request.urlopen(url, timeout=30) as response:
        content = response.read()
    if hashlib.sha256(content).hexdigest() != expected:
        raise ValueError(f"Source hash mismatch: {name}")
    target.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation protects a concurrently created or changed file.
    with target.open("xb") as output:
        output.write(content)


with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
    list(executor.map(fetch, lock["files"].items()))
print(f"Verified {len(lock['files'])} public source files at {lock['commit']}")
