"""Parsers for passport.gov.ph responses. Rule for rule the same as src/parse.ts
(the reference); tests/test_parse.py and tests/test_differential.py check both
against the same golden files and fuzzed inputs.

Nothing here leans on a regex engine's defaults: whitespace is JavaScript's
``\\s`` set spelled out, word boundaries and case-folding are ASCII, and HTML is
scanned in linear time so hostile input cannot make parsing hang.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, TypeGuard

from .errors import UpstreamError
from .models import Country, DayAvailability, Site, TimeSlot

#: JavaScript's ``\s``, spelled out. Python's own ``\s`` and ``str.strip()`` differ from it.
WHITESPACE = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_WS = "[" + re.escape(WHITESPACE) + "]"
#: Not preceded / not followed by an ASCII word character.
_B = r"(?<![A-Za-z0-9_])"
_E = r"(?![A-Za-z0-9_])"
#: re.ASCII keeps IGNORECASE to ASCII letters, as JavaScript's /i does
#: (so the long s, U+017F, doesn't match s).
_I = re.IGNORECASE | re.ASCII

_CURRENT_DATE = re.compile(_B + "currentDate" + _WS + "*=" + _WS + "*'([^']*)'")
_MAX_DATE = re.compile(_B + "MAX_DATE" + _WS + "*=" + _WS + "*'([^']*)'")
_TOKEN_NAME = re.compile(_B + "name" + _WS + "*=" + _WS + '*"__RequestVerificationToken"', _I)
_VALUE_ATTR = re.compile(_B + "value" + _WS + "*=" + _WS + '*"([^"]*)"', _I)
_CLASS_ATTR = re.compile(_B + "class" + _WS + "*=" + _WS + '*"([^"]*)"', _I)
_DISABLED = re.compile(_B + "disabled" + _E, _I)
#: Matched at one offset only, so each attempt costs its own length.
_TIME_AT = re.compile(
    _WS + "*([0-9]{1,2}:[0-9]{2})" + _WS + "*-" + _WS + "*([0-9]{1,2}:[0-9]{2})" + _WS + "*"
)
_REMAINING = re.compile("slots?" + _WS + "*:" + _WS + "*([0-9]+)", _I)
_SPACE_RUN = re.compile(_WS + "+")
_ENTITY = re.compile(r"&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|(quot|apos|lt|gt|nbsp|amp));")
_NAMED = {"quot": '"', "apos": "'", "lt": "<", "gt": ">", "nbsp": "\u00a0", "amp": "&"}
#: Used with fullmatch: in Python, "$" would also match before a trailing newline.
_ISO_DATE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")
_ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
_WORD = frozenset("abcdefghijklmnopqrstuvwxyz0123456789_")

#: .NET ``TimeSpan`` ticks per minute (1 tick = 100 ns).
_TICKS_PER_MINUTE = 600_000_000
#: 0001-01-01T00:00:00.000 and 9999-12-31T23:59:59.999, in epoch milliseconds.
_MIN_DATE_MS = -62_135_596_800_000
_MAX_DATE_MS = 253_402_300_799_999
_MAX_SAFE_INTEGER = 2**53 - 1
_EPOCH = date(1970, 1, 1)


@dataclass(frozen=True, slots=True)
class BootstrapPage:
    token: str
    #: The server's own "today" (``currentDate``), ``YYYY-MM-DD``.
    server_today: str | None
    #: Last bookable date the UI allows (``MAX_DATE``), ``YYYY-MM-DD``.
    max_date: str | None


def parse_bootstrap(page: str) -> BootstrapPage | None:
    token = _find_token(page)
    if not token:
        return None
    return BootstrapPage(
        token=token,
        server_today=_match_iso_date(page, _CURRENT_DATE),
        max_date=_match_iso_date(page, _MAX_DATE),
    )


def _find_token(page: str) -> str | None:
    for tag in _open_tags(page, _ascii_lower(page), "input", 0):
        if not _TOKEN_NAME.search(tag.text):
            continue
        value = _VALUE_ATTR.search(tag.text)
        if value and value.group(1):
            return value.group(1)
    return None


def _match_iso_date(page: str, pattern: re.Pattern[str]) -> str | None:
    m = pattern.search(page)
    return m.group(1) if m and is_iso_date(m.group(1)) else None


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def parse_json(text: str, path: str) -> Any:
    """JSON as the site sends it. NaN and Infinity are rejected, as JSON.parse does."""
    try:
        return json.loads(text, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        snippet = _trim(_SPACE_RUN.sub(" ", text[:120]))
        raise UpstreamError(f'{path} did not return JSON: "{snippet}"', 200, path) from None


def parse_countries(body: Any, url: str) -> list[Country]:
    return [
        Country(id=_expect_id(c.get("Id"), url), name=_name(c.get("Name")))
        for c in _expect_list_prop(body, "Countries", url)
    ]


def parse_sites(body: Any, url: str) -> list[Site]:
    return [
        Site(
            id=_expect_id(s.get("Id"), url),
            name=_name(s.get("Name")),
            description=_text(s.get("Description")),
            address=_text(s.get("Address")),
            telephone=_text(s.get("Telephone")),
            hours=_text(s.get("Timeslots")),
            map_url=_text(s.get("Url")),
            utc_offset_minutes=_utc_offset(s.get("Timezone")),
        )
        for s in _expect_list_prop(body, "Sites", url)
    ]


def parse_availability(body: Any, url: str) -> list[DayAvailability]:
    """The site sends each date as epoch milliseconds for midnight UTC of that
    calendar date, and its own script reads it back as a UTC date. So do we,
    truncating fractions toward zero as JavaScript does, for years 0001-9999."""
    if not isinstance(body, list):
        raise UpstreamError("Availability response is not a JSON array", 200, url)
    days = []
    for entry in body:
        ms = entry.get("AppointmentDate") if isinstance(entry, dict) else None
        if (
            not isinstance(entry, dict)
            or not _is_number(ms)
            or not isinstance(entry.get("IsAvailable"), bool)
        ):
            raise UpstreamError("Availability entry has an unexpected shape", 200, url)
        whole = math.trunc(ms)
        if not _MIN_DATE_MS <= whole <= _MAX_DATE_MS:
            raise UpstreamError(f"Availability date {ms} is out of range", 200, url)
        day = _EPOCH + timedelta(days=whole // 86_400_000)
        days.append(DayAvailability(date=day.isoformat(), available=entry["IsAvailable"]))
    return sorted(days, key=lambda d: d.date)


def parse_time_slots(fragment: str) -> list[TimeSlot]:
    """Parse the HTML fragment ``POST /appointment/timeslot`` returns: one
    ``<label>…</label>`` per hour. The internal slot ids are deliberately not
    exposed: they only matter for reserving a slot, which this package does not do."""
    slots = []
    for block in _elements(fragment, "label"):
        lower = _ascii_lower(block)
        tag = next(_open_tags(block, lower, "input", 0), None)
        time = _time_range(block, lower)
        if tag is None or time is None:
            continue
        status = _clean_text(
            _content_of(block, lower, lambda t: _has_class(t.text, "col-xs-5")) or ""
        )
        note = _clean_text(_content_of(block, lower, lambda t: _has_class(t.text, "hidden")) or "")
        remaining = _REMAINING.search(status)
        slots.append(
            TimeSlot(
                start=_pad(time[0]),
                end=_pad(time[1]),
                available=not _DISABLED.search(tag.text),
                remaining=min(int(remaining.group(1)), _MAX_SAFE_INTEGER) if remaining else None,
                status=status,
                note=note or None,
            )
        )
    return slots


def is_iso_date(value: str) -> bool:
    """A calendar date, ``YYYY-MM-DD``, in years 0001-9999."""
    m = _ISO_DATE.fullmatch(value) if isinstance(value, str) else None
    if not m:
        return False
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    leap = (y % 4 == 0 and y % 100 != 0) or y % 400 == 0
    days = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return y >= 1 and 1 <= mo <= 12 and 1 <= d <= days[mo - 1]


# -- linear-time HTML scanning --------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Tag:
    #: The whole opening tag, ``<name …>``.
    text: str
    #: True for a bare ``<name>`` with no attributes.
    plain: bool
    #: Offset just after the tag's ``>``.
    end: int


def _ascii_lower(s: str) -> str:
    """ASCII-only lower case, so offsets in the copy match the original."""
    return s.translate(_ASCII_LOWER)


def _open_tags(page: str, lower: str, name: str, start_at: int) -> Iterator[_Tag]:
    """Opening tags ``<name …>`` from ``start_at`` on, ASCII case-insensitive,
    each ending at the first ``>``. Scanning resumes after each tag."""
    needle = f"<{name}"
    at = start_at
    while True:
        start = lower.find(needle, at)
        if start == -1:
            return
        after = start + len(needle)
        if after < len(lower) and lower[after] in _WORD:
            at = after
            continue
        close = lower.find(">", after)
        if close == -1:
            return
        yield _Tag(page[start : close + 1], close == after, close + 1)
        at = close + 1


def _elements(page: str, name: str) -> Iterator[str]:
    """The contents of each ``<name …>…</name>`` element, in order, without nesting."""
    lower = _ascii_lower(page)
    closer = f"</{name}>"
    at = 0
    while True:
        tag = next(_open_tags(page, lower, name, at), None)
        if tag is None:
            return
        close = lower.find(closer, tag.end)
        if close == -1:
            return
        yield page[tag.end : close]
        at = close + len(closer)


def _content_of(page: str, lower: str, accept: Callable[[_Tag], bool]) -> str | None:
    """Content of the first ``<span>`` whose opening tag passes ``accept``."""
    for tag in _open_tags(page, lower, "span", 0):
        if not accept(tag):
            continue
        close = lower.find("</span>", tag.end)
        return None if close == -1 else page[tag.end : close]
    return None


def _time_range(page: str, lower: str) -> tuple[str, str] | None:
    """The first bare ``<span>`` whose whole content is ``HH:MM-HH:MM``."""
    for tag in _open_tags(page, lower, "span", 0):
        if not tag.plain:
            continue
        close = lower.find("</span>", tag.end)
        if close == -1:
            return None
        m = _TIME_AT.match(page, tag.end)
        if m and m.end() == close:
            return m.group(1), m.group(2)
    return None


def _has_class(tag: str, cls: str) -> bool:
    m = _CLASS_ATTR.search(tag)
    return m is not None and cls in _SPACE_RUN.split(m.group(1))


def _clean_text(fragment: str) -> str:
    """Visible text: tags become spaces, entities are decoded, whitespace collapses."""
    parts = []
    i = 0
    while True:
        start = fragment.find("<", i)
        if start == -1:
            break
        close = fragment.find(">", start)
        if close == -1:
            break  # an unclosed '<' stays text, and so does the rest
        parts.append(fragment[i:start] + " ")
        i = close + 1
    parts.append(fragment[i:])
    return _trim(_SPACE_RUN.sub(" ", _decode_entities("".join(parts))))


def _decode_entity(m: re.Match[str]) -> str:
    dec, hexa, named = m.groups()
    if named:
        return _NAMED[named]
    code = int(dec) if dec is not None else int(hexa, 16)
    if not 0 < code <= 0x10FFFF or 0xD800 <= code <= 0xDFFF:
        return "\ufffd"
    return chr(code)


def _decode_entities(s: str) -> str:
    """Numeric references and the few named ones the site uses, in one pass.
    Code points that cannot be a character (0, surrogates, above U+10FFFF)
    become U+FFFD, as HTML specifies."""
    return _ENTITY.sub(_decode_entity, s)


def _trim(s: str) -> str:
    return s.strip(WHITESPACE)


def _pad(hhmm: str) -> str:
    return f"0{hhmm}" if len(hhmm) == 4 else hhmm


def _name(value: Any) -> str:
    return _trim(value) if isinstance(value, str) else ""


def _text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    t = _trim(value.replace("\r\n", "\n"))
    return t or None


def _js_round(x: float) -> int:
    """JavaScript's Math.round: halves go up, computed exactly."""
    whole = math.floor(x)
    return whole + 1 if x - whole >= 0.5 else whole


def _utc_offset(ticks: Any) -> int | None:
    """Minutes east of UTC from .NET ticks; None unless it is a real offset (within a day)."""
    if not _is_number(ticks) or abs(ticks) > 2**63:
        return None
    minutes = _js_round(ticks / _TICKS_PER_MINUTE)
    return minutes if abs(minutes) <= 24 * 60 else None


def _is_number(value: object) -> TypeGuard[int | float]:
    """A JSON number JavaScript would see as finite. Python reads huge integers
    exactly (JavaScript reads them as floats), so those count as finite too."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value)


def _expect_list_prop(body: Any, prop: str, url: str) -> list[dict[str, Any]]:
    items = body.get(prop) if isinstance(body, dict) else None
    if not isinstance(items, list):
        raise UpstreamError(f'Response has no "{prop}" array', 200, url)
    return [item if isinstance(item, dict) else {} for item in items]


def _expect_id(value: Any, url: str) -> int:
    """Ids are integers the site can round-trip: within ±(2^53 - 1)."""
    if isinstance(value, bool):
        raise UpstreamError("Expected an integer id", 200, url)
    if isinstance(value, int) and abs(value) <= _MAX_SAFE_INTEGER:
        return value
    if isinstance(value, float) and value.is_integer() and abs(value) <= _MAX_SAFE_INTEGER:
        return int(value)
    raise UpstreamError("Expected an integer id", 200, url)
