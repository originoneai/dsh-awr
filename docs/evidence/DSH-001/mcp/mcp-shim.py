#!/usr/bin/python3
"""DSH-001 diagnostic shim. Adds the two fields DSH's MCP SDK requires on a
tools/list result (ttlMs, cacheScope) when awr-mcp omits them. Not a fix."""
import json, sys
for line in sys.stdin:
    out = line
    try:
        msg = json.loads(line)
        res = msg.get("result")
        if isinstance(res, dict) and "tools" in res and "ttlMs" not in res:
            res["ttlMs"] = 0
            res["cacheScope"] = "private"
            out = json.dumps(msg, separators=(",", ":")) + "\n"
    except Exception:
        pass
    sys.stdout.write(out)
    sys.stdout.flush()
