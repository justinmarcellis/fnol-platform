#!/usr/bin/env python3
"""Stop hook: Claude may not report a task as done until the checks for the code it changed pass.

A test file is "affected" when a module it imports was modified after the test file itself.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

root = Path(os.environ.get("CLAUDE_PROJECT_DIR", "."))


def affected_tests() -> list[str]:
    out = []
    for test in sorted(root.glob("test_*.py")):
        imports = set(re.findall(r"^(?:from|import)\s+(\w+)", test.read_text(), re.M))
        for mod in imports:
            src = root / f"{mod}.py"
            if src.exists() and src.stat().st_mtime > test.stat().st_mtime + 1:
                out.append(test.name)
                break
    return out


def main() -> None:
    event = json.load(sys.stdin)
    tests = affected_tests()
    if not tests:
        return
    run = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", *tests],
                         cwd=root, capture_output=True, text=True, timeout=120)
    summary = (run.stdout.strip().splitlines() or ["no output"])[-1]
    if run.returncode != 0 and not event.get("stop_hook_active"):
        print(json.dumps({"decision": "block", "reason": f"Not done yet: the checks for the code you changed fail ({summary}). Fix them before finishing."}))
    else:
        passed = summary.split(" in ")[0]
        print(json.dumps({"systemMessage": f"checks for the changed code pass ({passed}, {', '.join(tests)})"}))


if __name__ == "__main__":
    main()
