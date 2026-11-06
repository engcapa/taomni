"""Fresh, read-only WebDriver element counts during asynchronous DOM removal."""
from __future__ import annotations

from typing import Any, Protocol

from native_webdriver_transport import WebDriverError
from qa_ui_auto.deadline import Deadline, budget_time


class QuerySession(Protocol):
    deadline: Deadline | None

    def endpoint(self, suffix: str) -> str: ...
    def request(self, method: str, path: str, payload: dict) -> Any: ...


def count_elements(session: QuerySession, selector: str, strategy: tuple[str, str]) -> int:
    """Retry only a rejected stale read, never state-changing input or transport errors."""
    using, value = strategy
    for attempt in range(3):
        if session.deadline is not None:
            session.deadline.remaining()
        try:
            elements = session.request("POST", session.endpoint("/elements"),
                                       {"using": using, "value": value})
        except WebDriverError as error:
            if "stale element" not in str(error).lower() or attempt == 2:
                raise
            budget_time.sleep(0.1)
            continue
        if not isinstance(elements, list):
            raise WebDriverError(f"invalid element list for {selector}: {elements!r}")
        return len(elements)
    raise AssertionError("element query exhausted without a result or error")
