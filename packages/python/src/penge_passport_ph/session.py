"""A minimal cookie jar for one origin, and session freshness rules."""

from __future__ import annotations

import re
from dataclasses import dataclass

from . import _clock
from .rate_limit import parse_http_date

_MAX_AGE = re.compile(r"-?[0-9]+")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

#: The site logs idle visitors out after 10 minutes; refresh a little before that.
SESSION_IDLE_S = 9 * 60
SESSION_MAX_AGE_S = 60 * 60


class CookieJar:
    """The site sets only a few path=/ cookies (anti-forgery token, load
    balancer affinity), so domain and path matching are not needed."""

    def __init__(self) -> None:
        self._cookies: dict[str, tuple[str, float]] = {}

    def store(self, set_cookie_headers: list[str]) -> None:
        now = _clock.now()
        for line in set_cookie_headers:
            pair, *attrs = line.split(";")
            name, eq, value = pair.partition("=")
            name, value = name.strip(), value.strip()
            # A control character (CR, LF, NUL…) would break or inject into our own Cookie header.
            if not eq or not name or _CONTROL.search(name) or _CONTROL.search(value):
                continue
            expires_at = float("inf")
            max_age_seen = False
            for attr in attrs:
                key, _, val = attr.partition("=")
                key, val = key.strip().lower(), val.strip()
                # RFC 6265: Max-Age is an optionally negative integer and wins over Expires.
                if key == "max-age" and _MAX_AGE.fullmatch(val):
                    expires_at = now + max(-1, min(int(val), 10**9))
                    max_age_seen = True
                elif key == "expires" and not max_age_seen:
                    at = parse_http_date(val)
                    if at is not None:
                        expires_at = at / 1000
            if expires_at <= now:
                self._cookies.pop(name, None)
            else:
                self._cookies[name] = (value, expires_at)

    def header(self) -> str | None:
        now = _clock.now()
        for name in [n for n, (_, exp) in self._cookies.items() if exp <= now]:
            del self._cookies[name]
        parts = [f"{name}={value}" for name, (value, _) in self._cookies.items()]
        return "; ".join(parts) or None

    def clear(self) -> None:
        self._cookies.clear()


@dataclass(slots=True)
class Session:
    token: str
    server_today: str | None
    max_date: str | None
    created_at: float
    last_used_at: float

    def is_fresh(self, now: float) -> bool:
        return (
            now - self.last_used_at < SESSION_IDLE_S and now - self.created_at < SESSION_MAX_AGE_S
        )
