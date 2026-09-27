// The only place the website talks to the server. Every answer is checked
// before the UI uses it; anything unexpected becomes a readable error.
import {
  type AbroadResponse,
  type ConfirmResponse,
  type Field,
  isAbroadResponse,
  isOfficeDates,
  isOfficeTimes,
  isStatusResponse,
  type OfficeDates,
  type OfficeTimes,
  type StatusResponse,
  type SubscribeRequest,
} from '@penge/contracts';
import { BASE } from './links.ts';

export class ApiFailure extends Error {
  override name = 'ApiFailure';
  readonly status: number;
  readonly fields: Partial<Record<Field, string>>;
  constructor(message: string, status: number, fields: Partial<Record<Field, string>> = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

const OFFLINE = 'We could not reach the server. Check your connection and try again.';
const UNEXPECTED = 'The server sent an answer we did not expect. Try again in a few minutes.';
const FIELDS: readonly Field[] = ['email', 'siteIds', 'applicants', 'form'];

const isShortText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 300;

async function call(path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(
      path,
      body === undefined
        ? { credentials: 'same-origin' }
        : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
  } catch {
    throw new ApiFailure(OFFLINE, 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Handled below: a missing body is as unexpected as a wrong one.
  }
  if (!res.ok) {
    const obj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    const fields: Partial<Record<Field, string>> = {};
    if (typeof obj.fields === 'object' && obj.fields !== null) {
      for (const f of FIELDS) {
        const text = (obj.fields as Record<string, unknown>)[f];
        if (isShortText(text)) fields[f] = text;
      }
    }
    throw new ApiFailure(isShortText(obj.error) ? obj.error : res.status === 0 ? OFFLINE : UNEXPECTED, res.status, fields);
  }
  return data;
}

function expect<T>(value: unknown, ok: (v: unknown) => v is T): T {
  if (!ok(value)) throw new ApiFailure(UNEXPECTED, 200);
  return value;
}

const hasMessage = (v: unknown): v is { message: string } =>
  typeof v === 'object' && v !== null && isShortText((v as { message?: unknown }).message);

const isConfirm = (v: unknown): v is ConfirmResponse => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    (r.status === 'confirmed' || r.status === 'updated') &&
    Array.isArray(r.siteIds) &&
    r.siteIds.every((id) => Number.isSafeInteger(id)) &&
    Number.isSafeInteger(r.applicants)
  );
};

export interface Api {
  status(): Promise<StatusResponse>;
  /** Posts abroad, checked about hourly. */
  abroad(): Promise<AbroadResponse>;
  subscribe(request: SubscribeRequest & { website: string }): Promise<string>;
  confirm(token: string): Promise<ConfirmResponse>;
  unsubscribe(token: string): Promise<void>;
  officeDates(siteId: number, applicants: number): Promise<OfficeDates>;
  officeTimes(siteId: number, date: string, applicants: number): Promise<OfficeTimes>;
}

export const api: Api = {
  status: async () => expect(await call(`${BASE}api/status`), isStatusResponse),
  abroad: async () => expect(await call(`${BASE}api/abroad`), isAbroadResponse),
  subscribe: async (request) => expect(await call(`${BASE}api/subscribe`, request), hasMessage).message,
  confirm: async (token) => expect(await call(`${BASE}api/confirm`, { token }), isConfirm),
  unsubscribe: async (token) => {
    await call(`${BASE}api/unsubscribe`, { token });
  },
  officeDates: async (siteId, applicants) =>
    expect(await call(`${BASE}api/offices/${siteId}/dates?applicants=${applicants}`), isOfficeDates),
  officeTimes: async (siteId, date, applicants) =>
    expect(await call(`${BASE}api/offices/${siteId}/times?date=${encodeURIComponent(date)}&applicants=${applicants}`), isOfficeTimes),
};

export const errorText = (err: unknown) => (err instanceof ApiFailure ? err.message : UNEXPECTED);
