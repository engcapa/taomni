"""Wire-complete fixtures for OpenAI Chat/Responses and Anthropic Messages."""
from __future__ import annotations

import json
from typing import Iterable

from behavior import Decision

INPUT_TOKENS = 128
OUTPUT_TOKENS = 64


def compact(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sse(value: object, event: str | None = None) -> bytes:
    prefix = f"event: {event}\n" if event else ""
    return (prefix + "data: " + (value if isinstance(value, str) else compact(value)) + "\n\n").encode()


def text_parts(text: str) -> Iterable[str]:
    # Cross NDJSON and multibyte boundaries independently of application frames.
    for offset in range(0, len(text), 41):
        yield text[offset:offset + 41]


def chat_object(model: str, decision: Decision, request_id: str) -> dict:
    message = {"role": "assistant", "content": decision.text or None}
    reason = "length" if decision.scenario in {"truncated", "partial"} else "stop"
    if decision.tool_name:
        message["tool_calls"] = [{"id": decision.call_id, "type": "function", "function": {
            "name": decision.tool_name, "arguments": compact(decision.tool_args)}}]
        reason = "tool_calls"
    return {"id": request_id, "object": "chat.completion", "created": 1700000000,
            "model": model, "choices": [{"index": 0, "message": message, "finish_reason": reason}],
            "usage": {"prompt_tokens": INPUT_TOKENS, "completion_tokens": OUTPUT_TOKENS,
                      "total_tokens": INPUT_TOKENS + OUTPUT_TOKENS}}


def message_object(model: str, decision: Decision, request_id: str) -> dict:
    content = [{"type": "text", "text": decision.text}] if decision.text else []
    reason = "max_tokens" if decision.scenario in {"truncated", "partial"} else "end_turn"
    if decision.tool_name:
        content.append({"type": "tool_use", "id": decision.call_id,
                        "name": decision.tool_name, "input": decision.tool_args})
        reason = "tool_use"
    return {"id": request_id, "type": "message", "role": "assistant", "model": model,
            "content": content, "stop_reason": reason, "stop_sequence": None,
            "usage": {"input_tokens": INPUT_TOKENS, "output_tokens": OUTPUT_TOKENS,
                      "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}


def response_object(model: str, decision: Decision, request_id: str) -> dict:
    output = []
    if decision.tool_name:
        output.append({"id": "fc_" + request_id, "type": "function_call", "status": "completed",
                       "call_id": decision.call_id, "name": decision.tool_name,
                       "arguments": compact(decision.tool_args)})
    else:
        output.append({"id": "msg_" + request_id, "type": "message", "status": "completed",
                       "role": "assistant", "content": [{"type": "output_text", "text": decision.text,
                                                           "annotations": [], "logprobs": []}]})
    incomplete = decision.scenario in {"truncated", "partial"}
    return {"id": request_id, "object": "response", "created_at": 1700000000, "model": model,
            "status": "incomplete" if incomplete else "completed", "output": output,
            "error": None, "incomplete_details": {"reason": "max_output_tokens"} if incomplete else None,
            "parallel_tool_calls": False, "tool_choice": "auto", "tools": [],
            "usage": {"input_tokens": INPUT_TOKENS, "output_tokens": OUTPUT_TOKENS,
                      "total_tokens": INPUT_TOKENS + OUTPUT_TOKENS,
                      "input_tokens_details": {"cached_tokens": 0},
                      "output_tokens_details": {"reasoning_tokens": 0}}}


def json_response(protocol: str, model: str, decision: Decision, request_id: str) -> dict:
    return {"openai_chat": chat_object, "openai_responses": response_object,
            "anthropic_messages": message_object}[protocol](model, decision, request_id)


def chat_stream(model: str, decision: Decision, request_id: str) -> Iterable[bytes]:
    base = {"id": request_id, "object": "chat.completion.chunk", "created": 1700000000,
            "model": model}

    def chunk(delta: dict, reason=None):
        return sse({**base, "choices": [{"index": 0, "delta": delta, "finish_reason": reason}]})

    yield chunk({"role": "assistant", "content": ""})
    if decision.tool_name:
        yield chunk({"tool_calls": [{"index": 0, "id": decision.call_id, "type": "function",
                                      "function": {"name": decision.tool_name, "arguments": ""}}]})
        for part in text_parts(compact(decision.tool_args)):
            yield chunk({"tool_calls": [{"index": 0, "function": {"arguments": part}}]})
    else:
        for part in text_parts(decision.text):
            yield chunk({"content": part})
    if decision.scenario == "error":
        yield sse({"error": {"type": "fixture_stream_error", "message": "intentional fixture failure"}})
        return
    if decision.scenario == "truncated":
        return  # Deliberately EOF without a terminal frame.
    reason = "tool_calls" if decision.tool_name else "length" if decision.scenario == "partial" else "stop"
    yield chunk({}, reason)
    yield sse({**base, "choices": [], "usage": chat_object(model, decision, request_id)["usage"]})
    yield sse("[DONE]")


def message_stream(model: str, decision: Decision, request_id: str) -> Iterable[bytes]:
    message = message_object(model, decision, request_id)
    yield sse({"type": "message_start", "message": {**message, "content": [], "stop_reason": None,
                                                      "usage": {"input_tokens": INPUT_TOKENS, "output_tokens": 0}}},
              "message_start")
    block = ({"type": "tool_use", "id": decision.call_id, "name": decision.tool_name, "input": {}}
             if decision.tool_name else {"type": "text", "text": ""})
    yield sse({"type": "content_block_start", "index": 0, "content_block": block}, "content_block_start")
    text = compact(decision.tool_args) if decision.tool_name else decision.text
    # Anthropic permits a message_start and immediate error, but not an empty
    # text_delta. Fixture decisions always provide either text or a tool call.
    for part in text_parts(text):
        delta = ({"type": "input_json_delta", "partial_json": part} if decision.tool_name
                 else {"type": "text_delta", "text": part})
        yield sse({"type": "content_block_delta", "index": 0, "delta": delta}, "content_block_delta")
    if decision.scenario == "error":
        yield sse({"type": "error", "error": {"type": "api_error", "message": "intentional fixture failure"}}, "error")
        return
    if decision.scenario == "truncated":
        return
    yield sse({"type": "content_block_stop", "index": 0}, "content_block_stop")
    yield sse({"type": "message_delta", "delta": {"stop_reason": message["stop_reason"], "stop_sequence": None},
               "usage": {"output_tokens": OUTPUT_TOKENS}}, "message_delta")
    yield sse({"type": "message_stop"}, "message_stop")


def response_stream(model: str, decision: Decision, request_id: str) -> Iterable[bytes]:
    response = response_object(model, decision, request_id)
    sequence = 0

    def event(name: str, **payload):
        nonlocal sequence
        data = sse({"type": name, "sequence_number": sequence, **payload}, name)
        sequence += 1
        return data

    initial = {**response, "status": "in_progress", "output": [], "usage": None}
    yield event("response.created", response=initial)
    yield event("response.in_progress", response=initial)
    item = response["output"][0]
    pending = {**item, "status": "in_progress"}
    if decision.tool_name:
        pending["arguments"] = ""
    else:
        pending["content"] = []
    yield event("response.output_item.added", output_index=0, item=pending)
    if decision.tool_name:
        for part in text_parts(compact(decision.tool_args)):
            yield event("response.function_call_arguments.delta", item_id=item["id"], output_index=0, delta=part)
        yield event("response.function_call_arguments.done", item_id=item["id"], output_index=0,
                    arguments=compact(decision.tool_args))
    else:
        yield event("response.content_part.added", item_id=item["id"], output_index=0, content_index=0,
                    part={"type": "output_text", "text": "", "annotations": [], "logprobs": []})
        for part in text_parts(decision.text):
            yield event("response.output_text.delta", item_id=item["id"], output_index=0,
                        content_index=0, delta=part, logprobs=[])
    if decision.scenario == "error":
        yield event("response.failed", response={**response, "status": "failed",
                                                "error": {"code": "server_error", "message": "intentional fixture failure"}})
        return
    if decision.scenario == "truncated":
        return
    if not decision.tool_name:
        yield event("response.output_text.done", item_id=item["id"], output_index=0,
                    content_index=0, text=decision.text, logprobs=[])
        yield event("response.content_part.done", item_id=item["id"], output_index=0,
                    content_index=0, part=item["content"][0])
    yield event("response.output_item.done", output_index=0, item=item)
    terminal = "response.incomplete" if decision.scenario == "partial" else "response.completed"
    yield event(terminal, response=response)


def stream_response(protocol: str, model: str, decision: Decision, request_id: str) -> Iterable[bytes]:
    return {"openai_chat": chat_stream, "openai_responses": response_stream,
            "anthropic_messages": message_stream}[protocol](model, decision, request_id)
