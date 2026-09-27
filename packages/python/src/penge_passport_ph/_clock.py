"""The package's only source of time. Tests replace ``now`` and ``sleep``
with a fake clock (see tests/conftest.py), like fake timers in the JS tests."""

from __future__ import annotations

import time


def now() -> float:
    """Wall-clock seconds since the epoch. Wall clock, not monotonic, because the
    rate-limit state file is shared with other processes (and the Node.js package)."""
    return time.time()


def monotonic() -> float:
    """Seconds on a clock that never jumps; for limits within this process."""
    return time.monotonic()


def sleep(seconds: float) -> None:
    time.sleep(seconds)
