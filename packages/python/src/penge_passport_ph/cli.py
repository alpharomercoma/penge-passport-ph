"""The ``penge-passport-ph`` / ``penge`` command. Same commands, flags, output
and exit codes as the Node.js CLI (src/cli.ts).

Exit codes: 0 ok, 1 unexpected, 2 usage, 3 site/rate-limit/session error.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import traceback
from datetime import UTC, datetime
from typing import Any

from ._meta import CLI_ALIAS, DISPLAY_NAME, ENV_PREFIX, HOMEPAGE, NAME, VERSION
from .client import (
    CONTACT_RULE,
    DEFAULT_BASE_URL,
    MAX_APPLICANTS,
    AvailabilityEvent,
    PengePassportPH,
    assert_contact,
)
from .errors import PengePassportPHError
from .models import PHILIPPINES_COUNTRY_ID, PHILIPPINES_REGION_ID, Site
from .parse import is_iso_date

HELP = f"""{DISPLAY_NAME} {VERSION}: penge ng slot? Tingnan muna natin.
Read-only, rate-limited DFA passport appointment availability (passport.gov.ph).

Usage
  {NAME} <command> [options]
  {CLI_ALIAS} <command> [options]    (short alias)

Commands
  check      Open dates at one site          --site <id|name> [--applicants n] [--from] [--to] [--times]
  watch      Report dates as they open/close --site <id|name> [--site ...] [--interval 5m] [--applicants n]
  sites      List consular sites             [--region <id> --country <id>] [--search <text>]
  countries  List countries in a region      --region <id>
  regions    List regions

Options
  --applicants <n>  People in the booking: 1, or 2 to 5 for a group (default 1)
  --from, --to      Date range, YYYY-MM-DD (default: the site's own booking window)
  --times           With check: also list the time slots on the earliest open date
  --interval <d>    With watch: time between rounds, e.g. 90s, 10m (min 60s, default 5m)
  --json            Machine-readable output
  --contact <s>     Your email or URL, added to the User-Agent
  -h, --help        Show this help
  -v, --version     Show the version

Examples
  {NAME} sites --search cebu
  {NAME} check --site antipolo --times
  {NAME} watch --site 486 --site "Angeles" --interval 10m

Requests are at least 2 s apart and capped per hour, shared by every
{DISPLAY_NAME} process you run. It never selects or reserves a time slot.
Unofficial; not affiliated with the Department of Foreign Affairs.
{HOMEPAGE}"""

_VALUE_OPTIONS = {
    "region",
    "country",
    "search",
    "site",
    "applicants",
    "from",
    "to",
    "interval",
    "contact",
}
_BOOL_OPTIONS = {"times", "json", "help", "version"}
_SHORT = {"h": "help", "v": "version"}


class UsageError(Exception):
    pass


def _is_contact(value: str) -> bool:
    try:
        assert_contact(value)
    except ValueError:
        return False
    return True


def _parse_args(argv: list[str]) -> tuple[dict[str, Any], list[str]]:
    """Flags anywhere, ``--flag value`` or ``--flag=value``, ``--site``
    repeatable, ``--`` ends the flags. The same rules as parseCliArgs in
    src/cli.ts, so both CLIs accept and reject the same command lines."""
    values: dict[str, Any] = {}
    positionals: list[str] = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        i += 1
        if arg == "--":
            positionals.extend(argv[i:])
            break
        if arg.startswith("--"):
            name, eq, inline = arg[2:].partition("=")
        elif arg.startswith("-") and len(arg) == 2 and arg[1] in _SHORT:
            name, eq, inline = _SHORT[arg[1]], "", ""
        elif arg.startswith("-") and arg != "-":
            raise UsageError(f"unknown option '{arg}'")
        else:
            positionals.append(arg)
            continue
        if name in _BOOL_OPTIONS:
            if eq:
                raise UsageError(f"option '--{name}' does not take a value")
            values[name] = True
        elif name in _VALUE_OPTIONS:
            if eq:
                value = inline
            elif i < len(argv) and not argv[i].startswith("-"):
                value = argv[i]
                i += 1
            else:
                raise UsageError(f"option '--{name} <value>' needs a value")
            if name == "site":
                values.setdefault("site", []).append(value)
            else:
                values[name] = value
        else:
            raise UsageError(f"unknown option '--{name}'")
    return values, positionals


def _run(argv: list[str]) -> int:
    values, positionals = _parse_args(argv)
    command = positionals[0] if positionals else None
    if values.get("version"):
        _print(VERSION)
        return 0
    if values.get("help"):
        _print(HELP)
        return 0
    if not command:
        print(HELP, file=sys.stderr)
        return 2  # no command is a usage error

    # Everything the user typed is checked here, before any request, with the
    # same messages as the Node.js CLI.
    as_json = bool(values.get("json"))
    region_id = _to_int(values["region"], "--region") if "region" in values else None
    country_id = _to_int(values["country"], "--country") if "country" in values else None
    applicants = _to_int(values["applicants"], "--applicants") if "applicants" in values else None
    if applicants is not None and applicants > MAX_APPLICANTS:
        raise UsageError(f"--applicants must be 1 to {MAX_APPLICANTS}")
    for flag in ("from", "to"):
        if flag in values and not is_iso_date(values[flag]):
            raise UsageError(f"--{flag} must be a YYYY-MM-DD date")
    if "from" in values and "to" in values and values["from"] > values["to"]:
        raise UsageError("--from is after --to")
    if "contact" in values and not _is_contact(values["contact"]):
        raise UsageError(f"--{CONTACT_RULE}")
    interval = _parse_duration(values["interval"]) if "interval" in values else None
    if interval is not None and interval < 60:
        raise UsageError("--interval must be at least 60s")

    base_url = os.environ.get(f"{ENV_PREFIX}BASE_URL") or DEFAULT_BASE_URL
    client = PengePassportPH(base_url=base_url, contact=values.get("contact"))
    place = {
        "region_id": PHILIPPINES_REGION_ID if region_id is None else region_id,
        "country_id": PHILIPPINES_COUNTRY_ID if country_id is None else country_id,
    }

    if command == "regions":
        regions = client.regions()
        if as_json:
            _print_json([r.to_dict() for r in regions])
        else:
            for r in regions:
                _print(f"{r.id:>3}  {r.name}")
        return 0

    if command == "countries":
        if region_id is None:
            raise UsageError("countries needs --region")
        countries = client.countries(region_id)
        if as_json:
            _print_json([c.to_dict() for c in countries])
        else:
            for c in countries:
                _print(f"{c.id:>4}  {c.name}")
        return 0

    if command == "sites":
        search = values.get("search")
        sites = client.find_sites(search, **place) if search else client.sites(**place)
        if as_json:
            _print_json([s.to_dict() for s in sites])
        else:
            for s in sites:
                _print(f"{s.id:>5}  {s.name}")
        return 0

    if command == "check":
        (site,) = _resolve_sites(client, values.get("site"), place, 1)
        availability = client.availability(
            site.id,
            applicants=1 if applicants is None else applicants,
            from_date=values.get("from"),
            to_date=values.get("to"),
        )
        times = (
            client.time_slots(
                site.id, availability.earliest, applicants=1 if applicants is None else applicants
            )
            if values.get("times") and availability.earliest
            else None
        )
        if as_json:
            out: dict[str, Any] = {"site": site.to_dict(), "availability": availability.to_dict()}
            if times is not None:
                out["times"] = [t.to_dict() for t in times]
            _print_json(out)
            return 0
        _print(f"{site.name} (site {site.id})")
        _print(
            f"Checked {availability.from_date} to {availability.to_date} "
            f"for {availability.applicants} applicant(s)"
        )
        if not availability.earliest:
            _print(f"No available dates among {len(availability.days)} published day(s).")
        else:
            _print(f"Earliest: {availability.earliest}")
            dates = ", ".join(availability.available_dates)
            _print(f"Available ({len(availability.available_dates)}): {dates}")
        if times is not None:
            _print(f"\nTime slots on {availability.earliest}:")
            for t in times:
                _print(f"  {t.start}-{t.end}  {t.status}")
        return 0

    if command == "watch":
        sites = _resolve_sites(client, values.get("site"), place, None)
        names = {s.id: s.name for s in sites}
        stop = threading.Event()
        events = client.watch(
            [s.id for s in sites],
            interval=300.0 if interval is None else interval,
            applicants=applicants,
            stop=stop,
        )
        try:
            for event in events:
                stamp = _iso_now()
                name = names.get(event.site_id, event.site_id)
                if as_json:
                    _print(json.dumps({"at": stamp, **event.to_dict()}, ensure_ascii=False))
                elif not isinstance(event, AvailabilityEvent):
                    _print(f"{stamp}  {name}: error: {event.error}")
                elif event.initial or event.opened or event.closed:
                    parts = [f"earliest {event.availability.earliest or 'none'}"]
                    if not event.initial and event.opened:
                        parts.append(f"opened {', '.join(event.opened)}")
                    if event.closed:
                        parts.append(f"closed {', '.join(event.closed)}")
                    _print(f"{stamp}  {name}: {'; '.join(parts)}")
        except KeyboardInterrupt:
            stop.set()
        return 0

    raise UsageError(f'unknown command "{command}"; run `{NAME} --help`')


def _resolve_sites(
    client: PengePassportPH, inputs: list[str] | None, place: dict[str, int], limit: int | None
) -> list[Site]:
    if not inputs:
        raise UsageError("--site is required")
    if limit is not None and len(inputs) > limit:
        raise UsageError(f"pass at most {limit} --site")
    everything = client.sites(**place)
    resolved = []
    for value in inputs:
        if _ASCII_DIGITS.fullmatch(value):
            site = next((s for s in everything if s.id == int(value)), None)
            if site is None:
                raise UsageError(f"no site with id {value}; list them with `{NAME} sites`")
            resolved.append(site)
            continue
        needle = value.lower()
        matches = [s for s in everything if needle in s.name.lower()]
        if not matches:
            raise UsageError(f'no site matches "{value}"; list them with `{NAME} sites`')
        if len(matches) > 1:
            listing = "\n".join(f"  {s.id}  {s.name}" for s in matches)
            raise UsageError(f'"{value}" matches {len(matches)} sites:\n{listing}')
        resolved.append(matches[0])
    return resolved


def _parse_duration(value: str) -> float:
    m = re.fullmatch(r"([0-9]+)(ms|s|m|h)?", value.strip())
    if not m:
        raise UsageError(f'bad duration "{value}"; use e.g. 90s, 5m, 1h')
    unit = {"ms": 0.001, "s": 1, "m": 60, "h": 3600}[m.group(2) or "s"]
    return int(m.group(1)) * unit


_ASCII_DIGITS = re.compile(r"[0-9]+")
_MAX_SAFE_INTEGER = 2**53 - 1


def _to_int(value: str, flag: str) -> int:
    # ASCII digits only: str.isdigit() would also take "٣" or "²".
    if not _ASCII_DIGITS.fullmatch(value) or not 1 <= int(value) <= _MAX_SAFE_INTEGER:
        raise UsageError(f"{flag} must be a positive integer")
    return int(value)


def _iso_now() -> str:
    now = datetime.now(UTC).isoformat(timespec="milliseconds")
    return now.replace("+00:00", "Z")


def _print(line: str) -> None:
    print(line, flush=True)


def _print_json(value: Any) -> None:
    _print(json.dumps(value, indent=2, ensure_ascii=False))


def main(argv: list[str] | None = None) -> int:
    """Entry point for both console scripts. Returns the exit code."""
    try:
        return _run(sys.argv[1:] if argv is None else argv)
    except (UsageError, ValueError) as err:
        print(f"{NAME}: {err}", file=sys.stderr)
        return 2
    except PengePassportPHError as err:
        print(f"{NAME}: {type(err).__name__}: {err}", file=sys.stderr)
        return 3
    except KeyboardInterrupt:
        return 130
    except Exception:
        print(f"{NAME}: {traceback.format_exc().rstrip()}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
