"""HostGate and FileStore, ported from test/rate-limit.test.ts."""

from __future__ import annotations

import json
import os
import threading
import time
import warnings
from collections.abc import Callable
from pathlib import Path

import pytest

from penge_passport_ph import _clock
from penge_passport_ph.errors import CircuitOpenError, RateLimitError
from penge_passport_ph.rate_limit import (
    LIMITS,
    FileStore,
    GateOptions,
    HostGate,
    Outcome,
    Report,
    StateSharingWarning,
    parse_retry_after,
    resolve_limits,
)

from .conftest import FakeClock

OPTS = GateOptions(min_interval=3.0, max_requests_per_hour=300, max_wait=60.0)


def no_jitter() -> float:
    return 0.0


def ok(report: Report) -> None:
    report(Outcome(ok=True))


OK = Outcome(ok=True)


def recorder(
    clock: FakeClock, started: list[float], outcome: Outcome = OK
) -> Callable[[Report], None]:
    def task(report: Report) -> None:
        started.append(clock.now())
        report(outcome)

    return task


def offsets(started: list[float]) -> list[float]:
    return [round(t - started[0], 3) for t in started]


def test_spaces_requests_by_the_interval(clock: FakeClock) -> None:
    gate = HostGate(random=no_jitter)
    started: list[float] = []
    for _ in range(3):
        gate.run(OPTS, recorder(clock, started))
    assert offsets(started) == [0, 3, 6]


def test_adds_up_to_a_quarter_interval_of_jitter(clock: FakeClock) -> None:
    gate = HostGate(random=lambda: 1.0)
    started: list[float] = []
    gate.run(OPTS, recorder(clock, started))
    gate.run(OPTS, recorder(clock, started))
    assert offsets(started) == [0, 3.75]


def test_refuses_once_the_hourly_budget_is_spent(clock: FakeClock) -> None:
    gate = HostGate(random=no_jitter)
    small = GateOptions(3.0, 2, 60.0)
    gate.run(small, ok)
    gate.run(small, ok)
    clock.advance(2)  # it is now t = 5 s
    with pytest.raises(RateLimitError) as err:
        gate.run(small, ok)
    assert err.value.retry_after == pytest.approx(3600 - 5)


def test_backs_off_exponentially_after_failures(clock: FakeClock) -> None:
    gate = HostGate(random=no_jitter)
    started: list[float] = []
    for _ in range(3):
        gate.run(OPTS, recorder(clock, started, Outcome(ok=False)))
    assert offsets(started) == [0, 5, 15]


def test_honours_retry_after_when_longer_than_backoff(clock: FakeClock) -> None:
    gate = HostGate(random=no_jitter)
    started: list[float] = []
    gate.run(OPTS, recorder(clock, started, Outcome(ok=False, retry_after=45)))
    gate.run(OPTS, recorder(clock, started))
    assert offsets(started) == [0, 45]


def test_refuses_instead_of_waiting_past_max_wait(clock: FakeClock) -> None:
    gate = HostGate(random=no_jitter)
    gate.run(OPTS, lambda report: report(Outcome(ok=False, retry_after=120)))
    with pytest.raises(RateLimitError) as err:
        gate.run(OPTS, ok)
    assert err.value.retry_after == pytest.approx(120)


def test_refuses_a_call_whose_deadline_passed_while_queued(
    clock: FakeClock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A call that waited behind a slow one past max_wait is refused, not sent
    late, even though the gate is free by the time its turn comes."""
    gate = HostGate(random=no_jitter)
    a_running, b_queued = threading.Event(), threading.Event()
    b_thread: list[int] = []
    outcome: dict[str, str] = {}

    def spy() -> float:
        # The second call reads the clock to note when it was queued; only then
        # may the slow request finish, so the order never depends on timing.
        if b_thread and threading.get_ident() == b_thread[0]:
            b_queued.set()
        return clock.monotonic()

    monkeypatch.setattr(_clock, "monotonic", spy)

    def slow(report: Report) -> None:
        a_running.set()
        assert b_queued.wait(5)
        time.sleep(0.05)  # real time: let B reach its wait for a turn
        clock.advance(70)  # the slow request takes 70 s
        report(Outcome(ok=True))

    def second() -> None:
        b_thread.append(threading.get_ident())
        try:
            gate.run(OPTS, ok)
            outcome["b"] = "sent"
        except RateLimitError:
            outcome["b"] = "refused"

    first = threading.Thread(target=gate.run, args=(OPTS, slow))
    first.start()
    assert a_running.wait(5)
    other = threading.Thread(target=second)
    other.start()
    first.join(10)
    other.join(10)
    assert outcome == {"b": "refused"}


def test_opens_the_circuit_then_closes_it_after_the_cool_down(clock: FakeClock) -> None:
    gate = HostGate(random=no_jitter)
    patient = GateOptions(3.0, 300, float("inf"))
    for _ in range(LIMITS.circuit_threshold):
        gate.run(patient, lambda report: report(Outcome(ok=False)))
    with pytest.raises(CircuitOpenError):
        gate.run(patient, ok)
    clock.advance(LIMITS.circuit_open)

    def succeed(report: Report) -> str:
        report(OK)
        return "ran"

    assert gate.run(patient, succeed) == "ran"
    assert gate.stats()["consecutive_failures"] == 0


def test_counts_a_raised_transport_error_as_a_failure(clock: FakeClock) -> None:
    gate = HostGate(random=no_jitter)

    def boom(report: Report) -> None:
        raise OSError("connection refused")

    with pytest.raises(OSError):
        gate.run(OPTS, boom)
    assert gate.stats()["consecutive_failures"] == 1


def test_does_not_count_ctrl_c_as_a_failure(clock: FakeClock) -> None:
    gate = HostGate(random=no_jitter)

    def interrupted(report: Report) -> None:
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        gate.run(OPTS, interrupted)
    assert gate.stats()["consecutive_failures"] == 0


def test_resolve_limits_allows_slower_never_faster() -> None:
    assert resolve_limits(None, None) == (3.0, 300)
    assert resolve_limits(10.0, 60) == (10.0, 60)
    cases: list[tuple[float | None, int | None]] = [
        (1.999, None),
        (float("nan"), None),
        (None, 1201),
        (None, 0),
        (None, True),
    ]
    for interval, budget in cases:
        with pytest.raises(ValueError):
            resolve_limits(interval, budget)


def test_parse_retry_after(clock: FakeClock) -> None:
    assert parse_retry_after("30") == 30
    assert parse_retry_after(None) is None
    assert parse_retry_after("soon") is None


# -- shared state file (separate processes, and the Node.js package) ----------


def shared(tmp_path: Path) -> Path:
    return tmp_path / "host.json"


def test_keeps_one_spacing_across_gates_that_only_share_the_file(
    clock: FakeClock, tmp_path: Path
) -> None:
    path = shared(tmp_path)
    a = HostGate(FileStore(path), random=no_jitter)
    b = HostGate(FileStore(path), random=no_jitter)
    started: list[float] = []
    for gate in (a, b, a, b):
        gate.run(OPTS, recorder(clock, started))
    assert offsets(started) == [0, 3, 6, 9]


def test_shares_the_hourly_budget_and_the_backoff(clock: FakeClock, tmp_path: Path) -> None:
    path = shared(tmp_path)
    a = HostGate(FileStore(path), random=no_jitter)
    b = HostGate(FileStore(path), random=no_jitter)
    small = GateOptions(3.0, 2, 60.0)
    a.run(small, ok)
    a.run(small, ok)
    with pytest.raises(RateLimitError):
        b.run(small, ok)

    other = tmp_path / "other.json"
    c = HostGate(FileStore(other), random=no_jitter)
    d = HostGate(FileStore(other), random=no_jitter)
    c.run(OPTS, lambda report: report(Outcome(ok=False, retry_after=90)))
    stats = d.stats()
    assert stats["consecutive_failures"] == 1
    assert stats["paused_for"] == pytest.approx(90)


def test_keeps_the_budget_spent_after_the_clock_goes_back_hours(
    clock: FakeClock, tmp_path: Path
) -> None:
    path = shared(tmp_path)
    a = HostGate(FileStore(path), random=no_jitter)
    small = GateOptions(3.0, 2, 60.0)
    a.run(small, ok)
    a.run(small, ok)
    clock.t -= 2 * 3600  # the wall clock jumps back two hours
    fresh = HostGate(FileStore(path), random=no_jitter)  # another process: no local memory
    with pytest.raises(RateLimitError):
        fresh.run(small, ok)


def test_rereads_the_clock_after_waiting_for_another_process_lock(
    clock: FakeClock, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = shared(tmp_path)
    lock = Path(f"{path}.lock")
    lock.write_text(f"{os.getpid()}:someone-else")
    waits = {"n": 0}

    def sleep(seconds: float) -> None:
        clock.sleep(seconds)
        waits["n"] += 1
        if waits["n"] == 50:  # the other process lets go after 500 ms
            lock.unlink()

    monkeypatch.setattr(_clock, "sleep", sleep)
    gate = HostGate(FileStore(path), random=no_jitter)
    with pytest.raises(RateLimitError):
        gate.run(GateOptions(3.0, 300, 0.1), ok)
    assert gate.stats()["requests_last_hour"] == 0  # nothing recorded as sent


def test_writes_the_same_json_the_node_package_reads(clock: FakeClock, tmp_path: Path) -> None:
    path = shared(tmp_path)
    HostGate(FileStore(path), random=no_jitter).run(OPTS, ok)
    state = json.loads(path.read_text())
    assert set(state) == {
        "lastDispatchAt",
        "dispatched",
        "pauseUntil",
        "consecutiveFailures",
        "circuitOpenUntil",
    }
    assert state["dispatched"] == [clock.now() * 1000]


def test_clamps_implausible_values_in_a_well_formed_state_file(
    clock: FakeClock, tmp_path: Path
) -> None:
    path = shared(tmp_path)
    future = clock.now() * 1000 + 10 * 3600 * 1000
    path.write_text(
        json.dumps(
            {
                "lastDispatchAt": 9e15,
                "pauseUntil": 9e15,
                "consecutiveFailures": 2,
                "circuitOpenUntil": 9e15,
                "dispatched": [future],
            }
        )
    )
    stats = HostGate(FileStore(path), random=no_jitter).stats()
    assert stats["paused_for"] <= LIMITS.retry_after_max + LIMITS.circuit_open
    assert stats["requests_last_hour"] == 1  # a record from "the future" counts as now


_VALID = {
    "lastDispatchAt": 0,
    "pauseUntil": 0,
    "consecutiveFailures": 0,
    "circuitOpenUntil": 0,
    "dispatched": [],
}


@pytest.mark.parametrize(
    "text",
    [
        "{not json",
        "null",
        "[]",
        "7",
        json.dumps({**_VALID, "dispatched": "x"}),
        json.dumps({**_VALID, "dispatched": [1, "x"]}),
        json.dumps({**_VALID, "pauseUntil": "0"}),
        json.dumps({k: v for k, v in _VALID.items() if k != "consecutiveFailures"}),
    ],
)
def test_waits_out_the_hour_when_the_state_file_is_unreadable(
    clock: FakeClock, tmp_path: Path, text: str
) -> None:
    path = shared(tmp_path)
    path.write_text(text)
    # What was sent in the last hour is unknown, so nothing is sent until it has passed.
    with pytest.warns(StateSharingWarning, match="unreadable"):
        paused = HostGate(FileStore(path), random=no_jitter).stats()["paused_for"]
    assert 3599 < paused <= 3600


def test_reclaims_a_lock_whose_owner_died(clock: FakeClock, tmp_path: Path) -> None:
    path = shared(tmp_path)
    Path(f"{path}.lock").write_text("999999999:dead-token")
    gate = HostGate(FileStore(path), random=no_jitter)
    gate.run(OPTS, ok)
    assert gate.stats()["requests_last_hour"] == 1
    assert not Path(f"{path}.lock").exists()


def test_fails_closed_while_a_live_process_holds_the_lock(clock: FakeClock, tmp_path: Path) -> None:
    path = shared(tmp_path)
    Path(f"{path}.lock").write_text(f"{os.getpid()}:someone-else")
    gate = HostGate(FileStore(path), random=no_jitter)
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # any silent downgrade would raise here
        with pytest.raises(RateLimitError):
            gate.run(OPTS, ok)


def test_treats_an_unwritten_lock_as_busy_not_dead(clock: FakeClock, tmp_path: Path) -> None:
    path = shared(tmp_path)
    Path(f"{path}.lock").write_text("")  # created a moment ago, not written yet
    with pytest.raises(RateLimitError):
        HostGate(FileStore(path), random=no_jitter).run(OPTS, ok)


@pytest.mark.skipif(
    hasattr(os, "getuid") and os.getuid() == 0, reason="root reads through chmod 000"
)
def test_does_not_overwrite_a_state_file_it_cannot_read(clock: FakeClock, tmp_path: Path) -> None:
    path = shared(tmp_path)
    history = json.dumps({"lastDispatchAt": clock.now() * 1000, "dispatched": [clock.now() * 1000]})
    path.write_text(history)
    path.chmod(0)
    try:
        with pytest.warns(StateSharingWarning):
            HostGate(FileStore(path), random=no_jitter).run(OPTS, ok)
    finally:
        path.chmod(0o600)
    assert path.read_text() == history


def test_falls_back_with_a_warning_when_the_file_cannot_be_written(clock: FakeClock) -> None:
    gate = HostGate(FileStore("/dev/null/not-a-dir/host.json"), random=no_jitter)
    with pytest.warns(StateSharingWarning):
        gate.run(OPTS, ok)
    assert gate.stats()["requests_last_hour"] == 1
