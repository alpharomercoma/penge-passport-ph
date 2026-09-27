"""The CLI: same commands, flags, messages and exit codes as the Node.js CLI."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from penge_passport_ph import cli, client

from .conftest import TS_PACKAGE, FakeClock, FakeSite


@pytest.fixture
def site(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, clock: FakeClock) -> FakeSite:
    fake = FakeSite()
    monkeypatch.setattr(client, "urllib_transport", fake)
    monkeypatch.setenv("PENGE_PASSPORT_PH_STATE_DIR", str(tmp_path / "state"))
    return fake


def test_help_and_version(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["--help"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("PengePassportPH 0.1.1: penge ng slot? Tingnan muna natin.\n")
    assert "  penge <command> [options]    (short alias)" in out
    assert cli.main(["-v"]) == 0
    assert capsys.readouterr().out == "0.1.1\n"
    assert cli.main([]) == 2  # no command: a usage error, help on stderr
    assert capsys.readouterr().err.startswith("PengePassportPH 0.1.1")


def test_help_text_matches_the_node_cli() -> None:
    ts = (TS_PACKAGE / "src" / "cli.ts").read_text()
    body = ts.split("const HELP = `", 1)[1].split("`;", 1)[0]
    rendered = (
        body.replace("${DISPLAY_NAME}", "PengePassportPH")
        .replace("${VERSION}", "0.1.1")
        .replace("${NAME}", "penge-passport-ph")
        .replace("${CLI_ALIAS}", "penge")
        .replace("${HOMEPAGE}", "https://alphaexperiments.com/pengepassportph/")
    )
    assert rendered == cli.HELP


@pytest.mark.parametrize(
    ("argv", "message"),
    [
        (["--bogus"], "unknown option '--bogus'"),
        (["check"], "--site is required"),
        (["check", "--site"], "option '--site <value>' needs a value"),
        (["countries"], "countries needs --region"),
        (["nope"], 'unknown command "nope"'),
        (["watch", "--site", "1", "--interval", "soon"], None),
        (["check", "--site", "x", "--applicants", "0"], "--applicants must be a positive integer"),
        (["check", "--site", "x", "--applicants", "6"], "--applicants must be 1 to 5"),
        (["watch", "--site", "x", "--interval", "30s"], "--interval must be at least 60s"),
        (
            ["check", "--site", "x", "--from", "2026-12-01", "--to", "2026-01-01"],
            "--from is after --to",
        ),
        (["--contact=a(b)", "regions"], "--contact must be printable ASCII"),
        (["--region=", "regions"], "--region must be a positive integer"),
    ],
)
def test_usage_errors_exit_2(
    argv: list[str], message: str | None, site: FakeSite, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main(argv) == 2
    err = capsys.readouterr().err
    assert err.startswith("penge-passport-ph: ")
    if message:
        assert message in err


def test_check_prints_open_dates_and_times(
    site: FakeSite, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main(["check", "--site", "antipolo", "--times"]) == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0] == "Antipolo (SM Center, Antipolo City, Rizal) (site 486)"
    assert out[1] == "Checked 2026-09-26 to 2027-03-31 for 1 applicant(s)"
    assert out[2] == "Earliest: 2026-10-08"
    assert "Time slots on 2026-10-08:" in out


def test_check_json_has_the_node_shape(site: FakeSite, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["check", "--site", "486", "--json"]) == 0
    doc = json.loads(capsys.readouterr().out)
    assert list(doc) == ["site", "availability"]
    assert list(doc["availability"]) == [
        "siteId",
        "from",
        "to",
        "applicants",
        "earliest",
        "availableDates",
        "days",
        "fetchedAt",
        "cached",
    ]
    assert list(doc["site"]) == [
        "id",
        "name",
        "description",
        "address",
        "telephone",
        "hours",
        "mapUrl",
        "utcOffsetMinutes",
    ]


def test_ambiguous_site_names_are_listed(
    site: FakeSite, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main(["check", "--site", "city"]) == 2
    assert "matches" in capsys.readouterr().err


def test_site_errors_exit_3(
    monkeypatch: pytest.MonkeyPatch, site: FakeSite, capsys: pytest.CaptureFixture[str]
) -> None:
    site.overrides["/sites"] = lambda call: client.HttpResponse(503, [], "busy")
    assert cli.main(["sites"]) == 3
    assert capsys.readouterr().err.startswith(
        "penge-passport-ph: UpstreamError: POST /sites returned HTTP 503"
    )
