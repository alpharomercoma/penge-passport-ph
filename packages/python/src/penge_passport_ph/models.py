"""Data returned by the client. ``to_dict()`` gives the same JSON shape as the
TypeScript package (camelCase keys, same order), which the CLI prints."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class Region:
    id: int
    name: str

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name}


@dataclass(frozen=True, slots=True)
class Country:
    id: int
    name: str

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name}


@dataclass(frozen=True, slots=True)
class Site:
    id: int
    name: str
    #: e.g. "DFA Regional Consular Office - Antipolo"
    description: str | None
    address: str | None
    telephone: str | None
    #: Free-text office hours as published, e.g. "7:30 AM to 3:30 PM".
    hours: str | None
    map_url: str | None
    #: Site's UTC offset in minutes (480 for the Philippines).
    utc_offset_minutes: int | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "address": self.address,
            "telephone": self.telephone,
            "hours": self.hours,
            "mapUrl": self.map_url,
            "utcOffsetMinutes": self.utc_offset_minutes,
        }


@dataclass(frozen=True, slots=True)
class DayAvailability:
    #: Calendar date at the site, ``YYYY-MM-DD``.
    date: str
    #: True when the day still has room for the requested number of applicants.
    available: bool

    def to_dict(self) -> dict[str, Any]:
        return {"date": self.date, "available": self.available}


@dataclass(frozen=True, slots=True)
class Availability:
    site_id: int
    from_date: str
    to_date: str
    applicants: int
    #: Earliest date with room, or None when fully booked.
    earliest: str | None
    available_dates: tuple[str, ...]
    #: Every date the site has published in the range. Absent dates are not
    #: published yet (weekends, holidays, beyond the release window).
    days: tuple[DayAvailability, ...]
    #: When this was fetched from the server (ISO 8601, UTC).
    fetched_at: str
    #: True when served from the local cache without a request.
    cached: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "siteId": self.site_id,
            "from": self.from_date,
            "to": self.to_date,
            "applicants": self.applicants,
            "earliest": self.earliest,
            "availableDates": list(self.available_dates),
            "days": [d.to_dict() for d in self.days],
            "fetchedAt": self.fetched_at,
            "cached": self.cached,
        }


@dataclass(frozen=True, slots=True)
class TimeSlot:
    """One hourly time slot on a date. "Slot" in this package always means this."""

    #: ``HH:MM``, site-local
    start: str
    #: ``HH:MM``, site-local
    end: str
    available: bool
    #: Places left in this slot, when the site says.
    remaining: int | None
    #: Status text as shown on the site, e.g. "Available Slots: 1" or "Fully Booked".
    status: str
    #: Extra note the site attaches to some slots.
    note: str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "start": self.start,
            "end": self.end,
            "available": self.available,
            "remaining": self.remaining,
            "status": self.status,
            "note": self.note,
        }


REGIONS: tuple[Region, ...] = (
    Region(1, "Asia Pacific"),
    Region(2, "Europe"),
    Region(3, "North America"),
    Region(4, "South America"),
    Region(5, "Middle East/Africa"),
)
"""Region dropdown on /appointment/individual/site (static in the page HTML)."""

PHILIPPINES_REGION_ID = 1
PHILIPPINES_COUNTRY_ID = 1
