#!/usr/bin/env python3
"""PreToolUse hook (Edit|Write): refuse any change that would put a card number or a secret into the code.

Runs before every file edit. Claude Code sends the proposed change as JSON on stdin; printing a
"deny" decision stops the edit and tells Claude why, so it can fix its approach.
"""
import json
import re
import sys

CARD = re.compile(r"(?<![\dX])(?:\d[ -]?){12,18}\d(?!\d)")
SECRETS = {
    "a live payments key": re.compile(r"\b(?:pk|sk)[-_](?:live|fintechco)[-_][A-Za-z0-9_-]{6,}"),
    "a cloud access key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "a private key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
}


def proposed_text(tool_input: dict) -> str:
    edits = tool_input.get("edits") or []
    parts = [tool_input.get("new_string", ""), tool_input.get("content", "")]
    parts += [e.get("new_string", "") for e in edits]
    return "\n".join(p for p in parts if p)


def main() -> None:
    event = json.load(sys.stdin)
    text = proposed_text(event.get("tool_input", {}))
    path = event.get("tool_input", {}).get("file_path", "a file")
    reason = None
    if CARD.search(text):
        reason = f"Blocked by FinTechCo policy: the change to {path} contains a full card number. Use a masked value such as XXXX-XXXX-XXXX-1111."
    for label, pattern in SECRETS.items():
        if reason is None and pattern.search(text):
            reason = f"Blocked by FinTechCo policy: the change to {path} contains {label}. Read secrets from Secret Manager instead."
    if reason:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}))


if __name__ == "__main__":
    main()
