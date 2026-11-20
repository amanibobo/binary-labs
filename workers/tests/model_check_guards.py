"""Proves test_model_check.py can fail. Each entry breaks one guard in model_check.py, reruns
the tests and expects them to go red; the file is put back after every one. From workers/,
with BL_TEST_DB set:

    uv run python tests/model_check_guards.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "src/bl_worker/model_check.py"

GUARDS = [
    (
        "sharing is asked before a model is",
        "            if not exportable(conn, task_id):\n"
        '                stop("not_shared", OFF, todo[i:])',
        '            if False:\n                stop("not_shared", OFF, todo[i:])',
    ),
    (
        "sharing is asked before the grader is",
        "        if not exportable(conn, task_id):\n            stop(code=",
        "        if False:\n            stop(code=",
    ),
    (
        "the answer key stays out of what a model is sent",
        '        f"## Question\\n\\n{folder.question}",\n',
        '        f"## Question\\n\\n{folder.question}\\n\\n{folder.answer_key}",\n',
    ),
    (
        "a call that could pass the cap isn't made",
        "            if spent + ceiling_usd(row.model, solve) + grade_worst > cap:",
        "            if False:",
    ),
    (
        "a task too long to send isn't cut and sent",
        "            if too_long:\n",
        "            if False:\n",
    ),
    (
        "an answered model isn't asked again",
        '        r for r in rows if r.state == "waiting"'
        ' or (r.state == "answered" and r.verdict is None)\n',
        "        r for r in rows\n",
    ),
    (
        "only scrubbed evidence is sent as text",
        'if e.get("treatment") == "scrubbed" else None',
        "",
    ),
    (
        "a cut-off reply is no answer",
        'ok = choice.get("finish_reason") == "stop" and',
        "ok =",
    ),
    (
        "unknown spend counts as the worst case",
        "            cost = ceiling_usd(route.model, ask)\n",
        "            cost = Decimal(0)\n",
    ),
]


def main() -> int:
    original = SOURCE.read_text()
    held, slipped = 0, []
    only = sys.argv[1] if len(sys.argv) > 1 else None
    try:
        for name, old, new in GUARDS:
            if only and only not in name:
                continue
            if original.count(old) != 1:
                raise SystemExit(f'"{name}": found {original.count(old)} times, expected once')
            SOURCE.write_text(original.replace(old, new))
            run = subprocess.run(
                ["uv", "run", "pytest", "-q", "-x", "tests/test_model_check.py"],
                capture_output=True,
                text=True,
            )
            caught = run.returncode == 1 and " failed" in run.stdout
            print(("caught   " if caught else "MISSED   ") + name)
            if caught:
                held += 1
            else:
                slipped.append(name)
    finally:
        SOURCE.write_text(original)
    print(f"\n{held} of {held + len(slipped)} broken guards made the tests fail.")
    return 1 if slipped else 0


if __name__ == "__main__":
    raise SystemExit(main())
