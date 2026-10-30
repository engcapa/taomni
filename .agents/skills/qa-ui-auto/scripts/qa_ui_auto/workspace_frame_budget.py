"""Workspace frame acceptance: 150ms baseline plus the approved 10% tolerance.

Only individual frame latency uses this tolerance. Content/action deadlines and
the real SDK process timeout retain their original limits.
"""

FRAME_BUDGET_MS = 150
FRAME_TOLERANCE_PERCENT = 10
FRAME_LIMIT_MS = FRAME_BUDGET_MS * (100 + FRAME_TOLERANCE_PERCENT) / 100
