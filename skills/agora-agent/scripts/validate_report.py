#!/usr/bin/env python3
import json
import sys
from pathlib import Path

VERDICTS = {"low", "medium", "high", "critical"}
STATUSES = {"pass", "warn", "danger", "info"}
FLAGS = {"danger", "warn", "info"}
REQUIRED = [
    "verdict",
    "safety",
    "fund_flow",
    "smart_money",
    "deployer",
    "assessment",
    "sources",
]


def fail(path: Path, msg: str) -> int:
    print(f"{path}: {msg}", file=sys.stderr)
    return 1


def validate_file(path: Path) -> int:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        return fail(path, f"invalid JSON: {exc}")

    if not isinstance(data, dict):
        return fail(path, "report must be a JSON object")

    missing = [key for key in REQUIRED if key not in data]
    if missing:
        return fail(path, f"missing required field(s): {', '.join(missing)}")

    if data["verdict"] not in VERDICTS:
        return fail(path, f"bad verdict: {data['verdict']!r}")

    for key in ["safety", "fund_flow", "smart_money", "assessment", "sources"]:
        if not isinstance(data[key], list):
            return fail(path, f"{key} must be an array")

    if not isinstance(data["deployer"], dict):
        return fail(path, "deployer must be an object")

    for i, fact in enumerate(data["safety"]):
        if not isinstance(fact, dict):
            return fail(path, f"safety[{i}] must be an object")
        for key in ["key", "status", "value"]:
            if key not in fact:
                return fail(path, f"safety[{i}] missing {key}")
        if fact["status"] not in STATUSES:
            return fail(path, f"safety[{i}] bad status: {fact['status']!r}")

    for i, step in enumerate(data["fund_flow"]):
        if not isinstance(step, dict):
            return fail(path, f"fund_flow[{i}] must be an object")
        for key in ["title", "detail", "flag"]:
            if key not in step:
                return fail(path, f"fund_flow[{i}] missing {key}")
        if step["flag"] not in FLAGS:
            return fail(path, f"fund_flow[{i}] bad flag: {step['flag']!r}")

    for i, source in enumerate(data["sources"]):
        if not isinstance(source, dict):
            return fail(path, f"sources[{i}] must be an object")
        if not source.get("label") or not source.get("url"):
            return fail(path, f"sources[{i}] requires label and url")

    if not data["sources"]:
        return fail(path, "sources must contain at least one entry")

    print(f"{path}: ok")
    return 0


def iter_paths(arg: str):
    path = Path(arg)
    if path.is_dir():
        yield from sorted(path.glob("*.json"))
    else:
        yield path


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: validate_report.py <report.json|outbox-dir> [...]", file=sys.stderr)
        return 2
    code = 0
    for arg in sys.argv[1:]:
        for path in iter_paths(arg):
            code |= validate_file(path)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
