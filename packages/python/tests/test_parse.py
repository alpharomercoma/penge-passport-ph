"""The Python parsers must reproduce the TypeScript parsers' golden output exactly."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import pytest

from penge_passport_ph.errors import UpstreamError
from penge_passport_ph.parse import (
    BootstrapPage,
    is_iso_date,
    parse_availability,
    parse_bootstrap,
    parse_countries,
    parse_json,
    parse_sites,
    parse_time_slots,
)

from .conftest import fixture_text, golden


def bootstrap_dict(page: BootstrapPage | None) -> dict[str, Any] | None:
    if page is None:
        return None
    return {"token": page.token, "serverToday": page.server_today, "maxDate": page.max_date}


def dicts(items: list[Any]) -> list[dict[str, Any]]:
    return [item.to_dict() for item in items]


def test_bootstrap_matches_golden() -> None:
    page = parse_bootstrap(fixture_text("bootstrap-appointment.html"))
    assert bootstrap_dict(page) == golden("bootstrap-appointment")


def test_countries_match_golden() -> None:
    body = json.loads(fixture_text("countries-region1.json"))
    assert dicts(parse_countries(body, "/countries")) == golden("countries-region1")


def test_sites_match_golden() -> None:
    body = json.loads(fixture_text("sites-region1-country1.json"))
    assert dicts(parse_sites(body, "/sites")) == golden("sites-region1-country1")


def test_availability_matches_golden() -> None:
    body = json.loads(fixture_text("availability-site486.json"))
    assert dicts(parse_availability(body, "/x")) == golden("availability-site486")


@pytest.mark.parametrize(
    "name", ["timeslot-2026-10-05-site486", "timeslot-2026-10-07-site486-full"]
)
def test_time_slots_match_golden(name: str) -> None:
    assert dicts(parse_time_slots(fixture_text(f"{name}.html"))) == golden(name)


PARSERS: dict[str, Callable[[str], Any]] = {
    "timeSlots": lambda s: dicts(parse_time_slots(s)),
    "bootstrap": lambda s: bootstrap_dict(parse_bootstrap(s)),
    "sites": lambda s: dicts(parse_sites(parse_json(s, "/sites"), "/sites")),
    "countries": lambda s: dicts(parse_countries(parse_json(s, "/countries"), "/countries")),
    "availability": lambda s: dicts(parse_availability(parse_json(s, "/x"), "/x")),
    "isIsoDate": lambda s: [is_iso_date(v) for v in json.loads(s)],
}

CASES = json.loads(fixture_text("parse-cases.json"))["cases"]
EXPECTED = {c["name"]: c for c in golden("parse-cases")}


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_edge_cases_match_golden(case: dict[str, str]) -> None:
    expected = EXPECTED[case["name"]]
    try:
        actual: dict[str, Any] = {"value": PARSERS[case["parser"]](case["input"])}
    except UpstreamError:
        actual = {"error": "UpstreamError"}
    expected_outcome = {k: v for k, v in expected.items() if k != "name"}
    assert actual == expected_outcome


def test_internal_slot_ids_are_never_exposed() -> None:
    slots = parse_time_slots(fixture_text("timeslot-2026-10-05-site486.html"))
    assert "1531858" not in json.dumps(dicts(slots))


def test_changed_shapes_fail_loudly() -> None:
    with pytest.raises(UpstreamError, match='no "Sites" array'):
        parse_sites({"Locations": []}, "/sites")
    with pytest.raises(UpstreamError, match="not a JSON array"):
        parse_availability({}, "/x")
