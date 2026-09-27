from __future__ import annotations

import functools
import threading

import pytest

from penge_passport_ph.cache import TtlCache

from .conftest import FakeClock


def test_does_not_cache_failures(clock: FakeClock) -> None:
    cache: TtlCache[int] = TtlCache()
    calls = {"n": 0}

    def flaky() -> int:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("boom")
        return 7

    with pytest.raises(RuntimeError):
        cache.get("k", 1, flaky)
    assert cache.get("k", 1, flaky) == (7, False)
    assert cache.get("k", 1, flaky) == (7, True)
    assert calls["n"] == 2


def test_expires_after_the_ttl(clock: FakeClock) -> None:
    cache: TtlCache[str] = TtlCache()
    cache.get("k", 60, lambda: "a")
    clock.advance(59)
    assert cache.get("k", 60, lambda: "b") == ("a", True)
    clock.advance(2)
    assert cache.get("k", 60, lambda: "b") == ("b", False)


def test_evicts_the_oldest_entry(clock: FakeClock) -> None:
    cache: TtlCache[str] = TtlCache(max_entries=2)
    for key in "abc":
        cache.get(key, 60, functools.partial(str, key))
    assert cache.get("a", 60, lambda: "a2") == ("a2", False)


def test_never_evicts_a_load_still_in_flight(clock: FakeClock) -> None:
    cache: TtlCache[str] = TtlCache(max_entries=1)
    started, release = threading.Event(), threading.Event()
    calls: list[str] = []

    def slow() -> str:
        calls.append("slow")
        started.set()
        release.wait(5)
        return "done"

    results: list[tuple[str, bool]] = []
    first = threading.Thread(target=lambda: results.append(cache.get("slow", 60, slow)))
    first.start()
    started.wait(5)
    cache.get("other", 60, lambda: "x")  # over the limit, while "slow" is still loading
    second = threading.Thread(target=lambda: results.append(cache.get("slow", 60, slow)))
    second.start()
    release.set()
    first.join(5)
    second.join(5)
    assert calls == ["slow"]
    assert sorted(results) == [("done", False), ("done", True)]
