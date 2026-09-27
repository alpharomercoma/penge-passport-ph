"""Differential fuzzing: the same seeded, generated inputs through the Node.js
package (the reference) and this one. Any difference in parser output, or in a
CLI's exit code, stdout or stderr, fails.

Needs node and the built package (npm run build). More inputs:
FUZZ_DIFF_N=20000 uv run pytest tests/test_differential.py
"""

from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from penge_passport_ph.errors import UpstreamError

from .conftest import TS_PACKAGE, fixture_text
from .test_parse import PARSERS

DIST = TS_PACKAGE / "dist"
SEED = 20260927
N = int(os.environ.get("FUZZ_DIFF_N", "3000"))
pytestmark = [
    pytest.mark.interop,
    pytest.mark.skipif(
        shutil.which("node") is None or not (DIST / "parse.js").exists(),
        reason="needs node and npm run build",
    ),
]

TOKENS = [
    "<label>", '<label class="col-xs-12">', "</label>", "<LABEL>", "<labelx>", "<span>", "</span>",
    "<SPAN>", '<span class="hidden">', '<span class="col-xs-5 text-danger">', "<span class='col-xs-5'>",
    "<input>", '<input disabled="disabled">', "<input disabled>", "<inputx>", "<input", "8:30", "08:30",
    "-", "9:30", "10:30", " ", "\t", "\n", "\r\n", "\u00a0", "\u2028", "\ufeff", "\u0085", "\u200b",
    "Available Slots: ", "Slots:", "SLOTS :", "\u017flots:", "3", "12", "Fully Booked", "&amp;", "&nbsp;",
    "&#65;", "&#x41;", "&#X41;", "&#99999999;", "&#0;", "&#xD800;", "&copy;", "&", "<", ">", '"', "'",
    "=", "\u00e9", "\U0001d49c", "\ud800", "currentDate = '2026-09-26'", "MAX_DATE='2027-03-31'",
    '<input name="__RequestVerificationToken" value="tok">', "\u00e9currentDate='2026-01-02'",
]  # fmt: skip


def _soup(rng: random.Random) -> str:
    return "".join(rng.choice(TOKENS) for _ in range(rng.randint(0, 40)))


def _mutate(rng: random.Random, text: str) -> str:
    for _ in range(rng.randint(0, 8)):
        at = rng.randint(0, len(text))
        text = text[:at] + rng.choice(["", *TOKENS]) + text[at + rng.randint(0, 40) :]
    return text


def _number(rng: random.Random) -> str:
    return rng.choice([
        str(rng.randint(-(10**16), 10**16)), repr(rng.uniform(-1e16, 1e16)), "1e20", "-1e20", "1e400",
        "NaN", "Infinity", "-0", "0.5", "1791158400000", "1791158400000.9", "253402300800000",
        "9007199254740993", "864000000000", "864300000000", "300000000", "-300000000", "true", "null",
        '"10"', "[]", "{}",
    ])  # fmt: skip


def _json_text(rng: random.Random, kind: str) -> str:
    def entry() -> str:
        if kind == "availability":
            fields = [
                f'"AppointmentDate":{_number(rng)}',
                f'"IsAvailable":{rng.choice(["true", "false", "null", "1"])}',
            ]
        else:
            fields = [
                f'"Id":{_number(rng)}',
                f'"Name":{rng.choice([json.dumps(_soup(rng)), "null", "true", "7"])}',
            ]
            if kind == "sites":
                fields.append(f'"Timezone":{_number(rng)}')
                fields.append(f'"Address":{json.dumps(_soup(rng))}')
        rng.shuffle(fields)
        return "{" + ",".join(fields[: rng.randint(0, len(fields))]) + "}"

    entries = "[" + ",".join(entry() for _ in range(rng.randint(0, 4))) + "]"
    if kind == "availability":
        text = entries
    else:
        text = "{" + json.dumps("Sites" if kind == "sites" else "Countries") + ":" + entries + "}"
    return _mutate(rng, text) if rng.random() < 0.2 else text  # sometimes not JSON at all


def _date_like(rng: random.Random) -> str:
    return rng.choice([
        f"{rng.randint(0, 9999):04d}-{rng.randint(0, 13):02d}-{rng.randint(0, 32):02d}",
        f"{rng.randint(0, 99999)}-{rng.randint(0, 99)}-{rng.randint(0, 99)}",
        "\u0662\u0660\u0662\u0666-01-01", " 2026-10-05", "2026-10-05\n", "2026-02-29", "2024-02-29",
    ])  # fmt: skip


def corpus() -> list[dict[str, str]]:
    rng = random.Random(SEED)
    slot_page = fixture_text("timeslot-2026-10-05-site486.html")
    boot_page = fixture_text("bootstrap-appointment.html")
    cases = []
    for _ in range(N):
        parser = rng.choice(list(PARSERS))
        if parser == "timeSlots":
            source = rng.random()
            text = (
                _soup(rng)
                if source < 0.5
                else _mutate(rng, slot_page)
                if source < 0.9
                else "".join(chr(rng.randint(1, 0x2FFF)) for _ in range(rng.randint(0, 60)))
            )
        elif parser == "bootstrap":
            text = _soup(rng) if rng.random() < 0.5 else _mutate(rng, boot_page)
        elif parser == "isIsoDate":
            text = json.dumps([_date_like(rng) for _ in range(5)])
        else:
            text = _json_text(rng, parser)
        cases.append({"parser": parser, "input": text})
    return cases


NODE_PARSE = """
import { readFileSync } from 'node:fs';
const p = await import(%(dist)s);
const cases = JSON.parse(readFileSync(process.argv[1], 'utf8'));
const run = {
  timeSlots: (s) => p.parseTimeSlots(s),
  bootstrap: (s) => p.parseBootstrap(s),
  sites: (s) => p.parseSites(p.parseJson(s, '/sites'), '/sites'),
  countries: (s) => p.parseCountries(p.parseJson(s, '/countries'), '/countries'),
  availability: (s) => p.parseAvailability(p.parseJson(s, '/x'), '/x'),
  isIsoDate: (s) => JSON.parse(s).map(p.isIsoDate),
};
const out = cases.map((c) => {
  try { return { value: run[c.parser](c.input) ?? null }; }
  catch (err) { return { error: err.name }; }
});
process.stdout.write(JSON.stringify(out));
"""


def python_outcome(case: dict[str, str]) -> dict[str, Any]:
    try:
        return {"value": PARSERS[case["parser"]](case["input"])}
    except UpstreamError:
        return {"error": "UpstreamError"}


def test_parsers_agree_on_fuzzed_input(tmp_path: Path) -> None:
    cases = corpus()
    path = tmp_path / "corpus.json"
    path.write_text(json.dumps(cases), encoding="utf-8")
    script = NODE_PARSE % {"dist": json.dumps((DIST / "parse.js").as_uri())}
    done = subprocess.run(
        ["node", "--input-type=module", "-e", script, str(path)],
        capture_output=True, text=True, timeout=300, check=True,
    )  # fmt: skip
    node = json.loads(done.stdout)
    mismatches = [
        (case, expected, actual)
        for case, expected in zip(cases, node, strict=True)
        if (actual := python_outcome(case)) != expected
    ]
    report = "\n\n".join(
        f"{c['parser']}: {c['input'][:300]!r}\n  node:   {json.dumps(e, ensure_ascii=False)[:400]}\n  python: {json.dumps(a, ensure_ascii=False)[:400]}"
        for c, e, a in mismatches[:5]
    )
    assert not mismatches, f"{len(mismatches)} of {len(cases)} inputs differ:\n\n{report}"


ARGV_TOKENS = [
    "check", "watch", "sites", "countries", "regions", "nope", "--site", "--site=", "--site=486", "486",
    "antipolo", "city", "--region", "--region=1", "1", "0", "5", "6", "99999999999999999999", "\u0663", "--country",
    "--applicants", "--interval", "5m", "0s", "90", "soon", "--json", "--json=1", "--times", "-h", "-v",
    "-hv", "--help", "--version", "--", "-", "--from", "--to", "2026-02-30", "2026-12-01", "2026-01-01", "--search",
    "\u00e9", "--bogus", "-x", "--contact", "a(b)", "me@example.com", "--region=", "30s", "59s", "x",
]  # fmt: skip


def _run_cli(cmd: list[str], argv: list[str], state: Path) -> tuple[int, str, str]:
    env = {
        **os.environ,
        "PENGE_PASSPORT_PH_STATE_DIR": str(state),
        # Refused instantly: no fuzzed command line can reach passport.gov.ph.
        "PENGE_PASSPORT_PH_BASE_URL": "http://127.0.0.1:9",
    }
    done = subprocess.run([*cmd, *argv], capture_output=True, text=True, env=env, timeout=60)
    stderr = done.stderr
    if " failed: " in stderr:  # the operating system's wording for a refused connection differs
        stderr = stderr.split(" failed: ", 1)[0] + " failed: <unreachable>\n"
    return done.returncode, done.stdout, stderr


def test_clis_agree_on_fuzzed_command_lines(tmp_path: Path) -> None:
    rng = random.Random(SEED)
    cases = [
        [rng.choice(ARGV_TOKENS) for _ in range(rng.randint(0, 5))]
        for _ in range(int(os.environ.get("FUZZ_CLI_N", "80")))
    ]
    cases += [
        ["regions"],
        ["regions", "--json"],
        ["--help"],
        [],
        ["-v"],
        ["sites"],
        ["check", "--site", "486"],
    ]
    differ = []
    for i, argv in enumerate(cases):
        node = _run_cli(["node", str(DIST / "cli.js")], argv, tmp_path / f"n{i}")
        python = _run_cli([sys.executable, "-m", "penge_passport_ph"], argv, tmp_path / f"p{i}")
        if node != python:
            differ.append((argv, node, python))
    report = "\n\n".join(f"argv={a!r}\n  node:   {n!r}\n  python: {p!r}" for a, n, p in differ[:5])
    assert not differ, f"{len(differ)} of {len(cases)} command lines differ:\n\n{report}"
