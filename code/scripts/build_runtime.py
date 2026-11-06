"""Build a locked Runtime source distribution without editor, data or secrets."""

import argparse
import hashlib
import json
import zipfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="dist/fastflow-runtime-r0.zip")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    payload = {}
    for path in (root / "backend").rglob("*"):
        if (
            path.suffix in (".py", ".html")
            and "__pycache__" not in path.parts
            and path.name
            not in (
                "workflow_assistant.py",
                "m11.py",
                "main.py",
            )
        ):
            payload[path.relative_to(root).as_posix()] = path.read_bytes()
    for name in (
        "pyproject.toml",
        "uv.lock",
        "start-runtime.ps1",
        "THIRD_PARTY_NOTICES.md",
    ):
        payload[name] = (root / name).read_bytes()
    quickstart = root / "docs" / "RUNTIME_QUICKSTART.md"
    if quickstart.is_file():
        payload[quickstart.relative_to(root).as_posix()] = quickstart.read_bytes()
    for path in (root / "skills").rglob("SKILL.md"):
        payload[path.relative_to(root).as_posix()] = path.read_bytes()
    payload["runtime-distribution.json"] = json.dumps(
        {
            "profile": "fastflow-local-r0-v1",
            "format": "locked-python-source",
            "entrypoint": "python -m backend.headless",
            "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(payload.items())},
        },
        indent=2,
    ).encode()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in sorted(payload.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content)
    print(f"Runtime distribution: {output.resolve()} ({output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
