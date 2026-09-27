"""PengePassportPH (``penge-passport-ph``): read-only, rate-limited checker for
DFA Philippine passport appointment availability on passport.gov.ph.

    >>> from penge_passport_ph import PengePassportPH
    >>> penge = PengePassportPH(contact="you@example.com")
    >>> penge.availability(486).earliest  # doctest: +SKIP
    '2026-10-14'
"""

from ._meta import CLI_ALIAS, DISPLAY_NAME, ENV_PREFIX, HOMEPAGE, NAME, VERSION
from .client import (
    DEFAULT_BASE_URL,
    ENDPOINTS,
    MAX_APPLICANTS,
    AvailabilityEvent,
    ErrorEvent,
    HttpRequest,
    HttpResponse,
    PengePassportPH,
    Transport,
    WatchEvent,
    user_agent,
)
from .errors import (
    CircuitOpenError,
    PengePassportPHError,
    RateLimitError,
    SessionError,
    UpstreamError,
)
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
from .rate_limit import LIMITS, Limits, StateSharingWarning, default_state_dir

__version__ = VERSION

__all__ = [
    "CLI_ALIAS",
    "DEFAULT_BASE_URL",
    "DISPLAY_NAME",
    "ENDPOINTS",
    "ENV_PREFIX",
    "HOMEPAGE",
    "LIMITS",
    "MAX_APPLICANTS",
    "NAME",
    "PHILIPPINES_COUNTRY_ID",
    "PHILIPPINES_REGION_ID",
    "REGIONS",
    "VERSION",
    "Availability",
    "AvailabilityEvent",
    "CircuitOpenError",
    "Country",
    "DayAvailability",
    "ErrorEvent",
    "HttpRequest",
    "HttpResponse",
    "Limits",
    "PengePassportPH",
    "PengePassportPHError",
    "RateLimitError",
    "Region",
    "SessionError",
    "Site",
    "StateSharingWarning",
    "TimeSlot",
    "Transport",
    "UpstreamError",
    "WatchEvent",
    "__version__",
    "default_state_dir",
    "user_agent",
]
