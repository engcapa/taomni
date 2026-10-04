"""Read committed rows through an independent, read-only MySQL connection."""
from __future__ import annotations

import json
import re
from pathlib import Path

from .steps import StepError


def assert_rows(cfg: dict, args: dict, case_dir: Path) -> None:
    query = args["query"].strip().rstrip(";")
    if not re.match(r"^SELECT\b", query, re.I) or ";" in query or re.search(r"\b(INTO|OUTFILE|DUMPFILE|FOR\s+UPDATE|LOCK)\b", query, re.I):
        raise StepError("mysql_assert_rows accepts one read-only SELECT")
    section = cfg.get("database") or cfg.get("mysql") or {}
    if not all(section.get(key) for key in ("host", "port", "user", "password", "database")):
        raise StepError("mysql_assert_rows requires the configured disposable database")
    import pymysql
    connection = pymysql.connect(host=section["host"], port=int(section["port"]), user=section["user"],
        password=section["password"], database=section["database"], autocommit=False,
        connect_timeout=5, read_timeout=10, write_timeout=5)
    try:
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION READ ONLY")
            cursor.execute(query)
            rows = [list(row) for row in cursor.fetchall()]
        passed = rows == args["equals"]
        case_dir.mkdir(parents=True, exist_ok=True)
        with (case_dir / "mysql-committed-rows.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"query": query, "rows": rows, "expected": args["equals"], "passed": passed}, ensure_ascii=False, default=str) + "\n")
        if not passed:
            raise StepError(f"Independent committed rows {rows!r} differ from {args['equals']!r}")
    finally:
        connection.rollback()
        connection.close()
