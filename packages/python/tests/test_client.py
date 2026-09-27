"""PengePassportPH against a fake site. Ported from test/client.test.ts."""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from penge_passport_ph import VERSION, AvailabilityEvent, ErrorEvent, PengePassportPH
from penge_passport_ph.client import HttpResponse
from penge_passport_ph.errors import RateLimitError, SessionError, UpstreamError

from .conftest import Call, FakeClock, FakeSite, fixture_text, html_response, json_response

MakeClient = Callable[..., PengePassportPH]


def test_bootstraps_then_asks_for_availability_with_the_token(
    make_client: MakeClient, clock: FakeClock
) -> None:
    site = FakeSite()
    result = make_client(site).availability(486)

    assert [f"{c.method} {c.path}" for c in site.calls] == [
        "GET /appointment",
        "POST /appointment/timeslot/available",
    ]
    post = site.calls[1]
    assert post.form == {
        "fromDate": "2026-09-26",
        "toDate": "2027-03-31",
        "siteId": "486",
        "requestedSlots": "1",
    }
    assert post.headers["__RequestVerificationToken"] == "T1"
    assert post.headers["User-Agent"] == (
        f"penge-passport-ph/{VERSION} "
        "(+https://alphaexperiments.com/pengepassportph/; read-only availability checker)"
    )
    assert post.at - site.calls[0].at >= 3
    assert (result.site_id, result.from_date, result.to_date, result.applicants) == (
        486,
        "2026-09-26",
        "2027-03-31",
        1,
    )
    assert result.earliest == "2026-10-08"
    assert "2026-10-05" not in result.available_dates
    assert len(result.days) == 23
    assert result.cached is False


def test_serves_repeats_from_cache_until_the_ttl(make_client: MakeClient, clock: FakeClock) -> None:
    site = FakeSite()
    client = make_client(site)
    client.availability(486)
    assert client.availability(486).cached is True
    assert site.paths().count("/appointment/timeslot/available") == 1
    clock.advance(61)
    assert client.availability(486).cached is False
    assert site.paths().count("/appointment/timeslot/available") == 2


def test_concurrent_identical_calls_share_one_request(
    make_client: MakeClient, clock: FakeClock
) -> None:
    release = threading.Event()

    def slow_sites(call: Call) -> HttpResponse:
        release.wait(2)
        return json_response(fixture_text("sites-region1-country1.json"))

    site = FakeSite(overrides={"/sites": slow_sites})
    client = make_client(site)
    results: list[int] = []
    threads = [
        threading.Thread(target=lambda: results.append(len(client.sites()))) for _ in range(3)
    ]
    for t in threads:
        t.start()
    time.sleep(0.05)
    release.set()
    for t in threads:
        t.join(5)
    assert results == [43, 43, 43]
    assert site.paths().count("/sites") == 1


def test_rebootstraps_once_when_the_token_is_rejected(
    make_client: MakeClient, clock: FakeClock
) -> None:
    site = FakeSite()
    client = make_client(site)
    client.availability(486)
    site.expire_token()
    client.availability(486, applicants=2)
    assert site.paths() == [
        "/appointment",
        "/appointment/timeslot/available",
        "/appointment/timeslot/available",
        "/appointment",
        "/appointment/timeslot/available",
    ]


def test_session_error_when_a_new_session_is_rejected_too(
    make_client: MakeClient, clock: FakeClock
) -> None:
    site = FakeSite(overrides={"/appointment/timeslot/available": lambda c: html_response("")})
    client = make_client(site)
    with pytest.raises(SessionError):
        client.availability(486)
    assert site.paths().count("/appointment") == 2
    assert client.stats()["consecutive_failures"] == 1


def test_fails_loudly_when_the_bootstrap_page_has_no_token(
    make_client: MakeClient, clock: FakeClock
) -> None:
    site = FakeSite(
        overrides={"/appointment": lambda c: html_response("<h1>Under maintenance</h1>")}
    )
    with pytest.raises(SessionError, match="No anti-forgery token"):
        make_client(site).availability(486)


def test_fails_loudly_on_non_json_availability(make_client: MakeClient, clock: FakeClock) -> None:
    site = FakeSite(
        overrides={
            "/appointment/timeslot/available": lambda c: html_response(
                "<html>Request Rejected</html>"
            )
        }
    )
    with pytest.raises(UpstreamError, match="did not return JSON"):
        make_client(site).availability(486)


def test_backs_off_after_503_and_refuses_rather_than_queues(
    make_client: MakeClient, clock: FakeClock
) -> None:
    busy = HttpResponse(503, [("Retry-After", "120")], "busy")
    site = FakeSite(overrides={"/sites": lambda c: busy})
    client = make_client(site)
    with pytest.raises(UpstreamError) as err:
        client.sites()
    assert err.value.status == 503
    assert client.stats()["consecutive_failures"] == 1
    with pytest.raises(RateLimitError):
        client.sites(region_id=2)
    assert len(site.calls) == 1


def test_counts_404_and_unreadable_200_as_failures(
    make_client: MakeClient, clock: FakeClock
) -> None:
    site = FakeSite(
        overrides={
            "/countries": lambda c: html_response("gone", 404),
            "/sites": lambda c: html_response("<html>Request Rejected</html>"),
        }
    )
    client = make_client(site, max_wait=600)
    with pytest.raises(UpstreamError) as err:
        client.countries(1)
    assert err.value.status == 404
    with pytest.raises(UpstreamError, match="did not return JSON"):
        client.sites()
    assert client.stats()["consecutive_failures"] == 2
    assert site.calls[1].at - site.calls[0].at >= 5  # waited out the backoff


def test_reports_an_unreachable_site_as_upstream_error(
    make_client: MakeClient, clock: FakeClock
) -> None:
    def refuse(call: Call) -> HttpResponse:
        raise ConnectionRefusedError("connection refused")

    client = make_client(FakeSite(overrides={"/sites": refuse}))
    with pytest.raises(UpstreamError, match="POST /sites failed: connection refused") as err:
        client.sites()
    assert err.value.status == 0
    assert client.stats()["consecutive_failures"] == 1


def test_does_not_follow_redirects(make_client: MakeClient, clock: FakeClock) -> None:
    moved = HttpResponse(302, [("Location", "https://elsewhere.invalid/")], "")
    client = make_client(FakeSite(overrides={"/sites": lambda c: moved}))
    with pytest.raises(UpstreamError, match=r"HTTP 302 \(a redirect, which is not followed\)"):
        client.sites()
    assert client.stats()["consecutive_failures"] == 1


def test_the_default_transport_refuses_to_follow_redirects() -> None:
    import http.server

    from penge_passport_ph.client import HttpRequest, urllib_transport

    requested: list[str] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            requested.append(self.path)
            if self.path == "/moved":
                self.send_response(302)
                self.send_header("Location", "/target")
                self.end_headers()
            else:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"followed")

        def log_message(self, *args: object) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}/moved"
        res = urllib_transport(HttpRequest("GET", url, {}, None, 5.0))
    finally:
        server.shutdown()
    assert res.status == 302
    assert requested == ["/moved"]  # the target was never requested


def test_rejects_a_contact_that_would_break_the_user_agent(make_client: MakeClient) -> None:
    for contact in ["a\r\nX-Injected: 1", "emoji \U0001f600", "a(b)", "", "x" * 201]:
        with pytest.raises(ValueError):
            make_client(FakeSite(), contact=contact)
    make_client(FakeSite(), contact="me@example.com")


def test_rejects_a_max_wait_that_is_nan_or_negative(make_client: MakeClient) -> None:
    for max_wait in [float("nan"), -1.0, float("-inf")]:
        with pytest.raises(ValueError):
            make_client(FakeSite(), max_wait=max_wait)
    make_client(FakeSite(), max_wait=0)
    make_client(FakeSite(), max_wait=float("inf"))


def test_decodes_responses_as_utf8_whatever_the_charset() -> None:
    from penge_passport_ph.client import _decode

    assert _decode("\ufeffCr\u00e8me".encode()) == "Cr\u00e8me"
    assert _decode(b"Cr\xe8me") == "Cr\ufffdme"  # latin-1 bytes read as UTF-8, as fetch does


def test_lists_and_searches_sites_caching_the_directory(
    make_client: MakeClient, clock: FakeClock
) -> None:
    site = FakeSite()
    client = make_client(site)
    assert [s.id for s in client.find_sites("antipolo")] == [486]
    client.find_sites("angeles")
    assert site.paths().count("/sites") == 1
    assert site.calls[0].form == {"regionId": "1", "countryId": "1"}


def test_reads_time_slots_for_a_date(make_client: MakeClient, clock: FakeClock) -> None:
    site = FakeSite()
    slots = make_client(site).time_slots(486, "2026-10-05")
    assert [(s.start, s.end, s.remaining) for s in slots if s.available] == [("08:30", "09:30", 1)]
    assert site.calls[1].form == {
        "preferredDate": "2026-10-05",
        "siteId": "486",
        "requiredSlots": "1",
    }


def test_validates_input_before_touching_the_network(
    make_client: MakeClient, clock: FakeClock
) -> None:
    site = FakeSite()
    client = make_client(site)
    attempts: list[Callable[[], object]] = [
        lambda: client.availability(0),
        lambda: client.availability(486, applicants=True),
        lambda: client.availability(486, applicants=6),  # the DFA's group form stops at 5
        lambda: client.time_slots(486, "2026-10-01", applicants=6),
        lambda: client.availability(486, from_date="2026-02-30"),
        lambda: client.time_slots(486, "2026-13-01"),
    ]
    for bad in attempts:
        with pytest.raises(ValueError):
            bad()
    assert site.calls == []


def test_refuses_limits_faster_than_the_floor(make_client: MakeClient, clock: FakeClock) -> None:
    too_fast: list[dict[str, Any]] = [
        {"min_interval": 0.5},
        {"max_requests_per_hour": 10_000},
        {"availability_ttl": 1},
    ]
    for options in too_fast:
        with pytest.raises(ValueError):
            make_client(FakeSite(), **options)


def test_clients_on_one_host_share_one_limit(tmp_path: Path, clock: FakeClock) -> None:
    site = FakeSite()
    state = str(tmp_path / "shared")
    a = PengePassportPH(base_url="https://shared.invalid", transport=site, state_dir=state)
    b = PengePassportPH(base_url="https://shared.invalid", transport=site, state_dir=state)
    a.sites()
    b.countries(1)
    assert site.calls[1].at - site.calls[0].at >= 3


def test_watch_reports_the_first_result_then_only_changes(
    make_client: MakeClient, clock: FakeClock
) -> None:
    days = json.loads(fixture_text("availability-site486.json"))
    rounds = {"n": 0}

    def changing(call: Call) -> HttpResponse:
        rounds["n"] += 1
        body = []
        for d in days:
            date = time.strftime("%Y-%m-%d", time.gmtime(d["AppointmentDate"] / 1000))
            if rounds["n"] >= 2 and date == "2026-10-05":
                d = {**d, "IsAvailable": True}
            if rounds["n"] >= 2 and date == "2026-10-08":
                d = {**d, "IsAvailable": False}
            body.append(d)
        return json_response(json.dumps(body))

    site = FakeSite(overrides={"/appointment/timeslot/available": changing})
    stop = threading.Event()
    events = []
    for event in make_client(site).watch([486], interval=60, stop=stop):
        events.append(event)
        if len(events) == 2:
            stop.set()
    first, second = events
    assert isinstance(first, AvailabilityEvent) and first.initial
    assert isinstance(second, AvailabilityEvent)
    assert (second.initial, second.opened, second.closed) == (
        False,
        ("2026-10-05",),
        ("2026-10-08",),
    )


def test_watch_yields_errors_and_keeps_going(make_client: MakeClient, clock: FakeClock) -> None:
    site = FakeSite(overrides={"/appointment": lambda c: html_response("<h1>down</h1>")})
    stop = threading.Event()
    events = []
    for event in make_client(site).watch([486], interval=60, stop=stop):
        events.append(event)
        if len(events) == 2:
            stop.set()
    assert all(isinstance(e, ErrorEvent) for e in events)


def test_watch_refuses_a_plan_over_the_hourly_budget(
    make_client: MakeClient, clock: FakeClock
) -> None:
    client = make_client(FakeSite())
    with pytest.raises(ValueError, match="over the budget"):
        client.watch(range(1, 41), interval=60)
    with pytest.raises(ValueError):
        client.watch([1], interval=5)
    client.watch([1, 2, 3, 4, 5], interval=65)  # ~277/hour plus one refresh: fits in 300
