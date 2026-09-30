#!/usr/bin/env python3
"""Add, plan, claim, update, and review Taomni DB-session parity cards (DBeaver + DbVisualizer references).

Every command takes the board path through --doc. Cards are markdown headings
followed by one `<!-- db-task {json} -->` line; this script is the only writer of
that line. Lifecycle:

    planning --ready--> ready --claim--> claimed/in_progress/blocked
        --update--> implemented | review_required | done --review--> accepted | ready
"""

from __future__ import annotations

import argparse
import contextlib
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any, Callable, Iterator

MARKER = "db-task"
STATUSES = {
    "planning",
    "ready",
    "claimed",
    "in_progress",
    "blocked",
    "implemented",
    "review_required",
    "done",
    "deferred",
}
ACTIVE = {"claimed", "in_progress", "blocked"}
CLAIMABLE = {"ready", "implemented"}
# Statuses that require a complete P1 contract (acceptance, evidence, test cases).
CONTRACTED = STATUSES - {"planning", "deferred"}
PRIORITIES = {"high": 0, "medium": 1, "low": 2}
SIZES = {"S", "M", "L"}
EVIDENCE_KINDS = {
    "code-audit",
    "unit",
    "typecheck",
    "build",
    "rust",
    "qa-lint",
    "browser",
    "native",
    "live-db",
    "performance",
    "accessibility",
    "reference-comparison",
    "document",
}
CLAIM_FIELDS = ("owner", "claimed_from", "claimed_at", "baseline")
TASK_ID = re.compile(r"^DB-[A-Z]+-\d{3}$")
CARD = re.compile(
    r"^### (?P<id>DB-[A-Z]+-\d{3}) (?P<title>[^\n]+)\n"
    rf"(?P<line><!-- {MARKER} (?P<json>\{{[^\n]*\}}) -->)$",
    re.MULTILINE,
)
ANCHOR = re.compile(r'<a id="([^"]+)"></a>')


class BoardError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def repo_root_for(doc: Path) -> Path:
    for candidate in (doc.parent, *doc.parent.parents):
        if (candidate / ".git").exists() or (candidate / "AGENTS.md").is_file():
            return candidate
    raise BoardError(f"Cannot locate repository root above {doc}")


def git_head(root: Path) -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=root, check=False, capture_output=True, text=True
    )
    if completed.returncode != 0:
        raise BoardError(f"Cannot resolve git HEAD: {completed.stderr.strip()}")
    return completed.stdout.strip()


def split_values(values: list[str] | None) -> list[str]:
    items: list[str] = []
    for value in values or []:
        items.extend(part.strip() for part in value.split(",") if part.strip())
    return items


def parse_cards(text: str) -> list[dict[str, Any]]:
    cards = []
    for match in CARD.finditer(text):
        try:
            metadata = json.loads(match.group("json"))
        except json.JSONDecodeError as error:
            raise BoardError(f"Invalid card JSON at offset {match.start()}: {error}") from error
        cards.append(
            {
                "heading_id": match.group("id"),
                "title": match.group("title").strip(),
                "metadata": metadata,
                "start": match.start("line"),
                "end": match.end("line"),
            }
        )
    return cards


def spec_section(root: Path, task_id: str, spec: Any) -> tuple[str | None, list[str]]:
    """Return the spec text from the card anchor to the next unrelated anchor."""
    if not isinstance(spec, str) or "#" not in spec:
        return None, [f"{task_id}: spec must be <repo path>#<anchor>"]
    path_text, anchor = spec.split("#", 1)
    errors = []
    if anchor != task_id.lower():
        errors.append(f"{task_id}: spec anchor must be #{task_id.lower()}")
    path = (root / path_text).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError:
        return None, [*errors, f"{task_id}: spec path escapes repository: {path_text}"]
    if not path.is_file():
        return None, [*errors, f"{task_id}: spec file does not exist: {path_text}"]
    text = path.read_text(encoding="utf-8")
    start = None
    end = len(text)
    for match in ANCHOR.finditer(text):
        name = match.group(1)
        if start is None:
            if name == anchor:
                start = match.start()
        elif name != anchor and not name.startswith(f"{anchor}-"):
            end = match.start()
            break
    if start is None:
        return None, [*errors, f"{task_id}: spec anchor not found: {spec}"]
    return text[start:end], errors


def validate_evidence(
    task_id: str, evidence: Any, required: list[str], acceptance: list[str], complete: bool
) -> list[str]:
    if not isinstance(evidence, dict):
        return [f"{task_id}: evidence must be an object"]
    errors = []
    for field in ("verified_at", "head"):
        if not isinstance(evidence.get(field), str) or not evidence[field].strip():
            errors.append(f"{task_id}: evidence.{field} must be a non-empty string")
    checks = evidence.get("checks")
    if not isinstance(checks, list):
        errors.append(f"{task_id}: evidence.checks must be a list")
        checks = []
    latest: dict[str, str] = {}
    covered: set[str] = set()
    for index, check in enumerate(checks):
        label = f"{task_id}: evidence.checks[{index}]"
        if not isinstance(check, dict):
            errors.append(f"{label} must be an object")
            continue
        kind, result = check.get("kind"), check.get("result")
        if kind not in EVIDENCE_KINDS:
            errors.append(f"{label} has invalid kind {kind!r}")
        if result not in {"passed", "failed"}:
            errors.append(f"{label}.result must be passed or failed")
        for field in ("command", "summary"):
            if not isinstance(check.get(field), str) or not check[field].strip():
                errors.append(f"{label}.{field} must be non-empty")
        ids = check.get("acceptance")
        if not isinstance(ids, list) or not all(isinstance(item, str) for item in ids):
            errors.append(f"{label}.acceptance must be a string list")
            ids = []
        unknown = sorted(set(ids) - set(acceptance))
        if unknown:
            errors.append(f"{label} references unknown acceptance ids: {', '.join(unknown)}")
        if len(set(ids)) != len(ids):
            errors.append(f"{label}.acceptance ids must be unique")
        if kind in EVIDENCE_KINDS and result in {"passed", "failed"}:
            latest[kind] = result
            if result == "passed":
                covered.update(set(ids) & set(acceptance))
    for field in ("unrun", "notes"):
        value = evidence.get(field)
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            errors.append(f"{task_id}: evidence.{field} must be a string list")
    if complete:
        missing_kinds = sorted(kind for kind in set(required) if latest.get(kind) != "passed")
        if missing_kinds:
            errors.append(f"{task_id}: done evidence lacks a final passed check for: {', '.join(missing_kinds)}")
        missing_ids = sorted(set(acceptance) - covered)
        if missing_ids:
            errors.append(f"{task_id}: done evidence does not cover acceptance: {', '.join(missing_ids)}")
    return errors


def string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def validate_card(card: dict[str, Any], root: Path) -> list[str]:
    metadata = card["metadata"]
    task_id = metadata["id"]
    status = metadata.get("status")
    errors = []
    if card["heading_id"] != task_id:
        errors.append(f"{task_id}: heading id is {card['heading_id']}")
    if status not in STATUSES:
        errors.append(f"{task_id}: invalid status {status!r}")
    if metadata.get("priority") not in PRIORITIES:
        errors.append(f"{task_id}: priority must be one of {', '.join(PRIORITIES)}")
    if metadata.get("size") not in SIZES:
        errors.append(f"{task_id}: size must be S, M or L")
    if not string_list(metadata.get("depends_on")):
        errors.append(f"{task_id}: depends_on must be a string list")
    elif task_id in metadata["depends_on"]:
        errors.append(f"{task_id}: cannot depend on itself")
    if not string_list(metadata.get("source")) or not metadata["source"]:
        errors.append(f"{task_id}: source must list the P0 requirement/matrix ids")
    audit = metadata.get("audit")
    if not isinstance(audit, dict) or not all(
        isinstance(audit.get(field), str) and audit[field].strip() for field in ("date", "head", "finding")
    ):
        errors.append(f"{task_id}: audit needs non-empty date, head and finding")

    section, spec_errors = spec_section(root, task_id, metadata.get("spec"))
    errors.extend(spec_errors)
    acceptance = metadata.get("acceptance", [])
    if not string_list(acceptance):
        errors.append(f"{task_id}: acceptance must be a string list")
        acceptance = []
    if len(set(acceptance)) != len(acceptance):
        errors.append(f"{task_id}: acceptance ids must be unique")
    for acceptance_id in acceptance:
        if not re.fullmatch(rf"{re.escape(task_id)}-A\d+", acceptance_id):
            errors.append(f"{task_id}: invalid acceptance id {acceptance_id!r}")
        elif section is not None and acceptance_id not in section:
            short = acceptance_id.removeprefix(f"{task_id}-")
            if f"`{short}`" not in section:
                errors.append(f"{task_id}: acceptance id not found in spec: {acceptance_id}")
    required = metadata.get("required_evidence", [])
    if not string_list(required):
        errors.append(f"{task_id}: required_evidence must be a string list")
        required = []
    unknown = sorted(set(required) - EVIDENCE_KINDS)
    if unknown:
        errors.append(f"{task_id}: invalid evidence kinds: {', '.join(unknown)}")
    if len(set(required)) != len(required):
        errors.append(f"{task_id}: required_evidence kinds must be unique")

    if status in CONTRACTED:
        if not acceptance:
            errors.append(f"{task_id}: {status} requires acceptance ids")
        if not required:
            errors.append(f"{task_id}: {status} requires required_evidence")
        marker = f'<a id="{task_id.lower()}-test-cases"></a>'
        if section is not None and marker not in section:
            errors.append(f"{task_id}: {status} requires a {marker} section in the spec")
    if status in ACTIVE:
        for field in ("owner", "claimed_at", "baseline"):
            if not metadata.get(field):
                errors.append(f"{task_id}: {status} requires {field}")
    elif any(metadata.get(field) is not None for field in CLAIM_FIELDS):
        errors.append(f"{task_id}: {status} cannot retain claim metadata")
    if status in {"blocked", "deferred"} and not metadata.get("note"):
        errors.append(f"{task_id}: {status} requires note")
    if status == "done":
        errors.extend(validate_evidence(task_id, metadata.get("evidence"), required, acceptance, True))
    elif metadata.get("evidence") is not None:
        errors.extend(validate_evidence(task_id, metadata["evidence"], required, acceptance, False))
    return errors


def validate_cards(cards: list[dict[str, Any]], root: Path) -> list[str]:
    errors: list[str] = []
    tasks: dict[str, dict[str, Any]] = {}
    active_owners: dict[str, str] = {}
    for card in cards:
        task_id = card["metadata"].get("id")
        if not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id):
            errors.append(f"invalid task id: {task_id!r}")
            continue
        if task_id in tasks:
            errors.append(f"duplicate task id: {task_id}")
        tasks[task_id] = card
        errors.extend(validate_card(card, root))
        metadata = card["metadata"]
        owner = metadata.get("owner")
        if metadata.get("status") in ACTIVE and isinstance(owner, str):
            if owner in active_owners:
                errors.append(f"owner {owner!r} has multiple active tasks: {active_owners[owner]}, {task_id}")
            active_owners[owner] = task_id
    for task_id, card in tasks.items():
        dependencies = card["metadata"].get("depends_on")
        for dependency in dependencies if string_list(dependencies) else []:
            if dependency not in tasks:
                errors.append(f"{task_id}: missing dependency {dependency}")
            elif card["metadata"].get("status") in {*ACTIVE, "done"} and (
                tasks[dependency]["metadata"].get("status") != "done"
            ):
                errors.append(f"{task_id}: active or done task has incomplete dependency {dependency}")

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(task_id: str, trail: list[str]) -> None:
        if task_id in visiting:
            errors.append(f"dependency cycle: {' -> '.join((*trail, task_id))}")
            return
        if task_id in visited or task_id not in tasks:
            return
        visiting.add(task_id)
        dependencies = tasks[task_id]["metadata"].get("depends_on")
        for dependency in dependencies if string_list(dependencies) else []:
            visit(dependency, [*trail, task_id])
        visiting.remove(task_id)
        visited.add(task_id)

    for task_id in tasks:
        visit(task_id, [])
    return errors


def pending_dependencies(card: dict[str, Any], tasks: dict[str, dict[str, Any]]) -> list[str]:
    return [
        dependency
        for dependency in card["metadata"].get("depends_on", [])
        if tasks.get(dependency, {}).get("metadata", {}).get("status") != "done"
    ]


def card_map(cards: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {card["metadata"].get("id", ""): card for card in cards}


def metadata_line(metadata: dict[str, Any]) -> str:
    return f"<!-- {MARKER} {json.dumps(metadata, ensure_ascii=False, separators=(',', ':'))} -->"


@contextlib.contextmanager
def board_lock(doc: Path) -> Iterator[None]:
    digest = hashlib.sha256(str(doc.resolve()).encode("utf-8")).hexdigest()[:16]
    lock_file = (Path(tempfile.gettempdir()) / f"taomni-db-client-board-{digest}.lock").open("a+b")
    try:
        if os.name == "nt":
            import msvcrt

            lock_file.seek(0)
            lock_file.write(b"0")
            lock_file.flush()
            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        if os.name == "nt":
            import msvcrt

            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        lock_file.close()


def write_atomic(doc: Path, text: str) -> None:
    mode = doc.stat().st_mode
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", newline="", dir=doc.parent, prefix=f".{doc.name}.", suffix=".tmp", delete=False
    ) as temporary:
        temporary.write(text)
        temporary.flush()
        os.fsync(temporary.fileno())
        temporary_path = Path(temporary.name)
    os.chmod(temporary_path, mode)
    os.replace(temporary_path, doc)


def load_board(doc: Path) -> tuple[str, list[dict[str, Any]], Path]:
    root = repo_root_for(doc)
    text = doc.read_text(encoding="utf-8")
    cards = parse_cards(text)
    errors = validate_cards(cards, root)
    if errors:
        raise BoardError("Task board is invalid:\n- " + "\n- ".join(errors))
    return text, cards, root


def commit_board(doc: Path, text: str, root: Path) -> None:
    errors = validate_cards(parse_cards(text), root)
    if errors:
        raise BoardError("Task board would be invalid:\n- " + "\n- ".join(errors))
    write_atomic(doc, text)


def mutate(doc: Path, task_id: str, change: Callable[[dict[str, Any], dict[str, dict[str, Any]]], None]) -> dict[str, Any]:
    with board_lock(doc):
        text, cards, root = load_board(doc)
        tasks = card_map(cards)
        card = tasks.get(task_id)
        if not card:
            raise BoardError(f"Unknown task: {task_id}")
        metadata = json.loads(json.dumps(card["metadata"]))
        change(metadata, tasks)
        commit_board(doc, text[: card["start"]] + metadata_line(metadata) + text[card["end"] :], root)
        return metadata


def load_evidence(path: Path | None) -> Any:
    if path is None:
        return None
    if not path.is_file():
        raise BoardError(f"evidence file does not exist: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise BoardError(f"invalid evidence JSON: {error}") from error


def expand_acceptance(task_id: str, values: list[str]) -> list[str]:
    return [value if value.startswith(f"{task_id}-") else f"{task_id}-{value}" for value in values]


def require_owner(value: str) -> str:
    owner = value.strip()
    if not owner:
        raise BoardError("owner cannot be empty")
    return owner


def cmd_validate(doc: Path, _args: argparse.Namespace) -> None:
    _text, cards, _root = load_board(doc)
    print(f"OK: {len(cards)} tasks in {doc}")


def cmd_list(doc: Path, args: argparse.Namespace) -> None:
    _text, cards, _root = load_board(doc)
    tasks = card_map(cards)
    rows = []
    for order, card in enumerate(cards):
        metadata = card["metadata"]
        pending = pending_dependencies(card, tasks)
        claimable = metadata["status"] in CLAIMABLE and not pending
        if args.status and metadata["status"] not in args.status:
            continue
        if args.claimable and not claimable:
            continue
        if args.plannable and metadata["status"] != "planning":
            continue
        rows.append(
            {
                "id": metadata["id"],
                "title": card["title"],
                "priority": metadata["priority"],
                "size": metadata["size"],
                "status": metadata["status"],
                "claimable": claimable,
                "owner": metadata.get("owner"),
                "source": metadata.get("source", []),
                "spec": metadata.get("spec"),
                "required_evidence": metadata.get("required_evidence", []),
                "pending_dependencies": pending,
                "_order": order,
            }
        )
    rows.sort(key=lambda row: (PRIORITIES[row["priority"]], row["_order"]))
    for row in rows:
        row.pop("_order")
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    if not rows:
        print("No matching tasks")
    for row in rows:
        owner = f" owner={row['owner']}" if row["owner"] else ""
        deps = f" deps={','.join(row['pending_dependencies'])}" if row["pending_dependencies"] else ""
        print(f"{row['priority']:<6} {row['size']} {row['status']:<15} {row['id']} {row['title']}{owner}{deps}")


def cmd_show(doc: Path, args: argparse.Namespace) -> None:
    cards = parse_cards(doc.read_text(encoding="utf-8"))
    tasks = card_map(cards)
    card = tasks.get(args.task_id)
    if not card:
        raise BoardError(f"Unknown task: {args.task_id}")
    pending = pending_dependencies(card, tasks)
    print(
        json.dumps(
            {
                **card["metadata"],
                "title": card["title"],
                "claimable": card["metadata"].get("status") in CLAIMABLE and not pending,
                "pending_dependencies": pending,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def cmd_add(doc: Path, args: argparse.Namespace) -> None:
    if not TASK_ID.fullmatch(args.task_id):
        raise BoardError("task id must match DB-<DOMAIN>-NNN")
    with board_lock(doc):
        text, cards, root = load_board(doc)
        if args.task_id in card_map(cards):
            raise BoardError(f"{args.task_id} already exists")
        metadata = {
            "id": args.task_id,
            "status": "planning",
            "priority": args.priority,
            "size": args.size,
            "depends_on": split_values(args.depends_on),
            "source": split_values(args.source),
            "scope": split_values(args.scope),
            "spec": args.spec,
            "acceptance": [],
            "required_evidence": [],
            "audit": {"date": utc_now()[:10], "head": git_head(root), "finding": args.finding},
        }
        block = f"### {args.task_id} {args.title.strip()}\n{metadata_line(metadata)}\n"
        if args.summary:
            block += f"\n{args.summary.strip()}\n"
        commit_board(doc, text.rstrip("\n") + "\n\n" + block, root)
    print(f"Added {args.task_id} (planning)")


def cmd_ready(doc: Path, args: argparse.Namespace) -> None:
    def change(metadata: dict[str, Any], _tasks: dict[str, dict[str, Any]]) -> None:
        if metadata["status"] != "planning":
            raise BoardError(f"{args.task_id} is {metadata['status']}; only planning cards can become ready")
        metadata["status"] = "ready"
        metadata["acceptance"] = expand_acceptance(args.task_id, split_values(args.acceptance))
        metadata["required_evidence"] = split_values(args.evidence)
        if args.spec:
            metadata["spec"] = args.spec
        if args.depends_on is not None:
            metadata["depends_on"] = split_values(args.depends_on)
        metadata["planned_at"] = utc_now()
        metadata.pop("note", None)

    mutate(doc, args.task_id, change)
    print(f"{args.task_id} is ready")


def cmd_triage(doc: Path, args: argparse.Namespace) -> None:
    def change(metadata: dict[str, Any], _tasks: dict[str, dict[str, Any]]) -> None:
        if metadata["status"] not in {"planning", "ready", "deferred", "review_required"}:
            raise BoardError(f"{args.task_id} is {metadata['status']}; triage only unclaimed, undelivered cards")
        metadata["status"] = args.status
        if args.priority:
            metadata["priority"] = args.priority
        metadata["note"] = args.note
        metadata["updated_at"] = utc_now()

    mutate(doc, args.task_id, change)
    print(f"{args.task_id} -> {args.status}")


def cmd_claim(doc: Path, args: argparse.Namespace) -> None:
    owner = require_owner(args.owner)
    baseline = args.baseline or git_head(repo_root_for(doc))

    def change(metadata: dict[str, Any], tasks: dict[str, dict[str, Any]]) -> None:
        if metadata["status"] not in CLAIMABLE:
            raise BoardError(f"{args.task_id} is {metadata['status']}; only ready or implemented cards are claimable")
        pending = pending_dependencies(tasks[args.task_id], tasks)
        if pending:
            raise BoardError(f"{args.task_id} has incomplete dependencies: {', '.join(pending)}")
        for other_id, other in tasks.items():
            if other_id != args.task_id and other["metadata"].get("status") in ACTIVE and other["metadata"].get("owner") == owner:
                raise BoardError(f"owner {owner!r} already has active task {other_id}")
        now = utc_now()
        metadata.update(
            {"status": "claimed", "claimed_from": metadata["status"], "owner": owner, "claimed_at": now, "baseline": baseline, "updated_at": now}
        )
        metadata.pop("note", None)
        metadata.pop("evidence", None)

    mutate(doc, args.task_id, change)
    print(f"Claimed {args.task_id} for {owner} at {baseline}")


def cmd_update(doc: Path, args: argparse.Namespace) -> None:
    owner = require_owner(args.owner)
    evidence = load_evidence(args.evidence_file)

    def change(metadata: dict[str, Any], tasks: dict[str, dict[str, Any]]) -> None:
        if metadata["status"] not in ACTIVE:
            raise BoardError(f"{args.task_id} is {metadata['status']}; claim it before update")
        if metadata.get("owner") != owner:
            raise BoardError(f"{args.task_id} is owned by {metadata.get('owner')}, not {owner}")
        if args.status == "done" and evidence is None:
            raise BoardError("done requires --evidence-file")
        if args.status in {"blocked", "implemented", "review_required"} and not args.note:
            raise BoardError(f"{args.status} requires --note naming the gap, conflict or resume condition")
        metadata["status"] = args.status
        metadata["updated_at"] = utc_now()
        if evidence is not None:
            metadata["evidence"] = evidence
        if args.note:
            metadata["note"] = args.note
        else:
            metadata.pop("note", None)
        if args.status in {"implemented", "review_required", "done"}:
            metadata["last_attempt"] = {
                "owner": owner,
                "claimed_from": metadata.get("claimed_from"),
                "claimed_at": metadata.get("claimed_at"),
                "baseline": metadata.get("baseline"),
                "finished_at": metadata["updated_at"],
                "result": args.status,
                "note": args.note,
            }
            for field in (*CLAIM_FIELDS, "note"):
                metadata.pop(field, None)

    mutate(doc, args.task_id, change)
    print(f"Updated {args.task_id}: {args.status}")


def cmd_review(doc: Path, args: argparse.Namespace) -> None:
    reviewer = require_owner(args.reviewer)
    evidence = load_evidence(args.evidence_file)

    def change(metadata: dict[str, Any], _tasks: dict[str, dict[str, Any]]) -> None:
        if metadata["status"] not in {"done", "implemented"}:
            raise BoardError(f"{args.task_id} is {metadata['status']}; review only done or implemented cards")
        if args.result == "accepted" and metadata["status"] != "done":
            raise BoardError("only done cards can be accepted")
        review = {"reviewer": reviewer, "result": args.result, "at": utc_now(), "head": git_head(repo_root_for(doc)), "note": args.note}
        if evidence is not None:
            errors = validate_evidence(args.task_id, evidence, [], metadata.get("acceptance", []), False)
            if errors:
                raise BoardError("invalid review evidence:\n- " + "\n- ".join(errors))
            review["evidence"] = evidence
        if args.result == "accepted":
            metadata["review"] = review
            return
        history = metadata.setdefault("history", [])
        history.append(
            {key: metadata.pop(key) for key in ("evidence", "last_attempt", "review") if key in metadata} | {"reopened_by": review}
        )
        metadata["status"] = "ready"
        metadata["note"] = f"P3 changes requested: {args.note}"
        metadata["updated_at"] = review["at"]

    mutate(doc, args.task_id, change)
    print(f"Reviewed {args.task_id}: {args.result}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--doc", type=Path, required=True, help="Board path, e.g. docs-feature/db-client-parity/backlog.md")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("validate", help="Validate metadata, spec anchors and dependencies")

    listing = sub.add_parser("list", help="List cards by priority, then board order")
    listing.add_argument("--status", action="append", choices=sorted(STATUSES))
    listing.add_argument("--claimable", action="store_true", help="P2: ready/implemented with done dependencies")
    listing.add_argument("--plannable", action="store_true", help="P1: planning cards")
    listing.add_argument("--json", action="store_true")

    show = sub.add_parser("show", help="Show one card")
    show.add_argument("task_id")

    add = sub.add_parser("add", help="P0: append a planning card")
    add.add_argument("task_id")
    add.add_argument("--title", required=True)
    add.add_argument("--priority", required=True, choices=list(PRIORITIES))
    add.add_argument("--size", required=True, choices=sorted(SIZES))
    add.add_argument("--spec", required=True, help="<path>#<lowercase id>, usually task-planning.md")
    add.add_argument("--source", action="append", required=True, help="REQ/matrix ids, comma or repeated")
    add.add_argument("--finding", required=True, help="Factual P0 gap statement")
    add.add_argument("--depends-on", action="append")
    add.add_argument("--scope", action="append", help="Engines or surfaces, e.g. mysql,postgres")
    add.add_argument("--summary", help="One-paragraph card body")

    ready = sub.add_parser("ready", help="P1: promote a planning card after the spec is complete")
    ready.add_argument("task_id")
    ready.add_argument("--acceptance", action="append", required=True, help="A1,A2 or full ids")
    ready.add_argument("--evidence", action="append", required=True, help="Required evidence kinds")
    ready.add_argument("--spec", help="Move the spec to the P1 design section")
    ready.add_argument("--depends-on", action="append")

    triage = sub.add_parser("triage", help="P0/P1: return a card to planning or park it")
    triage.add_argument("task_id")
    triage.add_argument("--status", required=True, choices=["planning", "deferred"])
    triage.add_argument("--note", required=True)
    triage.add_argument("--priority", choices=list(PRIORITIES))

    claim = sub.add_parser("claim", help="P2: claim a ready or implemented card")
    claim.add_argument("task_id")
    claim.add_argument("--owner", required=True)
    claim.add_argument("--baseline")

    update = sub.add_parser("update", help="P2: move an owned card")
    update.add_argument("task_id")
    update.add_argument("--owner", required=True)
    update.add_argument("--status", required=True, choices=["in_progress", "blocked", "implemented", "review_required", "done"])
    update.add_argument("--evidence-file", type=Path)
    update.add_argument("--note")

    review = sub.add_parser("review", help="P3: accept a done card or request changes")
    review.add_argument("task_id")
    review.add_argument("--reviewer", required=True)
    review.add_argument("--result", required=True, choices=["accepted", "changes_requested"])
    review.add_argument("--note", required=True)
    review.add_argument("--evidence-file", type=Path)
    return parser


COMMANDS = {
    "validate": cmd_validate,
    "list": cmd_list,
    "show": cmd_show,
    "add": cmd_add,
    "ready": cmd_ready,
    "triage": cmd_triage,
    "claim": cmd_claim,
    "update": cmd_update,
    "review": cmd_review,
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        doc = args.doc.resolve()
        if not doc.is_file():
            raise BoardError(f"Board not found: {doc}")
        COMMANDS[args.command](doc, args)
        return 0
    except BoardError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
