#!/usr/bin/env python3
"""PostToolUse hook: append one line per action to .claude/audit.jsonl (shipped to the SIEM in production)."""
import json
import os
import sys
import time
from pathlib import Path

event = json.load(sys.stdin)
tool_input = event.get("tool_input", {})
record = {
    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "session": event.get("session_id"),
    "tool": event.get("tool_name"),
    "target": tool_input.get("file_path") or tool_input.get("command") or tool_input.get("pattern"),
}
log = Path(os.environ.get("CLAUDE_PROJECT_DIR", ".")) / ".claude" / "audit.jsonl"
with log.open("a") as f:
    f.write(json.dumps(record) + "\n")
