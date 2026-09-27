"""Shared test helpers: a fake clock, the shared fixtures, and a fake site."""

from __future__ import annotations

import json
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

import pytest

from penge_passport_ph import _clock
from penge_passport_ph.client import HttpRequest, HttpResponse, PengePassportPH

#: The repository root, and the Node.js package whose fixtures and build these tests share.
REPO = Path(__file__).resolve().parents[3]
TS_PACKAGE = REPO / "packages" / "penge-passport-ph"
FIXTURES = TS_PACKAGE / "test" / "fixtures"


def fixture_text(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def golden(name: str) -> Any:
    return json.loads((FIXTURES / "golden" / f"{name}.json").read_text(encoding="utf-8"))


class FakeClock:
    """Replaces the package's clock: ``sleep`` advances time instantly. ``t`` is
    the wall clock (tests may jump it); ``mono`` only ever moves forward."""

    def __init__(self, start: float) -> None:
        self.t = start
        self.mono = 1_000.0
        self._lock = threading.Lock()

    def now(self) -> float:
        with self._lock:
            return self.t

    def monotonic(self) -> float:
        with self._lock:
            return self.mono

    def sleep(self, seconds: float) -> None:
        with self._lock:
            step = max(0.0, seconds)
            self.t += step
            self.mono += step

    def advance(self, seconds: float) -> None:
        self.sleep(seconds)


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeClock]:
    fake = FakeClock(datetime(2026, 9, 26, 5, 0, tzinfo=UTC).timestamp())
    monkeypatch.setattr(_clock, "now", fake.now)
    monkeypatch.setattr(_clock, "monotonic", fake.monotonic)
    monkeypatch.setattr(_clock, "sleep", fake.sleep)
    yield fake


@dataclass
class Call:
    method: str
    path: str
    headers: dict[str, str]
    form: dict[str, str]
    at: float


Handler = Callable[[Call], HttpResponse]


def json_response(body: str) -> HttpResponse:
    return HttpResponse(200, [("Content-Type", "application/json")], body)


def html_response(body: str, status: int = 200) -> HttpResponse:
    return HttpResponse(status, [("Content-Type", "text/html")], body)


@dataclass
class FakeSite:
    """A stand-in for passport.gov.ph. ``/appointment`` hands out token "T<n>"
    with a matching cookie; token-protected endpoints answer an empty 200 when
    the header and cookie don't match, as the real site does."""

    overrides: dict[str, Handler] = field(default_factory=dict)
    calls: list[Call] = field(default_factory=list)
    issued: int = 0
    valid_token: str | None = None

    def expire_token(self) -> None:
        self.valid_token = "expired"

    def __call__(self, request: HttpRequest) -> HttpResponse:
        url = urlsplit(request.url)
        body = request.body.decode() if request.body else ""
        call = Call(
            request.method, url.path, dict(request.headers), dict(parse_qsl(body)), _clock.now()
        )
        self.calls.append(call)
        if call.path in self.overrides:
            return self.overrides[call.path](call)
        token_ok = (
            self.valid_token is not None
            and call.headers.get("__RequestVerificationToken") == self.valid_token
            and f"__RequestVerificationToken=cookie-{self.valid_token}"
            in call.headers.get("Cookie", "")
        )
        if call.path == "/appointment":
            self.issued += 1
            self.valid_token = f"T{self.issued}"
            page = fixture_text("bootstrap-appointment.html").replace(
                "FIXTURE-FORM-TOKEN", self.valid_token
            )
            return HttpResponse(
                200,
                [
                    ("Content-Type", "text/html"),
                    (
                        "Set-Cookie",
                        f"__RequestVerificationToken=cookie-{self.valid_token}; path=/; HttpOnly",
                    ),
                ],
                page,
            )
        if call.path == "/countries":
            return json_response(fixture_text("countries-region1.json"))
        if call.path == "/sites":
            return json_response(fixture_text("sites-region1-country1.json"))
        if call.path == "/appointment/timeslot/available":
            return (
                json_response(fixture_text("availability-site486.json"))
                if token_ok
                else html_response("")
            )
        if call.path == "/appointment/timeslot":
            return (
                html_response(fixture_text("timeslot-2026-10-05-site486.html"))
                if token_ok
                else html_response("")
            )
        return html_response("not found", 404)

    def paths(self) -> list[str]:
        return [c.path for c in self.calls]


_host_counter = 0


@pytest.fixture
def make_client(tmp_path: Path, clock: FakeClock) -> Callable[..., PengePassportPH]:
    """A client on its own host and state directory, so tests never share a gate."""

    def make(site: FakeSite, **options: Any) -> PengePassportPH:
        global _host_counter
        _host_counter += 1
        options.setdefault("state_dir", str(tmp_path / f"state-{_host_counter}"))
        return PengePassportPH(
            base_url=f"https://test-{_host_counter}.invalid", transport=site, **options
        )

    return make
