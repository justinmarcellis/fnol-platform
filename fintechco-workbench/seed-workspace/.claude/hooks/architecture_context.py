#!/usr/bin/env python3
"""SessionStart hook: every session starts with FinTechCo's architecture patterns in context."""
import json

print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": (
    "FinTechCo's Architecture Patterns skill applies to this repository "
    "(.claude/skills/architecture-patterns/SKILL.md). Changes that move money, store data or log "
    "events follow those patterns, and review notes say which patterns were applied."
)}}))
