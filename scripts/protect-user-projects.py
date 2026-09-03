#!/usr/bin/env python3
"""Reject destructive automation commands aimed at local Studio project fixtures."""

from __future__ import annotations

import json
import re
import sys


DESTRUCTIVE = re.compile(
    r"(?:^|[\s;&|])(?:rm|rmdir|unlink|shred|truncate|mv|cp)\b|"
    r"(?:^|\s)(?:>|>>)\s*|\*\*\*\s+Delete File:",
    re.IGNORECASE,
)
PROTECTED = re.compile(
    r"(?:^|[\s'\"])(?:studio/)?fixtures/"
    r"(?![^\s'\"]*(?:\.DS_Store|\.thumbnails(?:/|$)))",
    re.IGNORECASE,
)


def should_block(payload: dict[str, object]) -> bool:
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return False
    candidate = (
        tool_input.get("command")
        or tool_input.get("cmd")
        or tool_input.get("patch")
        or ""
    )
    text = str(candidate)
    return bool(DESTRUCTIVE.search(text) and PROTECTED.search(text))


def self_test() -> int:
    blocked = {"tool_input": {"command": "rm -rf studio/fixtures/my-video"}}
    allowed_read = {
        "tool_input": {"cmd": "rg root studio/fixtures/my-video/index.html"}
    }
    allowed_cache = {"tool_input": {"command": "rm -f studio/fixtures/.DS_Store"}}
    if not should_block(blocked) or should_block(allowed_read) or should_block(allowed_cache):
        return 1
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        return 0
    if should_block(payload):
        print(
            json.dumps(
                {
                    "continue": False,
                    "stopReason": (
                        "Protected Studio project data cannot be deleted or overwritten."
                    ),
                }
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
