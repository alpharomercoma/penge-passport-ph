"""Property-based fuzzing (Hypothesis) of everything that reads untrusted input
or enforces the rate limit. Derandomized so every failure reproduces; raise
FUZZ_EXAMPLES for a longer campaign, e.g. FUZZ_EXAMPLES=20000 uv run pytest tests/test_fuzz.py
"""

from __future__ import annotations

import contextlib
import itertools
import json
import os
import time
from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from penge_passport_ph import cli
from penge_passport_ph.errors import RateLimitError, UpstreamError
from penge_passport_ph.parse import (
    is_iso_date,
    parse_availability,
    parse_bootstrap,
    parse_countries,
    parse_sites,
    parse_time_slots,
)
from penge_passport_ph.rate_limit import GateOptions, HostGate, Outcome, Report, parse_retry_after
from penge_passport_ph.session import CookieJar

from .conftest import FakeClock, fixture_text

EXAMPLES = int(os.environ.get("FUZZ_EXAMPLES", "400"))
FUZZ = settings(
    max_examples=EXAMPLES,
    derandomize=True,
    deadline=None,
    database=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture],
)

HTML_TOKENS = [
    '<label class="col-xs-12">', "<label>", "</label>", "<LABEL>", "<span>", "</span>",
    '<span class="hidden">', '<span class="col-xs-5 text-success">', '<span class="col-xs-5 text-danger">',
    '<input id="TimeSlotID" name="TimeSlotID" type="radio" value="1.0" />', '<input disabled="disabled" type="radio">',
    "<input", "08:30", "8:30", "-", "09:30", "99:99", " ", "\n", "\r\n", "\t", "\u00a0", "\u2028", "\ufeff",
    "Available Slots: ", "Slots:", "12", "0", "Fully Booked", "&amp;", "&nbsp;", "&lt;", "&#65;", "&#x41;",
    "&#99999999;", "&#x110000;", "&#0;", "&#xD800;", "&bogus;", "&copy;", "&", "<", ">", '"', "'", "=", "\u00e9", "\U0001d49c",
]  # fmt: skip

htmlish = st.lists(st.sampled_from(HTML_TOKENS), max_size=60).map("".join)


@st.composite
def mutated(draw: st.DrawFn, text: str) -> str:
    for _ in range(draw(st.integers(0, 8))):
        at = draw(st.integers(0, len(text)))
        cut = draw(st.integers(0, 40))
        text = text[:at] + draw(st.sampled_from(["", *HTML_TOKENS])) + text[at + cut :]
    return text


any_text = st.one_of(
    st.text(max_size=300), htmlish, mutated(fixture_text("timeslot-2026-10-05-site486.html"))
)

json_values = st.recursive(
    st.none() | st.booleans() | st.integers() | st.floats(allow_nan=False) | st.text(max_size=20),
    lambda children: (
        st.lists(children, max_size=4) | st.dictionaries(st.text(max_size=8), children, max_size=4)
    ),
    max_leaves=12,
)


@FUZZ
@given(any_text)
def test_parse_time_slots_never_crashes(html: str) -> None:
    for s in parse_time_slots(html):
        assert len(s.start) == 5 and s.start[2] == ":" and s.start.replace(":", "").isdigit()
        assert len(s.end) == 5 and s.end[2] == ":"
        assert s.remaining is None or s.remaining >= 0
        assert s.status == s.status.strip()
        assert s.note is None or (s.note and s.note == s.note.strip())


@FUZZ
@given(st.one_of(any_text, mutated(fixture_text("bootstrap-appointment.html"))))
def test_parse_bootstrap_never_crashes(html: str) -> None:
    page = parse_bootstrap(html)
    if page is not None:
        assert page.token
        for d in (page.server_today, page.max_date):
            assert d is None or is_iso_date(d)


ids = st.one_of(
    st.integers(), st.floats(), st.sampled_from([0, -1, 1.5, 1e21, 2**53 + 2, "10", True, None])
)
loose = st.one_of(st.text(max_size=10), st.none(), st.integers(), st.booleans())
site = st.fixed_dictionaries(
    {},
    optional={k: v for k, v in {
        "Id": ids, "Name": loose, "Address": loose, "Telephone": loose, "Timeslots": loose,
        "Description": loose, "Url": loose, "Timezone": st.one_of(ids, loose),
    }.items()},
)  # fmt: skip


@FUZZ
@given(
    st.one_of(
        json_values, st.fixed_dictionaries({"Sites": st.lists(site), "Countries": st.lists(site)})
    )
)
def test_directory_parsers_only_raise_upstream_error(body: Any) -> None:
    for parse in (lambda: parse_sites(body, "/sites"), lambda: parse_countries(body, "/countries")):
        with contextlib.suppress(UpstreamError):
            parse()


entry = st.fixed_dictionaries(
    {},
    optional={
        "IsAvailable": st.one_of(st.booleans(), loose),
        "AppointmentDate": st.one_of(
            st.integers(-(8 * 10**15), 8 * 10**15),
            st.floats(allow_nan=False),
            st.sampled_from([1e20, -1e20, 8.64e15 + 1, 1.7e308, 1791158400000.5, -0.5]),
            loose,
        ),
    },
)


@FUZZ
@given(st.one_of(json_values, st.lists(entry, max_size=6)))
def test_parse_availability_only_raises_upstream_error(body: Any) -> None:
    try:
        days = parse_availability(body, "/x")
    except UpstreamError:
        return
    dates = [d.date for d in days]
    assert dates == sorted(dates)
    assert all(is_iso_date(d) for d in dates)


@FUZZ
@given(st.lists(st.one_of(st.text(max_size=120), st.sampled_from([
    "a=b; Max-Age=0", "a=b; Max-Age=-1", "a=b; Max-Age=abc", "a=b; Max-Age=1e309", "a=b; Max-Age=nan",
    "a=b; Expires=nonsense", "=novalue", "a", "a=b; Expires=Sat, 26-Sep-2026 13:59:32 GMT",
])), max_size=6))  # fmt: skip
def test_cookie_jar_never_crashes(lines: list[str]) -> None:
    jar = CookieJar()
    jar.store(lines)
    header = jar.header()
    assert header is None or not any(ord(c) < 0x20 or ord(c) == 0x7F for c in header)


@FUZZ
@given(st.one_of(st.text(max_size=30), st.sampled_from(
    ["30", "-5", "1.5", "1e309", "inf", "nan", "Infinity", " 30 ", "0", "Sat, 26 Sep 2026 13:59:32 GMT"]
)))  # fmt: skip
def test_retry_after_is_none_or_finite_non_negative(value: str) -> None:
    parsed = parse_retry_after(value)
    assert parsed is None or (parsed >= 0 and parsed == parsed and parsed != float("inf"))


argv_tokens = st.sampled_from([
    "check", "watch", "sites", "countries", "regions", "nope", "--site", "--site=", "--site=486", "486",
    "--region", "--region=1", "--applicants", "0", "--interval", "5m", "--json", "--json=1", "--times",
    "-h", "-v", "-hv", "--help", "--version", "--", "-", "--from", "--to", "2026-02-30", "\u00e9", "--bogus",
])  # fmt: skip


@FUZZ
@given(st.lists(st.one_of(argv_tokens, st.text(max_size=8)), max_size=8))
def test_cli_argument_parser_only_raises_usage_errors(argv: list[str]) -> None:
    try:
        values, positionals = cli._parse_args(argv)
    except cli.UsageError:
        return
    assert isinstance(values, dict) and isinstance(positionals, list)


@pytest.mark.parametrize(
    "probe",
    [
        "<label>" * 50_000,
        "<label>" + "<span>" * 50_000,
        "<label><span>" + " " * 50_000 + "8:30" + " " * 50_000 + "-",
        "<label><input" + " a" * 50_000,
        '<span class="' + "col-xs-5 " * 50_000,
        '<input name="__RequestVerificationToken"' + " value" * 50_000,
        "<input" * 50_000,
        "currentDate = " + "'" * 50_000,
        "&#" * 50_000,
    ],
    ids=lambda p: repr(p[:24]),
)
def test_parsers_stay_linear(probe: str) -> None:
    started = time.perf_counter()
    parse_time_slots(probe)
    parse_bootstrap(probe)
    # Linear takes milliseconds; the quadratic versions these guard against took 10 s+.
    assert time.perf_counter() - started < 3.0


steps = st.lists(
    st.one_of(
        st.tuples(st.just("call"), st.booleans(), st.one_of(st.none(), st.floats(0, 10_000), st.sampled_from([float("inf"), float("nan"), -5.0]))),
        st.tuples(st.just("wait"), st.floats(0, 4_000)),
        st.tuples(st.just("jump"), st.floats(-3_600, 3_600)),
    ),
    min_size=1,
    max_size=25,
)  # fmt: skip


@FUZZ
@given(
    steps,
    st.floats(2, 10),
    st.integers(1, 20),
    st.one_of(st.floats(0, 120), st.just(float("inf"))),
    st.floats(0, 1),
)
def test_limiter_never_breaks_its_invariants(
    clock: FakeClock,
    ops: list[tuple[Any, ...]],
    min_interval: float,
    per_hour: int,
    max_wait: float,
    jitter: float,
) -> None:
    gate = HostGate(random=lambda: jitter)
    opts = GateOptions(min_interval, per_hour, max_wait)
    elapsed, wall = 0.0, clock.now()

    def tick() -> float:
        nonlocal elapsed, wall
        now = clock.now()
        elapsed += max(0.0, now - wall)
        wall = now
        return elapsed

    sent: list[float] = []
    for op in ops:
        if op[0] == "call":
            _, ok, retry_after = op
            queued = tick()

            def task(
                report: Report,
                ok: bool = ok,
                retry_after: Any = retry_after,
                queued: float = queued,
            ) -> None:
                at = tick()
                sent.append(at)
                assert at - queued <= max_wait + 0.001
                report(Outcome(ok=ok, retry_after=retry_after))

            with contextlib.suppress(RateLimitError):
                gate.run(opts, task)
        elif op[0] == "wait":
            clock.advance(op[1])
            tick()
        else:
            tick()
            clock.t += op[1]  # the wall clock jumps; elapsed time does not
            wall = clock.now()
    for a, b in itertools.pairwise(sent):
        assert b - a >= min_interval - 0.001
    for t in sent:
        assert len([s for s in sent if t - 3600 < s <= t]) <= per_hour


def test_fuzz_corpus_round_trips_as_json() -> None:
    # Guards the differential fuzzer's transport: every generated input must survive JSON.
    for token in HTML_TOKENS:
        assert json.loads(json.dumps(token)) == token
