#!/bin/sh
# Build the local experimental AWR environment used to develop this plugin.
#
#   scripts/build-awr-lab.sh <awr-source-checkout> [target-dir]
#
# The checkout is built as it is: whatever branch is checked out, including commits
# that are not on main. Uncommitted changes are built too, and the manifest says so.
# The result goes to .local/awr-lab/ (ignored by git); nothing on PATH is touched.
set -eu

SRC=${1:?usage: build-awr-lab.sh <awr-source-checkout> [cargo-target-dir]}
HERE=$(cd "$(dirname "$0")/.." && pwd -P)
LAB="$HERE/.local/awr-lab"
TARGET=${2:-"$HERE/.local/awr-lab-target"}

SRC=$(cd "$SRC" && pwd -P)
[ -f "$SRC/Cargo.toml" ] && [ -d "$SRC/crates/awr-cli" ] || {
  echo "not an AWR source checkout: $SRC" >&2
  exit 1
}

echo "building awr and awr-mcp from $SRC"
(cd "$SRC" && CARGO_TARGET_DIR="$TARGET" cargo build --release --locked -p awr-cli -p awr-mcp)

mkdir -p "$LAB/bin"
cp "$TARGET/release/awr" "$TARGET/release/awr-mcp" "$LAB/bin/"
chmod +x "$LAB/bin/awr" "$LAB/bin/awr-mcp"

python3 - "$SRC" "$LAB" <<'PY'
import hashlib, json, subprocess, sys, time

src, lab = sys.argv[1], sys.argv[2]


def run(*args):
    return subprocess.run(args, capture_output=True, text=True).stdout.strip()


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


git = lambda *a: run("git", "-C", src, *a)
dirty = [line for line in git("status", "--porcelain", "--untracked-files=no").splitlines() if line]
manifest = {
    "purpose": "Local experimental AWR environment for DSH plugin development. Not a release.",
    "built_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "source_path": src,
    "source_branch": git("branch", "--show-current"),
    "source_commit": git("rev-parse", "HEAD"),
    "origin_main_commit": git("rev-parse", "origin/main"),
    "commits_not_on_origin_main": git("rev-list", "--count", "origin/main..HEAD"),
    "uncommitted_tracked_changes": dirty,
    "build_command": "cargo build --release --locked -p awr-cli -p awr-mcp",
    "rustc": run("rustc", "--version"),
    "binaries": {n: {"sha256": sha256(f"{lab}/bin/{n}"), "version": run(f"{lab}/bin/{n}", "--version")} for n in ("awr", "awr-mcp")},
}
with open(f"{lab}/build.json", "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print(json.dumps(manifest, indent=2))
PY

echo "lab environment: $LAB/bin"
