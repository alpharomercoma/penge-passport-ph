"""TTL cache with in-flight de-duplication: concurrent calls for the same key,
from any thread, share one upstream request. Failed loads are not cached."""

from __future__ import annotations

import threading
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass, field
from typing import Generic, TypeVar

from . import _clock

V = TypeVar("V")


@dataclass(slots=True)
class _Entry(Generic[V]):
    future: Future[V] = field(default_factory=Future)
    #: Infinity while the load is in flight.
    expires_at: float = float("inf")


class TtlCache(Generic[V]):
    def __init__(self, max_entries: int = 500) -> None:
        self._max_entries = max_entries
        self._entries: dict[str, _Entry[V]] = {}
        self._lock = threading.Lock()

    def get(self, key: str, ttl: float, load: Callable[[], V]) -> tuple[V, bool]:
        """Return ``(value, hit)``. ``hit`` is True when no new request was made."""
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None and entry.expires_at > _clock.now():
                owner = False
            else:
                entry = _Entry()
                self._entries.pop(key, None)
                self._entries[key] = entry
                # The oldest finished entries go first; a load still in flight
                # stays, or a second caller would send the same request again.
                for k in [k for k, e in self._entries.items() if e.expires_at != float("inf")]:
                    if len(self._entries) <= self._max_entries:
                        break
                    del self._entries[k]
                owner = True
        if not owner:
            return entry.future.result(), True
        try:
            value = load()
        except BaseException as err:
            with self._lock:
                if self._entries.get(key) is entry:
                    del self._entries[key]
            entry.future.set_exception(err)
            raise
        with self._lock:
            entry.expires_at = _clock.now() + ttl
        entry.future.set_result(value)
        return value, False

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
