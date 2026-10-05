// The only place the website talks to the server. Every answer is checked
// before the UI uses it; anything unexpected becomes a readable error.
import {
  type AbroadResponse,
  type ConfirmPreview,
  type ConfirmResponse,
  type DeviceState,
  type Field,
  isAbroadResponse,
  isDeviceState,
  isOfficeDates,
  isOfficeTimes,
  isPace,
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
  /** What kind of refusal, when the server says: reload, push-unavailable or full. */
  readonly code: string | null;
  constructor(message: string, status: number, fields: Partial<Record<Field, string>> = {}, code: string | null = null) {
    super(message);
    this.status = status;
    this.fields = fields;
    this.code = code;
  }
}

const OFFLINE = 'We could not reach the server. Check your connection and try again.';
const UNEXPECTED = 'The server sent an answer we did not expect. Try again in a few minutes.';
const FIELDS: readonly Field[] = ['email', 'siteIds', 'applicants', 'pace', 'channels', 'form'];
const CODES = ['reload', 'push-unavailable', 'full'];

const isShortText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 300;

async function call(path: string, body?: unknown, method: 'POST' | 'DELETE' = 'POST'): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(
      path,
      body === undefined
        ? { credentials: 'same-origin' }
        : { method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
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
    const code = typeof obj.code === 'string' && CODES.includes(obj.code) ? obj.code : null;
    throw new ApiFailure(isShortText(obj.error) ? obj.error : res.status === 0 ? OFFLINE : UNEXPECTED, res.status, fields, code);
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
    Number.isSafeInteger(r.applicants) &&
    isPace(r.pace) &&
    typeof r.channels === 'object' &&
    r.channels !== null &&
    typeof (r.channels as Record<string, unknown>).emailOn === 'boolean' &&
    typeof (r.channels as Record<string, unknown>).pushOn === 'boolean' &&
    typeof (r.channels as Record<string, unknown>).push === 'string'
  );
};
const isPreview = (v: unknown): v is ConfirmPreview => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const c = r.channels as Record<string, unknown> | null | undefined;
  return Array.isArray(r.siteIds) && Number.isSafeInteger(r.applicants) && isPace(r.pace) &&
    (c === null || (typeof c === 'object' && typeof c.emailOn === 'boolean' && typeof c.pushOn === 'boolean' && typeof c.requestedAt === 'string'));
};
const isDeviceAnswer = (v: unknown): v is { state: DeviceState } => typeof v === 'object' && v !== null && isDeviceState((v as { state?: unknown }).state);
const isOffAnswer = (v: unknown): v is { ok: true; noChannel: boolean } =>
  typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === true && typeof (v as { noChannel?: unknown }).noChannel === 'boolean';

export interface Api {
  status(): Promise<StatusResponse>;
  /** Posts abroad, checked about hourly. */
  abroad(): Promise<AbroadResponse>;
  subscribe(request: SubscribeRequest & { website: string }): Promise<string>;
  /** What a confirmation link will change, without changing anything. */
  previewConfirm(token: string): Promise<ConfirmPreview>;
  /** `acknowledge`: the channels the page showed, which a request that changes them needs. */
  confirm(token: string, acknowledge?: { emailOn: boolean; pushOn: boolean }): Promise<ConfirmResponse>;
  pushDevice(body: { credential: string; subscription?: unknown; revision?: number }): Promise<{ state: DeviceState }>;
  pushOff(credential: string): Promise<{ ok: true; noChannel: boolean }>;
  pushTest(credential: string): Promise<void>;
  unsubscribe(token: string): Promise<void>;
  requestDeletion(email: string, website: string): Promise<string>;
  deleteData(token: string): Promise<void>;
  officeDates(siteId: number, applicants: number): Promise<OfficeDates>;
  officeTimes(siteId: number, date: string, applicants: number): Promise<OfficeTimes>;
}

export const api: Api = {
  status: async () => expect(await call(`${BASE}api/status`), isStatusResponse),
  abroad: async () => expect(await call(`${BASE}api/abroad`), isAbroadResponse),
  subscribe: async (request) => expect(await call(`${BASE}api/subscribe`, request), hasMessage).message,
  previewConfirm: async (token) => expect(await call(`${BASE}api/confirm/preview`, { token }), isPreview),
  confirm: async (token, acknowledge) => expect(await call(`${BASE}api/confirm`, acknowledge ? { token, acknowledge } : { token }), isConfirm),
  pushDevice: async (body) => expect(await call(`${BASE}api/push/device`, body), isDeviceAnswer),
  pushOff: async (credential) => expect(await call(`${BASE}api/push/device`, { credential }, 'DELETE'), isOffAnswer),
  pushTest: async (credential) => {
    await call(`${BASE}api/push/test`, { credential });
  },
  unsubscribe: async (token) => {
    await call(`${BASE}api/unsubscribe`, { token });
  },
  requestDeletion: async (email, website) => expect(await call(`${BASE}api/deletion-request`, { email, website }), hasMessage).message,
  deleteData: async (token) => {
    const result = await call(`${BASE}api/delete-data`, { token });
    expect(result, (v): v is { ok: true } => typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === true);
  },
  officeDates: async (siteId, applicants) =>
    expect(await call(`${BASE}api/offices/${siteId}/dates?applicants=${applicants}`), isOfficeDates),
  officeTimes: async (siteId, date, applicants) =>
    expect(await call(`${BASE}api/offices/${siteId}/times?date=${encodeURIComponent(date)}&applicants=${applicants}`), isOfficeTimes),
};

export const errorText = (err: unknown) => (err instanceof ApiFailure ? err.message : UNEXPECTED);
