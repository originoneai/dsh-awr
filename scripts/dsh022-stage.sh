#!/bin/sh
# Stage fresh clones of public projects for the DSH-022 takeover run and preview what `awr init` makes of each.
#
#   scripts/dsh022-stage.sh <destination-directory>
#
# Nothing is initialized: the preview writes nothing. The projects are public, so what the reviewer reads
# (and so what reaches the model provider) is public. The awr used is the lab build (docs/lab-environment.md),
# else the one on PATH.
set -eu

DEST=${1:?usage: dsh022-stage.sh <destination-directory>}
HERE=$(cd "$(dirname "$0")/.." && pwd -P)
AWR="$HERE/.local/awr-lab/bin/awr"
[ -x "$AWR" ] || AWR=$(command -v awr)
STATE=$(mktemp -d "${TMPDIR:-/tmp}/dsh022-awr-state.XXXXXX")
trap 'rm -rf "$STATE"' EXIT

mkdir -p "$DEST"
for repo in modelcontextprotocol/experimental-ext-grouping wshobson/agents apache/doris-mcp-server; do
  name=${repo#*/}
  if [ ! -d "$DEST/$name/.git" ]; then
    git clone -q "https://github.com/$repo.git" "$DEST/$name"
  fi
  commits=$(git -C "$DEST/$name" rev-list --count HEAD)
  printf '%s: %s commits, ' "$name" "$commits"
  if [ -d "$DEST/$name/.awr" ]; then
    echo "already has .awr (not a fresh clone)"
    continue
  fi
  if AWR_LOCAL_HOME="$STATE" AWR_LOCAL_WEB=0 "$AWR" --project "$DEST/$name" --json init > "$STATE/init.out" 2> "$STATE/init.err"; then
    echo "awr init preview ok"
  else
    printf 'awr init preview stops: '
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); l=(d.get("details") or {}).get("location") or {}; print(d.get("code"), (d.get("details") or {}).get("category"), "at line", l.get("line"))' "$STATE/init.err" 2>/dev/null || head -c 200 "$STATE/init.err"
  fi
done
