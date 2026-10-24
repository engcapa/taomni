"""Require a real authenticated ClickHouse native endpoint; never mock readiness."""
import os


def setup(ctx):
    from clickhouse_driver import Client
    section = (getattr(ctx, "cfg", {}) or {}).get("clickhouse", {})
    password = (getattr(ctx, "env", {}) or {}).get("QA_CLICKHOUSE_PASSWORD") or os.environ.get("QA_CLICKHOUSE_PASSWORD")
    if not section.get("host") or not section.get("port") or not password:
        raise RuntimeError("ClickHouse fixture requires clickhouse.host/port and QA_CLICKHOUSE_PASSWORD")
    client = Client(host=section["host"], port=int(section["port"]),
                    user=section.get("user", "qa"), password=password,
                    connect_timeout=5, send_receive_timeout=5)
    try:
        if client.execute("SELECT 42") != [(42,)]:
            raise RuntimeError("ClickHouse fixture returned an unexpected native result")
    finally:
        client.disconnect()
