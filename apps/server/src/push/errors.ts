// What a failed push may put in a log: a status and a category. web-push's
// errors carry the endpoint, the response body and the request headers,
// none of which may be logged.
export interface PushFailure {
  status: number | null;
  category: 'gone' | 'refused' | 'too-big' | 'uncertain';
}

/** Connection errors that mean the request never reached the push service. */
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'CERT_HAS_EXPIRED']);

export function classifyPushError(err: unknown): PushFailure {
  const e = (err ?? {}) as { statusCode?: unknown; code?: unknown };
  const status = typeof e.statusCode === 'number' ? e.statusCode : null;
  if (status === 404 || status === 410) return { status, category: 'gone' };
  if (status === 413) return { status, category: 'too-big' };
  if (status !== null) return { status, category: 'refused' };
  if (typeof e.code === 'string' && NEVER_SENT.has(e.code)) return { status: null, category: 'refused' };
  return { status: null, category: 'uncertain' };
}
