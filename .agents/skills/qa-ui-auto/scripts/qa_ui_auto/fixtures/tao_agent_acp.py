"""Minimal native ACP peer used only by the isolated Tao handoff fixture."""
from __future__ import annotations

import json
import sys
from pathlib import Path


def serve(log):
    def emit(value):
        print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        method = request.get("method")
        if "id" not in request:
            continue
        if method == "initialize":
            result = dict(protocolVersion=1, agentInfo=dict(name="qa-tao-peer", version="1"), agentCapabilities=dict(loadSession=True))
        elif method == "session/new":
            result = dict(sessionId="qa-tao-agent-session")
        elif method == "session/prompt":
            content = json.dumps(request.get("params", {}).get("prompt", []))
            Path(log).write_text(json.dumps(dict(received=True, hasGoal="Build a Python" in content, hasHistory="untrusted_tao_history" in content, hasUnsavedDraft="Private unsent" in content)), encoding="utf-8")
            emit(dict(method="session/update", params=dict(sessionId="qa-tao-agent-session", update=dict(sessionUpdate="agent_message_chunk", content=dict(type="text", text="QA coding agent result: reviewed the plan; tests require confirmation before execution.")))))
            result = dict(stopReason="end_turn")
        else:
            result = {}
        emit(dict(id=request["id"], result=result))


if __name__ == "__main__":
    serve(sys.argv[1])
