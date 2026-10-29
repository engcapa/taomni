"""Public JSON workloads; never load a user's real document into QA evidence."""
import json


def _public_record(index: int) -> dict:
    # Match a reported ~192KiB / 693-line document with strings up to 5KiB.
    # Small JSON fixtures do not exercise long-line layout and highlighting.
    payload_size = 5125 if index == 0 else 4150
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    return {
        "index": index,
        "enabled": index % 2 == 0,
        "label": f"Public synthetic record {index:03}".ljust(35, "."),
        "publicPayload": (alphabet * ((payload_size // len(alphabet)) + 1))[:payload_size],
        "description": "Public long-line JSON workload".ljust(35, "."),
        **{f"field{field:02}": f"Public value {index:03} / {field:02}".ljust(35, ".") for field in range(10)},
    }


LONG_JSON_DOCUMENT = json.dumps({
    "records": [_public_record(index) for index in range(40)],
    **{f"emptyList{index}": [] for index in range(6)},
    "version": 1,
    "note": "Entirely public deterministic test data",
    "description": "Long lines, ordinary JSON, no language service required",
}, indent=2) + "\n"
