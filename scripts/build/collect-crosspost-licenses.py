"""Copy license texts for the Python environment used to freeze Publisher."""

import json
import re
import shutil
import sys
from importlib.metadata import distributions
from pathlib import Path


def safe(value):
    return re.sub(r"[^A-Za-z0-9_.-]", "-", value)


def collect(destination):
    destination.mkdir(parents=True, exist_ok=True)
    entries = []
    for dist in sorted(distributions(), key=lambda item: item.metadata["Name"].lower()):
        name = dist.metadata["Name"]
        if name.lower() in {"pip", "setuptools", "wheel"}:
            continue
        version = dist.version
        folder = safe(f"{name}-{version}")
        files = []
        for member in dist.files or []:
            source = dist.locate_file(member)
            basename = Path(str(member)).name
            if not re.match(r"^(LICENSE|COPYING|NOTICE)(?:[._-]|$)", basename, re.I):
                continue
            if not source.is_file() or source.is_symlink():
                continue
            target = destination / folder / basename
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            files.append(f"{folder}/{basename}")
        if not files:
            raise RuntimeError(f"No license text found for bundled Python dependency {name} {version}")
        entries.append({
            "name": name,
            "version": version,
            "license": dist.metadata.get("License-Expression") or dist.metadata.get("License") or "See copied license text",
            "files": sorted(set(files)),
        })
    (destination / "manifest.json").write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    collect(Path(sys.argv[1]))
