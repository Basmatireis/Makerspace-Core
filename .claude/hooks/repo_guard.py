#!/usr/bin/env python3
"""Claude Code hooks for this repository (wired in .claude/settings.json).

  protect   PreToolUse Edit|Write: refuse edits to generated files and to migrations already on origin/main.
  format    PostToolUse Edit|Write: gofmt or prettier the edited file.
  generate  Stop: remind once when contract, SQL or migrations changed but no generated file did.

A refusal exits with 2 and explains on stderr, which Claude Code shows to the agent. Every other problem
(missing tool, no git, unreadable input) lets the action through: these hooks are guard rails, the CI
checks stay authoritative.
"""

import json
import os
import subprocess
import sys

ROOT = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
GENERATED_DIRS = ("frontend/src/api/generated/",)
GENERATED_SOURCES = ("api/openapi.yaml", "backend/sqlc.yaml", "backend/oapi-codegen.yaml")


def relative(path):
    path = os.path.realpath(os.path.join(ROOT, path))
    root = os.path.realpath(ROOT)
    return os.path.relpath(path, root) if path.startswith(root + os.sep) else None


def git(*args):
    result = subprocess.run(["git", "-C", ROOT, *args], capture_output=True, text=True, check=False)
    return result.returncode, result.stdout


def is_generated(rel):
    if rel.startswith(GENERATED_DIRS):
        return True
    try:
        with open(os.path.join(ROOT, rel), encoding="utf-8", errors="replace") as handle:
            head = "".join(handle.readline() for _ in range(5))
    except OSError:
        return False
    return "Code generated" in head and "DO NOT EDIT" in head


def protect(event):
    rel = relative(event.get("tool_input", {}).get("file_path", ""))
    if rel is None:
        return 0
    if is_generated(rel):
        print(
            f"{rel} is generated and must not be edited by hand. Change the source "
            "(api/openapi.yaml, a queries.sql or a migration) and run `make generate`.",
            file=sys.stderr,
        )
        return 2
    if rel.startswith("backend/migrations/") and rel.endswith(".sql"):
        code, _ = git("cat-file", "-e", f"origin/main:{rel}")
        if code == 0:
            print(
                f"{rel} is already on main and may have been applied; applied migrations are never edited. "
                "Add a new migration with the next free number instead.",
                file=sys.stderr,
            )
            return 2
    return 0


def format_file(event):
    rel = relative(event.get("tool_input", {}).get("file_path", ""))
    if rel is None or not os.path.isfile(os.path.join(ROOT, rel)) or is_generated(rel):
        return 0
    path = os.path.join(ROOT, rel)
    if rel.endswith(".go"):
        command = ["gofmt", "-w", path]
    elif rel.startswith("frontend/"):
        prettier = os.path.join(ROOT, "frontend/node_modules/.bin/prettier")
        if not os.path.exists(prettier):
            return 0
        command = [prettier, "--write", "--ignore-unknown", "--log-level", "warn", path]
    else:
        return 0
    try:
        subprocess.run(command, cwd=ROOT, capture_output=True, check=False, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        pass
    return 0


def generate(event):
    if event.get("stop_hook_active"):
        return 0
    code, status = git("status", "--porcelain", "--untracked-files=all")
    if code != 0:
        return 0
    changed = [line[3:].split(" -> ")[-1] for line in status.splitlines()]
    sources = [
        path
        for path in changed
        if path in GENERATED_SOURCES
        or (path.startswith("backend/internal/") and path.endswith("/db/queries.sql"))
        or (path.startswith("backend/migrations/") and path.endswith(".sql"))
    ]
    regenerated = [path for path in changed if os.path.isfile(os.path.join(ROOT, path)) and is_generated(path)]
    if sources and not regenerated:
        print(
            json.dumps(
                {
                    "decision": "block",
                    "reason": "Changed "
                    + ", ".join(sorted(sources)[:5])
                    + " but no generated file. Run `make generate` (or `make generate-sqlc`) and review the "
                    "generated diff; if nothing needs regenerating, say so and stop.",
                }
            )
        )
    return 0


def main():
    try:
        event = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        return 0
    handlers = {"protect": protect, "format": format_file, "generate": generate}
    handler = handlers.get(sys.argv[1] if len(sys.argv) > 1 else "")
    return handler(event) if handler else 0


if __name__ == "__main__":
    sys.exit(main())
