/** Base class for every error this package throws. */
export class PengePassportPHError extends Error {
  override name = 'PengePassportPHError';
}

/** The server answered with an unexpected HTTP status or body. */
export class UpstreamError extends PengePassportPHError {
  override name = 'UpstreamError';
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
  }
}

/** The anti-forgery session could not be established or keeps being rejected. */
export class SessionError extends PengePassportPHError {
  override name = 'SessionError';
}

/**
 * The client refused to send a request because doing so would exceed its
 * rate limits. `retryAfterMs` says when a retry can succeed.
 */
export class RateLimitError extends PengePassportPHError {
  override name = 'RateLimitError';
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

/**
 * Too many consecutive failures: the client has stopped talking to the
 * server for a cool-down period instead of piling on to a struggling site.
 */
export class CircuitOpenError extends RateLimitError {
  override name = 'CircuitOpenError';
}
