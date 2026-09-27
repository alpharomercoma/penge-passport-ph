"""The rate limiter. Same rules and same on-disk state as src/rate-limit.ts, so
Node.js and Python processes of one user share a single budget.

State file (``<state dir>/<host>.json``, all times in epoch milliseconds)::

    {"lastDispatchAt": 0, "dispatched": [], "pauseUntil": 0,
     "consecutiveFailures": 0, "circuitOpenUntil": 0}

Lock (``<state file>.lock``): created exclusively, containing ``<pid>:<token>``.
It is reclaimed only when that pid is gone, after being moved aside and re-read.
"""

from __future__ import annotations

import contextlib
import functools
import json
import math
import os
import random as _random
import re
import sys
import threading
import time
import uuid
import warnings
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Protocol, TypeGuard, TypeVar

from . import _clock
from ._meta import ENV_PREFIX, NAME
from .errors import CircuitOpenError, RateLimitError

T = TypeVar("T")

_HOUR_MS = 60 * 60 * 1000


@dataclass(frozen=True, slots=True)
class Limits:
    """Hard limits. Options can make the client slower than these, never faster.
    Durations are in seconds."""

    #: Smallest allowed gap between two requests to the same host.
    min_interval_floor: float = 2.0
    default_min_interval: float = 3.0
    #: Largest allowed request budget per rolling hour, per host.
    max_requests_per_hour_ceiling: int = 1200
    default_max_requests_per_hour: int = 300
    #: Random extra delay, as a fraction of the interval, so clients don't sync up.
    jitter_ratio: float = 0.25
    #: First pause after a failed request; doubles per consecutive failure.
    backoff_base: float = 5.0
    backoff_max: float = 10 * 60.0
    #: Longest server ``Retry-After`` honoured before it counts as a circuit trip.
    retry_after_max: float = 60 * 60.0
    #: Consecutive failures that open the circuit, and how long it stays open.
    circuit_threshold: int = 5
    circuit_open: float = 15 * 60.0


LIMITS = Limits()


class StateSharingWarning(RuntimeWarning):
    """The limiter could not share its state through the state file and is
    limiting this process only (warning code PENGE_PASSPORT_PH_STATE)."""


def _now_ms() -> float:
    return _clock.now() * 1000


def _mono_ms() -> float:
    return _clock.monotonic() * 1000


@dataclass(slots=True)
class GateState:
    last_dispatch_at: float = 0
    dispatched: list[float] = field(default_factory=list)
    pause_until: float = 0
    consecutive_failures: int = 0
    circuit_open_until: float = 0

    def to_json(self) -> dict[str, Any]:
        return {
            "lastDispatchAt": self.last_dispatch_at,
            "dispatched": self.dispatched,
            "pauseUntil": self.pause_until,
            "consecutiveFailures": self.consecutive_failures,
            "circuitOpenUntil": self.circuit_open_until,
        }


class StateStore(Protocol):
    def update(self, fn: Callable[[GateState], T]) -> T: ...


class MemoryStore:
    def __init__(self) -> None:
        self._state = GateState()

    def update(self, fn: Callable[[GateState], T]) -> T:
        return fn(self._state)


_LOCK_RETRY_S = 0.01
_LOCK_ATTEMPTS = 300
#: A lock whose owner cannot be read (it is being written) counts as dead only after this.
_UNREADABLE_LOCK_GRACE_S = 1.0


class FileStore:
    """Gate state in a JSON file behind a lock file, shared by every process of
    the same user, in either language. If a live process keeps the lock, the
    request is refused (fail closed). Only when the file system itself refuses
    does it warn once and fall back to limiting this process alone."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)
        self._lock = Path(f"{self.path}.lock")
        self._fallback: MemoryStore | None = None

    def update(self, fn: Callable[[GateState], T]) -> T:
        if self._fallback:
            return self._fallback.update(fn)
        try:
            release = _try_lock(self._lock)
            attempts = 0
            while release is None and attempts < _LOCK_ATTEMPTS:
                _clock.sleep(_LOCK_RETRY_S)
                release = _try_lock(self._lock)
                attempts += 1
        except OSError as err:
            return self._degrade(err, fn)
        if release is None:
            raise RateLimitError(f"Another process is holding {self._lock}; retry shortly", 1.0)
        try:
            state = _read_state(self.path, _now_ms())
            result = fn(state)
            tmp = Path(f"{self.path}.{os.getpid()}.tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(state.to_json(), f, separators=(",", ":"))
            os.replace(tmp, self.path)
            return result
        except OSError as err:
            return self._degrade(err, fn)
        finally:
            release()

    def _degrade(self, err: OSError, fn: Callable[[GateState], T]) -> T:
        warnings.warn(
            f"cannot share rate-limit state through {self.path} ({err}); "
            "limiting this process only",
            StateSharingWarning,
            stacklevel=3,
        )
        self._fallback = MemoryStore()
        return self._fallback.update(fn)


def _try_lock(lock: Path, reclaimed: bool = False) -> Callable[[], None] | None:
    """Take the lock, or return None if someone else holds it. Raises OSError on
    file-system errors."""
    token = f"{os.getpid()}:{uuid.uuid4()}"
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if not reclaimed and _reclaim_if_owner_died(lock):
            return _try_lock(lock, reclaimed=True)
        return None
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(token)

    def release() -> None:
        try:
            if lock.read_text(encoding="utf-8") == token:
                lock.unlink()
        except OSError:
            pass  # gone already

    return release


def _reclaim_if_owner_died(lock: Path) -> bool:
    """Remove a lock whose owning process has exited. It is moved aside and
    re-read first, so a live lock that replaced the dead one in the meantime is
    put back instead of deleted."""
    try:
        holder = lock.read_text(encoding="utf-8")
        # File times are real times, so compare with the real clock, not _clock.
        age = time.time() - lock.stat().st_mtime
    except OSError:
        return True  # released in the meantime
    pid_text = holder.split(":", 1)[0]
    if pid_text.isdigit():
        if _process_alive(int(pid_text)):
            return False
    elif age < _UNREADABLE_LOCK_GRACE_S:
        return False  # being written right now
    aside = Path(f"{lock}.{uuid.uuid4()}.dead")
    try:
        os.rename(lock, aside)
    except OSError:
        return False
    removed_dead_lock = True
    try:
        if aside.read_text(encoding="utf-8") != holder:
            removed_dead_lock = False
            os.link(aside, lock)
    except OSError:
        pass  # a newer lock already took the path; leave it
    aside.unlink(missing_ok=True)
    return removed_dead_lock


def _process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        return _windows_process_alive(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _windows_process_alive(pid: int) -> bool:
    # os.kill(pid, 0) would *terminate* the process on Windows; ask the kernel instead.
    import ctypes

    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        code = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return True
        return bool(code.value == 259)  # STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def _read_state(path: Path, now: float) -> GateState:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return GateState()
    # Any other read error propagates: it must not be mistaken for a fresh
    # start, or the shared history would be overwritten.
    try:
        raw = json.loads(text)
    except ValueError:
        raw = None
    if not _is_gate_state(raw):
        # Only this package writes the file, atomically and with every field, so
        # something else damaged it. What was sent in the last hour is unknown:
        # wait until that hour has passed rather than risk sending it all again.
        warnings.warn(
            f"{path} is unreadable; pausing requests for an hour, "
            "since what was sent in the last one is unknown",
            StateSharingWarning,
            stacklevel=4,
        )
        return GateState(pause_until=now + _HOUR_MS)

    # Clamp anything implausible (clock changes, a hand-edited file) so a bad
    # file can neither lift the limits nor block the client for ever.
    horizon = now + (LIMITS.retry_after_max + LIMITS.circuit_open) * 1000
    return GateState(
        last_dispatch_at=min(float(raw["lastDispatchAt"]), now),
        # After the wall clock goes back, records look like the future. They count
        # as "now" rather than vanishing, so a rollback of any size cannot reset
        # the budget; the budget merely stays spent a little longer.
        dispatched=sorted(min(float(t), now) for t in raw["dispatched"] if t > now - _HOUR_MS)[
            -LIMITS.max_requests_per_hour_ceiling :
        ],
        pause_until=min(float(raw["pauseUntil"]), horizon),
        consecutive_failures=max(0, math.floor(raw["consecutiveFailures"])),
        circuit_open_until=min(float(raw["circuitOpenUntil"]), horizon),
    )


def _is_finite_number(v: object) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)


def _is_gate_state(v: object) -> TypeGuard[dict[str, Any]]:
    """Every field present, with the type this package writes."""
    if not isinstance(v, dict):
        return False
    dispatched = v.get("dispatched")
    return (
        all(
            _is_finite_number(v.get(k))
            for k in ("lastDispatchAt", "pauseUntil", "consecutiveFailures", "circuitOpenUntil")
        )
        and isinstance(dispatched, list)
        and all(_is_finite_number(t) for t in dispatched)
    )


@dataclass(frozen=True, slots=True)
class GateOptions:
    min_interval: float
    max_requests_per_hour: int
    #: Longest a call may wait, counted from when it was queued, before it is
    #: refused with RateLimitError instead of being sent.
    max_wait: float


@dataclass(frozen=True, slots=True)
class Outcome:
    ok: bool
    #: Server-supplied ``Retry-After`` in seconds, if any.
    retry_after: float | None = None


Report = Callable[[Outcome], None]


class HostGate:
    """Serialises every request to one host and spaces them out. There is one
    gate per host and state directory per process (see ``gate_for``); with a
    FileStore the spacing and budget are shared with other processes too."""

    def __init__(
        self, store: StateStore | None = None, *, random: Callable[[], float] = _random.random
    ) -> None:
        self._store: StateStore = store or MemoryStore()
        self._random = random
        self._turn = threading.Lock()
        # This process's own record, on the monotonic clock (milliseconds). The
        # shared state uses the wall clock so processes can compare notes, and
        # the wall clock can jump; checking both means a jump can never shorten
        # a wait or reset the budget within a process.
        self._local = GateState(
            last_dispatch_at=-math.inf, pause_until=-math.inf, circuit_open_until=-math.inf
        )

    def run(self, opts: GateOptions, task: Callable[[Report], T]) -> T:
        """Run ``task`` when this host's limits allow it, one at a time. ``task``
        receives ``report`` and must call it with the result of its network
        exchange, so failures feed the backoff and circuit breaker."""
        # NaN or negative max_wait means "don't wait at all".
        max_wait = opts.max_wait if opts.max_wait >= 0 else 0.0
        opts = GateOptions(opts.min_interval, opts.max_requests_per_hour, max_wait)
        queued_at = _mono_ms()
        deadline = queued_at + max_wait * 1000
        wait_for_turn = -1.0 if math.isinf(max_wait) else max_wait
        if not self._turn.acquire(timeout=wait_for_turn):
            raise RateLimitError(
                f"Waited {math.ceil(opts.max_wait)}s for a turn, over max_wait", 0.0
            )
        try:
            self._wait_until_allowed(opts, queued_at, deadline)
            return self._run_task(task)
        finally:
            self._turn.release()

    def penalize(self) -> None:
        """Count a failure detected outside a task (e.g. a rejected session)."""
        now, mono = _now_ms(), _mono_ms()
        self._store.update(lambda s: self._record_failure(s, now, mono))

    def stats(self) -> dict[str, float]:
        """Snapshot for diagnostics: requests in the last hour, failures, pauses (seconds)."""
        now, mono, local = _now_ms(), _mono_ms(), self._local
        return self._store.update(
            lambda s: {
                "requests_last_hour": max(
                    len([t for t in s.dispatched if now - _HOUR_MS < t <= now]),
                    len([t for t in local.dispatched if t > mono - _HOUR_MS]),
                ),
                "consecutive_failures": s.consecutive_failures,
                "paused_for": max(0.0, s.pause_until - now, local.pause_until - mono) / 1000,
                "circuit_open_for": max(
                    0.0, s.circuit_open_until - now, local.circuit_open_until - mono
                )
                / 1000,
            }
        )

    def _wait_until_allowed(self, opts: GateOptions, queued_at: float, deadline: float) -> None:
        jitter = self._random() * LIMITS.jitter_ratio * opts.min_interval * 1000
        while True:
            mono = _mono_ms()
            if mono > deadline:
                raise RateLimitError(
                    f"Waited {math.ceil((mono - queued_at) / 1000)}s in the queue, "
                    f"over max_wait ({math.ceil(opts.max_wait)}s)",
                    0.0,
                )
            decision = self._decide(self._local, mono, opts, jitter, record=False)
            if decision is None:
                decide = functools.partial(
                    self._decide_shared, opts=opts, jitter=jitter, deadline=deadline
                )
                decision = self._store.update(decide)
            if decision is None:
                self._local.last_dispatch_at = mono
                self._local.dispatched.append(mono)
                return
            if isinstance(decision, RateLimitError):
                raise decision
            if mono + decision > deadline:
                raise RateLimitError(
                    f"Next request slot is {math.ceil(decision / 1000)}s away; this call has "
                    f"waited {math.ceil((mono - queued_at) / 1000)}s of its "
                    f"{math.ceil(opts.max_wait)}s max_wait",
                    decision / 1000,
                )
            _clock.sleep(decision / 1000)

    def _run_task(self, task: Callable[[Report], T]) -> T:
        reported = False

        def report(outcome: Outcome) -> None:
            nonlocal reported
            if reported:
                return
            reported = True
            now, mono = _now_ms(), _mono_ms()

            def apply(s: GateState) -> None:
                if outcome.ok:
                    s.consecutive_failures = 0
                else:
                    self._record_failure(s, now, mono, outcome.retry_after)

            # Losing one outcome to a busy lock only weakens backoff slightly.
            with contextlib.suppress(RateLimitError):
                self._store.update(apply)

        try:
            return task(report)
        except Exception:
            # A task that raises without reporting was a transport failure.
            # KeyboardInterrupt is not an Exception, so a caller's Ctrl-C isn't counted.
            report(Outcome(ok=False))
            raise

    def _decide_shared(
        self, s: GateState, opts: GateOptions, jitter: float, deadline: float
    ) -> float | RateLimitError | None:
        """The shared decision. The clocks are read here, while holding the lock:
        waiting for another process's lock can take seconds, and a stale reading
        would back-date this dispatch or send it after its deadline."""
        if _mono_ms() > deadline:
            return RateLimitError("Waited past max_wait for the shared rate-limit state", 0.0)
        return self._decide(s, _now_ms(), opts, jitter)

    def _decide(
        self, s: GateState, now: float, opts: GateOptions, jitter: float, record: bool = True
    ) -> float | RateLimitError | None:
        """None: go now. float: wait this many ms. RateLimitError: refuse.
        Applied to the shared state (wall clock) and to this process's own
        record (monotonic clock, ``record=False``)."""
        if s.circuit_open_until > now:
            wait = s.circuit_open_until - now
            return CircuitOpenError(
                f"Paused after {s.consecutive_failures} consecutive failures; "
                f"retry in {math.ceil(wait / 1000)}s",
                wait / 1000,
            )
        # Entries after ``now`` mean the wall clock went back; they still count, as now.
        s.dispatched = [min(t, now) for t in s.dispatched if t > now - _HOUR_MS]
        if len(s.dispatched) >= opts.max_requests_per_hour:
            wait = max(0.0, min(s.dispatched) + _HOUR_MS - now)
            return RateLimitError(
                f"Hourly budget of {opts.max_requests_per_hour} requests used; "
                f"retry in {math.ceil(wait / 1000)}s",
                wait / 1000,
            )
        last = min(s.last_dispatch_at, now)
        ready_at = max(last + opts.min_interval * 1000 + jitter, s.pause_until)
        if ready_at > now:
            return ready_at - now
        if record:
            s.last_dispatch_at = now
            s.dispatched.append(now)
        return None

    def _record_failure(
        self, s: GateState, now: float, mono: float, retry_after: float | None = None
    ) -> None:
        # Only a finite, non-negative Retry-After means anything.
        wait = retry_after if retry_after is not None and 0 <= retry_after < math.inf else 0.0
        s.consecutive_failures += 1
        backoff = min(LIMITS.backoff_base * 2 ** (s.consecutive_failures - 1), LIMITS.backoff_max)
        honoured = min(wait, LIMITS.retry_after_max)
        pause = max(backoff, honoured) * 1000
        s.pause_until = max(s.pause_until, now + pause)
        self._local.pause_until = max(self._local.pause_until, mono + pause)
        if s.consecutive_failures >= LIMITS.circuit_threshold or wait > LIMITS.retry_after_max:
            open_for = max(LIMITS.circuit_open, honoured) * 1000
            s.circuit_open_until = now + open_for
            self._local.circuit_open_until = mono + open_for


def default_state_dir() -> Path:
    """``PENGE_PASSPORT_PH_STATE_DIR``, else ``$XDG_STATE_HOME/penge-passport-ph``,
    else ``%LOCALAPPDATA%`` on Windows, else ``~/.local/state/penge-passport-ph``.
    The same directory the Node.js package uses."""
    explicit = os.environ.get(f"{ENV_PREFIX}STATE_DIR")
    if explicit:
        return Path(explicit)
    xdg = os.environ.get("XDG_STATE_HOME")
    if xdg:
        base = Path(xdg)
    elif sys.platform == "win32" and os.environ.get("LOCALAPPDATA"):
        base = Path(os.environ["LOCALAPPDATA"])
    else:
        base = Path.home() / ".local" / "state"
    return base / NAME


_gates: dict[tuple[str, str], HostGate] = {}
_gates_lock = threading.Lock()


def gate_for(host: str, state_dir: str | os.PathLike[str]) -> HostGate:
    """The gate for ``host``, shared by every client in this process using ``state_dir``."""
    key = (os.fspath(state_dir), host)
    with _gates_lock:
        gate = _gates.get(key)
        if gate is None:
            store: StateStore
            try:
                Path(state_dir).mkdir(parents=True, exist_ok=True, mode=0o700)
                safe = "".join(c if c.isalnum() or c in ".-" else "_" for c in host)
                store = FileStore(Path(state_dir) / f"{safe}.json")
            except OSError as err:
                warnings.warn(
                    f"cannot create {state_dir} ({err}); limiting this process only",
                    StateSharingWarning,
                    stacklevel=2,
                )
                store = MemoryStore()
            gate = HostGate(store)
            _gates[key] = gate
        return gate


def resolve_limits(
    min_interval: float | None, max_requests_per_hour: int | None
) -> tuple[float, int]:
    """Validate caller limits against the hard floors. Raises rather than
    silently clamping, so a misconfiguration is visible."""
    interval = LIMITS.default_min_interval if min_interval is None else min_interval
    budget = (
        LIMITS.default_max_requests_per_hour
        if max_requests_per_hour is None
        else max_requests_per_hour
    )
    if not math.isfinite(interval) or interval < LIMITS.min_interval_floor:
        raise ValueError(
            f"min_interval must be at least {LIMITS.min_interval_floor} seconds (got {interval})"
        )
    if (
        isinstance(budget, bool)
        or not isinstance(budget, int)
        or not 1 <= budget <= LIMITS.max_requests_per_hour_ceiling
    ):
        raise ValueError(
            "max_requests_per_hour must be an integer from 1 to "
            f"{LIMITS.max_requests_per_hour_ceiling} (got {budget})"
        )
    return interval, budget


_DIGITS = re.compile(r"[0-9]+")
_HTTP_DATE = re.compile(
    r"[A-Za-z]{3}, ([0-9]{2})[ -]([A-Za-z]{3})[ -]([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT"
)
_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
#: Seconds; anything longer is treated as this (and trips the circuit breaker).
_RETRY_AFTER_CAP_S = 1_000_000_000


def parse_retry_after(value: str | None) -> float | None:
    """Parse an HTTP ``Retry-After`` into seconds: delta-seconds (digits only),
    or an HTTP date with a four-digit year. Anything else (negative, fractional,
    "inf", a malformed date) is ignored, exactly as in the Node.js package."""
    if not value:
        return None
    v = value.strip(" \t\n\v\f\r\u00a0\ufeff")
    if _DIGITS.fullmatch(v):
        return float(min(int(v), _RETRY_AFTER_CAP_S))
    at = parse_http_date(v)
    return None if at is None else max(0.0, at / 1000 - _clock.now())


def parse_http_date(value: str) -> float | None:
    """``Sat, 26 Sep 2026 13:59:32 GMT`` (IMF-fixdate) or the dashed
    ``Sat, 26-Sep-2026 13:59:32 GMT`` cookies use, to epoch milliseconds.
    Computed arithmetically so both languages agree."""
    m = _HTTP_DATE.fullmatch(value)
    if not m:
        return None
    day, name, year, hour, minute, second = m.groups()
    month = _MONTHS.index(name.lower()) if name.lower() in _MONTHS else -1
    y, d, h, mi, sec = int(year), int(day), int(hour), int(minute), int(second)
    leap = (y % 4 == 0 and y % 100 != 0) or y % 400 == 0
    days = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if month < 0 or y < 1 or not 1 <= d <= days[month] or h > 23 or mi > 59 or sec > 60:
        return None
    epoch_days = (date(y, month + 1, d) - date(1970, 1, 1)).days
    return float(((epoch_days * 24 + h) * 60 + mi) * 60_000 + sec * 1000)
