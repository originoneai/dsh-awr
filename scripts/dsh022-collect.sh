#!/bin/sh
# Collect what a takeover left in a project, for review against its README and history (DSH-022).
#
#   scripts/dsh022-collect.sh <project-directory> <output-directory>
#
# Copies the receipt and the intake files into <output-directory>, writes review-sheet.md with the goals and
# work items the takeover made next to the project's recent history and the head of its README, and changes
# nothing in the project. Fill the sheet in by hand: each goal and work item is traced to a README line or a
# commit, or recorded as invented or wrong.
set -eu

PROJECT=$(cd "${1:?usage: dsh022-collect.sh <project-directory> <output-directory>}" && pwd -P)
OUT=${2:?usage: dsh022-collect.sh <project-directory> <output-directory>}
mkdir -p "$OUT"
for file in .awr/takeover/receipt.json .awr/project.toml .awr/intake/work-ledger.yaml .awr/intake/GOALS.md .awr/intake/inventory.json; do
  if [ -f "$PROJECT/$file" ]; then
    mkdir -p "$OUT/$(dirname "$file")"
    cp "$PROJECT/$file" "$OUT/$file"
  fi
done

python3 - "$PROJECT" "$OUT" <<'PY'
import json, os, subprocess, sys

project, out = sys.argv[1], sys.argv[2]
read = lambda path: open(os.path.join(project, path), encoding="utf-8", errors="replace").read() if os.path.exists(os.path.join(project, path)) else ""
git = lambda *a: subprocess.run(["git", "-C", project, *a], capture_output=True, text=True).stdout.strip()

receipt = {}
try:
    receipt = json.loads(read(".awr/takeover/receipt.json"))
except ValueError:
    pass
lines = [f"# Takeover review sheet: {os.path.basename(project)}", ""]
lines += [f"- Result: `{receipt.get('result', 'no receipt')}`", f"- Run: `{receipt.get('run', '')}`", f"- Commits in the project: {git('rev-list', '--count', 'HEAD')}", ""]
lines += ["## Goals and work items the takeover made", "", "Trace each one to a README line or a commit, or mark it invented or wrong.", "",
          "| Item | Kind | Traced to (README line / commit) | Verdict (supported / invented / wrong) |", "| --- | --- | --- | --- |"]
for path in (".awr/intake/GOALS.md", ".awr/intake/work-ledger.yaml"):
    for raw in read(path).splitlines():
        text = raw.strip()
        if text.startswith("#") or text.startswith("- id:") or text.startswith("title:") or text.startswith("- title:"):
            lines.append(f"| `{text[:110]}` | {path.split('/')[-1]} | | |")
lines += ["", "## Recent history", "", "```", git("log", "--oneline", "-30"), "```", "", "## README, first 60 lines", "", "```", "\n".join(read("README.md").splitlines()[:60]), "```", ""]
with open(os.path.join(out, "review-sheet.md"), "w") as f:
    f.write("\n".join(lines))
print(f"wrote {os.path.join(out, 'review-sheet.md')}")
PY
