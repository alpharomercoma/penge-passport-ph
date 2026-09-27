"""PengePassportPH: the read-only client. Mirrors src/client.ts."""

from __future__ import annotations

import math
import random
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta, timezone
from typing import Any, Literal, TypeVar
from urllib.parse import urlsplit

from . import _clock
from ._meta import HOMEPAGE, NAME, VERSION
from .cache import TtlCache
from .errors import RateLimitError, SessionError, UpstreamError
from .models import (
    PHILIPPINES_COUNTRY_ID,
    PHILIPPINES_REGION_ID,
    REGIONS,
    Availability,
    Country,
    DayAvailability,
    Region,
    Site,
    TimeSlot,
)
from .parse import (
    is_iso_date,
    parse_availability,
    parse_bootstrap,
    parse_countries,
    parse_json,
    parse_sites,
    parse_time_slots,
)
from .rate_limit import (
    GateOptions,
    Outcome,
    Report,
    default_state_dir,
    gate_for,
    parse_retry_after,
    resolve_limits,
)
from .session import SESSION_IDLE_S, SESSION_MAX_AGE_S, CookieJar, Session

T = TypeVar("T")

DEFAULT_BASE_URL = "https://passport.gov.ph"

#: Endpoints, as named in the site's own scripts.
ENDPOINTS = {
    "bootstrap": "/appointment",
    "countries": "/countries",
    "sites": "/sites",
    "availability": "/appointment/timeslot/available",
    "time_slots": "/appointment/timeslot",
}

_MIN_AVAILABILITY_TTL = 30.0
_MIN_WATCH_INTERVAL = 60.0
#: If the site has no booking horizon on the page, look this far ahead.
_FALLBACK_HORIZON_DAYS = 180
_HOUR = 3600.0
#: The Philippines has no daylight saving time.
_MANILA = timezone(timedelta(hours=8))


@dataclass(frozen=True, slots=True)
class HttpRequest:
    method: Literal["GET", "POST"]
    url: str
    headers: dict[str, str]
    body: bytes | None
    timeout: float


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    #: All headers, repeated names included (the site sends several Set-Cookie).
    headers: list[tuple[str, str]]
    text: str

    def header(self, name: str) -> str | None:
        return next((v for k, v in self.headers if k.lower() == name.lower()), None)


Transport = Callable[[HttpRequest], HttpResponse]
"""Sends one request. Raise OSError for network failures; return any HTTP status."""


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """A followed redirect would be a second request the limiter never saw,
    possibly to another host. The site's endpoints never redirect."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None  # urllib then raises HTTPError with the 3xx status


_OPENER = urllib.request.build_opener(_NoRedirects)


def urllib_transport(request: HttpRequest) -> HttpResponse:
    """The default transport: the standard library, no dependencies."""
    req = urllib.request.Request(
        request.url, data=request.body, headers=request.headers, method=request.method
    )
    try:
        with _OPENER.open(req, timeout=request.timeout) as res:
            return HttpResponse(res.status, list(res.headers.items()), _decode(res.read()))
    except urllib.error.HTTPError as err:
        return HttpResponse(err.code, list(err.headers.items()), _decode(err.read()))


def _decode(raw: bytes) -> str:
    # Always UTF-8, as fetch's text() does whatever the declared charset, so both
    # packages read the same bytes the same way; a byte-order mark is dropped.
    return raw.decode("utf-8-sig", "replace")


@dataclass(frozen=True, slots=True)
class AvailabilityEvent:
    site_id: int
    availability: Availability
    #: Dates that became available since the previous round.
    opened: tuple[str, ...]
    #: Dates that stopped being available since the previous round.
    closed: tuple[str, ...]
    #: First result for this site in this watch.
    initial: bool
    type: Literal["availability"] = "availability"

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "siteId": self.site_id,
            "availability": self.availability.to_dict(),
            "opened": list(self.opened),
            "closed": list(self.closed),
            "initial": self.initial,
        }


@dataclass(frozen=True, slots=True)
class ErrorEvent:
    site_id: int
    error: Exception
    type: Literal["error"] = "error"

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.type, "siteId": self.site_id, "error": str(self.error)}


WatchEvent = AvailabilityEvent | ErrorEvent


class _Empty:
    """Marker for the empty 200 the site sends for a rejected anti-forgery token."""


_EMPTY = _Empty()


def user_agent(contact: str | None = None) -> str:
    """The User-Agent every request carries: product/version, where to read
    about it, and optionally how to reach whoever runs it."""
    tail = f"; {contact}" if contact else ""
    return f"{NAME}/{VERSION} (+{HOMEPAGE}; read-only availability checker{tail})"


class PengePassportPH:
    """Read-only client for passport.gov.ph appointment availability.

    Every request goes through the shared rate limiter; nothing here can select
    or reserve a time slot. Durations are in seconds. Safe to share between
    threads.
    """

    def __init__(
        self,
        *,
        base_url: str = DEFAULT_BASE_URL,
        contact: str | None = None,
        min_interval: float | None = None,
        max_requests_per_hour: int | None = None,
        max_wait: float = 60.0,
        availability_ttl: float = 60.0,
        directory_ttl: float = 6 * _HOUR,
        timeout: float = 20.0,
        state_dir: str | None = None,
        transport: Transport | None = None,
    ) -> None:
        """
        Args:
            base_url: Site root.
            contact: Your email or URL, added to the User-Agent.
            min_interval: Gap between requests. At least 2 s, default 3 s.
            max_requests_per_hour: Rolling-hour budget per host, shared by every
                process of this user (Python and Node.js). At most 1200, default 300.
            max_wait: Longest a call may wait in the queue before it is refused
                with RateLimitError.
            availability_ttl: How long availability and time-slot answers are
                reused. At least 30 s.
            directory_ttl: How long country and site lists are reused.
            timeout: Per-request timeout.
            state_dir: Where the limiter shares its state between processes.
                Default: ``default_state_dir()``.
            transport: Custom HTTP transport (proxies, tests). Requests still
                pass through the rate limiter.
        """
        parts = urlsplit(base_url)
        if not parts.scheme or not parts.netloc:
            raise ValueError(f"base_url must be an absolute URL (got {base_url!r})")
        self._base_url = f"{parts.scheme}://{parts.netloc}"
        self._min_interval, self._max_per_hour = resolve_limits(min_interval, max_requests_per_hour)
        if not max_wait >= 0:
            raise ValueError(f"max_wait must be 0 or more seconds (got {max_wait})")
        if contact is not None:
            assert_contact(contact)
        if availability_ttl < _MIN_AVAILABILITY_TTL:
            raise ValueError(f"availability_ttl must be at least {_MIN_AVAILABILITY_TTL} seconds")
        self._max_wait = max_wait
        self._availability_ttl = availability_ttl
        self._directory_ttl = directory_ttl
        self._timeout = timeout
        self._user_agent = user_agent(contact)
        self._transport = transport or urllib_transport
        self._jar = CookieJar()
        self._cache: TtlCache[Any] = TtlCache()
        self._session: Session | None = None
        self._session_lock = threading.Lock()
        self._gate = gate_for(parts.netloc, state_dir or default_state_dir())

    # -- directory ---------------------------------------------------------

    def regions(self) -> tuple[Region, ...]:
        return REGIONS

    def countries(self, region_id: int) -> list[Country]:
        _assert_positive_int(region_id, "region_id")
        path = ENDPOINTS["countries"]
        value, _ = self._cache.get(
            f"countries:{region_id}",
            self._directory_ttl,
            lambda: self._send(
                "POST",
                path,
                lambda text: parse_countries(parse_json(text, path), path),
                form={"regionId": region_id},
            ),
        )
        return list(value)

    def sites(
        self, region_id: int = PHILIPPINES_REGION_ID, country_id: int = PHILIPPINES_COUNTRY_ID
    ) -> list[Site]:
        """Sites for a region and country. Defaults to the Philippines."""
        _assert_positive_int(region_id, "region_id")
        _assert_positive_int(country_id, "country_id")
        path = ENDPOINTS["sites"]
        value, _ = self._cache.get(
            f"sites:{region_id}:{country_id}",
            self._directory_ttl,
            lambda: self._send(
                "POST",
                path,
                lambda text: parse_sites(parse_json(text, path), path),
                form={"regionId": region_id, "countryId": country_id},
            ),
        )
        return list(value)

    def find_sites(
        self,
        text: str,
        region_id: int = PHILIPPINES_REGION_ID,
        country_id: int = PHILIPPINES_COUNTRY_ID,
    ) -> list[Site]:
        """Case-insensitive search over site names and descriptions."""
        needle = text.strip().lower()
        return [
            s
            for s in self.sites(region_id, country_id)
            if needle in s.name.lower() or needle in (s.description or "").lower()
        ]

    # -- availability ------------------------------------------------------

    def availability(
        self,
        site_id: int,
        *,
        applicants: int = 1,
        from_date: str | None = None,
        to_date: str | None = None,
    ) -> Availability:
        """Which dates at a site still have room for ``applicants`` people.

        ``from_date`` and ``to_date`` (``YYYY-MM-DD``) default to the site's own
        "today" and booking horizon.
        """
        _assert_positive_int(site_id, "site_id")
        _assert_applicants(applicants)
        if from_date is not None:
            _assert_date(from_date, "from_date")
        if to_date is not None:
            _assert_date(to_date, "to_date")
        session = self._ensure_session()
        start = from_date or session.server_today or datetime.now(_MANILA).date().isoformat()
        end = to_date or session.max_date or _add_days(start, _FALLBACK_HORIZON_DAYS)
        if start > end:
            raise ValueError(f"from_date ({start}) is after to_date ({end})")

        path = ENDPOINTS["availability"]

        def load() -> Availability:
            form: dict[str, str | int] = {
                "fromDate": start,
                "toDate": end,
                "siteId": site_id,
                "requestedSlots": applicants,
            }
            try:
                days = self._post_with_token(
                    path,
                    form,
                    empty_means_stale_session=True,
                    parse=lambda text: parse_availability(parse_json(text, path), path),
                )
            except UpstreamError as err:
                if err.status == 500:
                    raise UpstreamError(
                        f"{err}; the site also answers 500 for an unknown site_id ({site_id}), "
                        "see sites()",
                        err.status,
                        err.url,
                    ) from err
                raise
            return _summarise(site_id, start, end, applicants, days)

        value, hit = self._cache.get(
            f"availability:{site_id}:{start}:{end}:{applicants}", self._availability_ttl, load
        )
        result: Availability = value
        return _replace_cached(result, hit)

    def time_slots(self, site_id: int, date: str, *, applicants: int = 1) -> list[TimeSlot]:
        """Hourly slots on one date. Never selects or reserves a slot."""
        _assert_positive_int(site_id, "site_id")
        _assert_date(date, "date")
        _assert_applicants(applicants)
        path = ENDPOINTS["time_slots"]
        value, _ = self._cache.get(
            f"timeslots:{site_id}:{date}:{applicants}",
            self._availability_ttl,
            # An empty body is a legitimate "no slots published yet" answer
            # here, so only a reused session gets a second chance.
            lambda: self._post_with_token(
                path,
                {"preferredDate": date, "siteId": site_id, "requiredSlots": applicants},
                empty_means_stale_session=False,
                parse=parse_time_slots,
            ),
        )
        return list(value)

    def watch(
        self,
        site_ids: Iterable[int],
        *,
        interval: float = 300.0,
        applicants: int | None = None,
        from_date: str | None = None,
        to_date: str | None = None,
        stop: threading.Event | None = None,
    ) -> Iterator[WatchEvent]:
        """Poll sites and yield what changed. Sites are checked one after another
        through the same rate limiter; rate-limit errors are yielded, then waited
        out, never retried in a tight loop. Set ``stop`` (or break) to end it."""
        if interval < _MIN_WATCH_INTERVAL:
            raise ValueError(f"interval must be at least {_MIN_WATCH_INTERVAL} seconds")
        ids = list(dict.fromkeys(site_ids))
        if not ids:
            raise ValueError("site_ids is empty")
        for sid in ids:
            _assert_positive_int(sid, "site_id")
        if applicants is not None:
            _assert_applicants(applicants)
        per_hour = math.ceil(_watch_requests_per_hour(len(ids), interval))
        if per_hour > self._max_per_hour:
            minimum = _MIN_WATCH_INTERVAL
            while _watch_requests_per_hour(len(ids), minimum) > self._max_per_hour:
                minimum += 60
            raise ValueError(
                f"Watching {len(ids)} site(s) every {round(interval)}s needs ~{per_hour} "
                f"requests/hour, over the budget of {self._max_per_hour}. Use an interval of "
                f"at least {round(minimum / 60)} min."
            )
        return self._watch(ids, interval, applicants, from_date, to_date, stop or threading.Event())

    def _watch(
        self,
        ids: list[int],
        interval: float,
        applicants: int | None,
        from_date: str | None,
        to_date: str | None,
        stop: threading.Event,
    ) -> Iterator[WatchEvent]:
        previous: dict[int, set[str]] = {}
        while not stop.is_set():
            for site_id in ids:
                if stop.is_set():
                    return
                try:
                    availability = self.availability(
                        site_id,
                        applicants=applicants or 1,
                        from_date=from_date,
                        to_date=to_date,
                    )
                except Exception as err:
                    yield ErrorEvent(site_id, err)
                    if isinstance(err, RateLimitError):
                        _wait(stop, err.retry_after)
                    continue
                now = set(availability.available_dates)
                before = previous.get(site_id)
                previous[site_id] = now
                yield AvailabilityEvent(
                    site_id=site_id,
                    availability=availability,
                    opened=tuple(
                        d for d in availability.available_dates if before is None or d not in before
                    ),
                    closed=tuple(sorted(before - now)) if before is not None else (),
                    initial=before is None,
                )
            _wait(stop, interval + random.random() * 0.1 * interval)

    def stats(self) -> dict[str, float]:
        """Rate-limiter state for this host: requests in the last hour,
        consecutive failures, and pauses in seconds."""
        return self._gate.stats()

    # -- plumbing ------------------------------------------------------------

    def _post_with_token(
        self,
        path: str,
        form: dict[str, str | int],
        *,
        empty_means_stale_session: bool,
        parse: Callable[[str], T],
    ) -> T:
        attempt = 0
        while True:
            reused = self._session is not None and self._session.is_fresh(_clock.now())
            session = self._ensure_session()
            result = self._send(
                "POST",
                path,
                lambda text: _EMPTY if text.strip() == "" else parse(text),
                form=form,
                token=session.token,
            )
            session.last_used_at = _clock.now()
            if not isinstance(result, _Empty):
                return result
            # The site answers a rejected anti-forgery token with an empty 200.
            if attempt == 0 and (empty_means_stale_session or reused):
                self._invalidate_session()
                attempt += 1
                continue
            if empty_means_stale_session:
                self._gate.penalize()
                raise SessionError(f"{path} returned an empty body even with a new session")
            return parse("")

    def _ensure_session(self) -> Session:
        """One bootstrap at a time, shared by concurrent callers."""
        with self._session_lock:
            if self._session is not None and self._session.is_fresh(_clock.now()):
                return self._session
            self._jar.clear()
            path = ENDPOINTS["bootstrap"]

            def parse(text: str) -> Any:
                page = parse_bootstrap(text)
                if page is None:
                    raise SessionError(
                        f"No anti-forgery token on {path}; the site may have changed"
                    )
                return page

            page = self._send("GET", path, parse, accept="text/html")
            now = _clock.now()
            self._session = Session(page.token, page.server_today, page.max_date, now, now)
            return self._session

    def _invalidate_session(self) -> None:
        with self._session_lock:
            self._session = None
            self._jar.clear()

    def _send(
        self,
        method: Literal["GET", "POST"],
        path: str,
        parse: Callable[[str], T],
        *,
        form: dict[str, str | int] | None = None,
        token: str | None = None,
        accept: str | None = None,
    ) -> T:
        """One request through the rate limiter. ``parse`` runs inside the gated
        task, so a response the package cannot read counts as a failure for
        backoff, just like a non-2xx status."""
        url = f"{self._base_url}{path}"
        opts = GateOptions(self._min_interval, self._max_per_hour, self._max_wait)

        def task(report: Report) -> T:
            headers = {
                "User-Agent": self._user_agent,
                "Accept": accept or "application/json, text/html;q=0.9, */*;q=0.1",
            }
            cookie = self._jar.header()
            if cookie:
                headers["Cookie"] = cookie
            body = None
            if form is not None:
                body = urllib.parse.urlencode({k: str(v) for k, v in form.items()}).encode()
                headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
                headers["X-Requested-With"] = "XMLHttpRequest"
            if token:
                headers["__RequestVerificationToken"] = token
            try:
                res = self._transport(HttpRequest(method, url, headers, body, self._timeout))
            except (OSError, ValueError) as err:
                # Timeout, DNS, refused connection: the site is unreachable.
                reason = getattr(err, "reason", None) or err
                if isinstance(reason, TimeoutError):
                    reason = f"no answer within {self._timeout:g}s"
                raise UpstreamError(f"{method} {path} failed: {reason}", 0, url) from err
            self._jar.store([v for k, v in res.headers if k.lower() == "set-cookie"])
            if not 200 <= res.status < 300:
                report(Outcome(ok=False, retry_after=parse_retry_after(res.header("retry-after"))))
                note = " (a redirect, which is not followed)" if 300 <= res.status < 400 else ""
                raise UpstreamError(
                    f"{method} {path} returned HTTP {res.status}{note}", res.status, url
                )
            try:
                value = parse(res.text)
            except Exception:
                report(Outcome(ok=False))
                raise
            report(Outcome(ok=True))
            return value

        return self._gate.run(opts, task)


def _watch_requests_per_hour(sites: int, interval: float) -> float:
    """One request per site per round, plus session refreshes: every round when
    rounds are further apart than the idle timeout, else once per session age."""
    rounds = _HOUR / interval
    refreshes = rounds if interval >= SESSION_IDLE_S else _HOUR / SESSION_MAX_AGE_S
    return rounds * sites + refreshes


def _wait(stop: threading.Event, seconds: float) -> None:
    # Sleep through the package clock so tests can fast-forward, waking early on stop.
    end = _clock.now() + seconds
    while not stop.is_set():
        remaining = end - _clock.now()
        if remaining <= 0:
            return
        _clock.sleep(min(remaining, 1.0))


def _summarise(
    site_id: int, start: str, end: str, applicants: int, days: list[DayAvailability]
) -> Availability:
    available = tuple(d.date for d in days if d.available)
    return Availability(
        site_id=site_id,
        from_date=start,
        to_date=end,
        applicants=applicants,
        earliest=available[0] if available else None,
        available_dates=available,
        days=tuple(days),
        fetched_at=datetime.fromtimestamp(_clock.now(), tz=UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        cached=False,
    )


def _replace_cached(result: Availability, hit: bool) -> Availability:
    return replace(result, cached=hit)


#: Printable ASCII, no parentheses: it sits inside the User-Agent's comment.
CONTACT_RULE = "contact must be printable ASCII, at most 200 characters, without ( or )"
_CONTACT = re.compile(r"[\x20-\x27\x2a-\x7e]{1,200}")


def assert_contact(contact: str) -> None:
    if not isinstance(contact, str) or not _CONTACT.fullmatch(contact):
        raise ValueError(CONTACT_RULE)


MAX_APPLICANTS = 5
"""The DFA books one person, or a group of 2 to 5 ("Number of Applicants" on its group form)."""


def _assert_applicants(value: object) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_APPLICANTS:
        raise ValueError(f"applicants must be 1 to {MAX_APPLICANTS} (got {value!r})")


def _assert_positive_int(value: object, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{name} must be a positive integer (got {value!r})")


def _assert_date(value: str, name: str) -> None:
    if not isinstance(value, str) or not is_iso_date(value):
        raise ValueError(f"{name} must be a YYYY-MM-DD date (got {value!r})")


def _add_days(day: str, days: int) -> str:
    return (date.fromisoformat(day) + timedelta(days=days)).isoformat()
