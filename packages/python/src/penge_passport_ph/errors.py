"""Every error this package raises derives from PengePassportPHError."""

from __future__ import annotations


class PengePassportPHError(Exception):
    """Base class for every error this package raises."""


class UpstreamError(PengePassportPHError):
    """The server answered with an unexpected HTTP status or body."""

    def __init__(self, message: str, status: int, url: str) -> None:
        super().__init__(message)
        self.status = status
        self.url = url


class SessionError(PengePassportPHError):
    """The anti-forgery session could not be established or keeps being rejected."""


class RateLimitError(PengePassportPHError):
    """The client refused to send a request because it would exceed its rate limits.

    ``retry_after`` is how many seconds to wait before a retry can succeed.
    """

    def __init__(self, message: str, retry_after: float) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class CircuitOpenError(RateLimitError):
    """Too many consecutive failures: the client is resting instead of piling on."""
