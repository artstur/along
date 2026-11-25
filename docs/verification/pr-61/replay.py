"""Replay the asset, documentation and test-helper checks for Along PR #61."""

from io import BytesIO
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from zipfile import ZipFile


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
BEFORE = "c90569368330eb3a5394e7116d6e63cea491d269"
AFTER = "c29928e21178ee0c6b80e8fc2482aa26071ec7af"
IOS_WEB = "ios/AlongHealth/Web"


def export(commit, directory):
    archive = subprocess.check_output(["git", "archive", "--format=zip", commit], cwd=REPO)
    with ZipFile(BytesIO(archive)) as snapshot:
        snapshot.extractall(directory)


def assets(directory):
    return {file.name: file.read_bytes() for file in directory.iterdir() if file.is_file()}


def compare_assets(directory, expected):
    actual = assets(directory)
    for name in sorted(expected.keys() | actual.keys()):
        if expected.get(name) != actual.get(name):
            raise ValueError(f"Asset differs or is missing: {directory / name}")


def check_links(root):
    for doc, link in [("README.md", "AGENTS.md"), ("docs/code-quality-goal.md", "../AGENTS.md")]:
        page = root / doc
        target = (page.parent / link).resolve()
        if f"]({link})" not in page.read_text(encoding="utf-8") or target != root / "AGENTS.md":
            raise ValueError(f"Unexpected project guidance link in {doc}")
        if "## 2. 一份源码，两份产物" not in target.read_text(encoding="utf-8"):
            raise ValueError(f"Build instructions missing for {doc}")


def main():
    with TemporaryDirectory(prefix="along-pr61-") as temp:
        before, after = (Path(temp).resolve() / name for name in ("before", "after"))
        export(BEFORE, before)
        export(AFTER, after)
        subprocess.run(["node", str(HERE / "compare-helpers.mjs"), str(before), str(after)], check=True)
        expected = assets(before / "web")
        if len(expected) != 22:
            raise ValueError(f"Expected 22 baseline assets, found {len(expected)}")
        for directory in (before / IOS_WEB, after / "web", after / IOS_WEB):
            compare_assets(directory, expected)
        subprocess.run(["node", "tools/build.mjs"], cwd=after, check=True)
        for directory in (after / "dist", after / IOS_WEB):
            compare_assets(directory, expected)
        check_links(after)
        print("PASS: 22 baseline assets match tracked and rebuilt files. Both guidance links resolve.")


if __name__ == "__main__":
    main()
