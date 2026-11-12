#!/bin/sh
# Diagnostic wrapper for DSH-001: logs the wire traffic and applies mcp-shim.py.
R=/Users/mac/Documents/deepseek-harness/dsh001-fixture/receipts
echo "--- spawn $(date -u +%FT%TZ) pid=$$" >> "$R/mcp-wire.log"
/usr/bin/tee -a "$R/mcp-in.log" | /opt/homebrew/bin/awr-mcp --project /Users/mac/Documents/deepseek-harness/dsh001-fixture 2>> "$R/mcp-stderr.log" | /usr/bin/tee -a "$R/mcp-out.log" | /usr/bin/python3 "$R/mcp-shim.py"
