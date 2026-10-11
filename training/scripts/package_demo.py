"""Package the browser app into the zip a recipient unzips and double-clicks.

Run from the project root, after scripts/export_web_app.py:

    python -B scripts/package_demo.py [--src PropertyPriceEstimator] [--out dist/PropertyPriceEstimator.zip]

The zip holds exactly the files in EXPECTED, under one top-level folder. Anything else in the source
folder is a mistake and stops the build (tool state folders such as .omc and __pycache__ are skipped
and reported). The zip is deterministic: fixed timestamps, sorted order, deflate level 9, so the same
inputs give the same bytes. After writing, the zip is reopened and every entry's CRC is checked.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
import zipfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
TOP = "PropertyPriceEstimator"
SKIPPED_DIRS = {".omc", "__pycache__", ".git"}
EXPECTED = [
    "README.txt", "index.html",
    "assets/app.js", "assets/charts.js", "assets/explore.js", "assets/model.js", "assets/style.css",
    "data/forest.js", "data/lookup.js", "data/perf.js",
    "vendor/PLOTLY-LICENSE.txt", "vendor/plotly-cartesian.min.js",
]
BUDGET_BYTES = 45_000_000      # the plan's "about 45 MB"; beyond it, stop and ask before using the lite model
STAMP = (1980, 1, 1, 0, 0, 0)  # the earliest timestamp zip can store, so output does not depend on the clock


def collect(src: Path) -> list[str]:
    found, skipped = [], []
    for p in sorted(src.rglob("*")):
        rel = p.relative_to(src)
        if any(part in SKIPPED_DIRS for part in rel.parts):
            if p.is_file():
                skipped.append(rel.as_posix())
            continue
        if p.is_file():
            found.append(rel.as_posix())
    if skipped:
        print(f"skipped {len(skipped)} tool-state file(s): {', '.join(skipped[:3])}{' ...' if len(skipped) > 3 else ''}")
    missing = [f for f in EXPECTED if f not in found]
    extra = [f for f in found if f not in EXPECTED]
    if missing or extra:
        sys.exit(f"source folder does not match the file list.\n  missing: {missing}\n  unexpected: {extra}")
    return found


def preflight(src: Path) -> int:
    """Checks that would otherwise only show up on a recipient's machine."""
    for rel in ["index.html"] + [f for f in EXPECTED if f.startswith("assets/")]:
        text = (src / rel).read_text(encoding="utf-8")
        if re.search(r"https?://", text):
            sys.exit(f"{rel} contains a URL; the app must make no network calls")
    trees = []
    for rel in ("data/forest.js", "data/lookup.js"):
        # forest.js is 77 MB with n_trees first, so read only its start; lookup.js is small and has it later.
        with open(src / rel, encoding="ascii") as f:
            text = f.read(400) if rel == "data/forest.js" else f.read()
        m = re.search(r'"n_trees":(\d+)', text)
        if not m:
            sys.exit(f"{rel}: no n_trees found; run scripts/export_web_app.py")
        trees.append(int(m.group(1)))
    if trees[0] != trees[1]:
        sys.exit(f"forest.js has {trees[0]} trees but lookup.js says {trees[1]}; re-export")
    return trees[0]


def build(src: Path, out: Path) -> None:
    files = collect(src)
    trees = preflight(src)
    order = ["README.txt", "index.html"] + [f for f in sorted(files) if f not in ("README.txt", "index.html")]
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in order:
            info = zipfile.ZipInfo(f"{TOP}/{rel}", date_time=STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, (src / rel).read_bytes(), compresslevel=9)

    with zipfile.ZipFile(out) as z:
        bad = z.testzip()
        if bad:
            sys.exit(f"CRC check failed for {bad}")
        entries = z.infolist()
    raw = sum(e.file_size for e in entries)
    size = out.stat().st_size
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    print(f"{out}")
    print(f"  {len(entries)} files, {trees} trees; uncompressed {raw / 1e6:.1f} MB; zipped {size / 1e6:.1f} MB ({size:,} bytes)")
    print(f"  sha256 {digest}")
    for e in sorted(entries, key=lambda e: -e.compress_size)[:3]:
        print(f"  {e.filename:46s} {e.file_size / 1e6:8.2f} MB -> {e.compress_size / 1e6:6.2f} MB")
    if size > BUDGET_BYTES:
        sys.exit(f"over the {BUDGET_BYTES / 1e6:.0f} MB budget: tell the user before switching to the lite model")
    print(f"  within the {BUDGET_BYTES / 1e6:.0f} MB budget")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, default=PROJECT / TOP)
    ap.add_argument("--out", type=Path, default=PROJECT / "dist" / f"{TOP}.zip")
    args = ap.parse_args()
    build(args.src, args.out)


if __name__ == "__main__":
    main()
