// The notification-alert routes, for the page. The credential travels only in the Authorization header.
import {
  type ChangeAnswer,
  type ChangeRequest,
  isMineAnswer,
  type MineAnswer,
  type ReadyAnswer,
  type ReadyRequest,
  type RotateRequest,
  type SeenAnswer,
  type SetupAnswer,
  type SetupRequest,
  type TestAnswer,
} from '@penge/contracts';
import { BASE } from '../links.ts';

export class DeviceApiError extends Error {
  override name = 'DeviceApiError';
  readonly kind: 'offline' | 'server' | 'refused';
  // Fields are declared and assigned, not constructor parameter properties (erasableSyntaxOnly).
  constructor(kind: 'offline' | 'server' | 'refused') {
    super(kind);
    this.kind = kind;
  }
}

export interface DeviceApi {
  setup(credential: string, body: SetupRequest, ownerToken?: string): Promise<SetupAnswer>;
  rotate(credential: string, body: RotateRequest): Promise<SetupAnswer>;
  ready(credential: string, body: ReadyRequest): Promise<ReadyAnswer | { result: 'limited'; activation: null }>;
  mine(credential: string): Promise<MineAnswer>;
  seen(credential: string): Promise<SeenAnswer>;
  change(credential: string, body: ChangeRequest): Promise<ChangeAnswer>;
  test(credential: string): Promise<TestAnswer>;
  turnOff(credential: string): Promise<{ deleted: true }>;
}

/**
 * Every request, its answer's body included, ends within this: a request that never answers is "offline", so nothing
 * waits on it (the driving page holds the driver lock while it sends; its checks run again within this time).
 */
export const REQUEST_TIMEOUT_MS = 15_000;

async function call(method: string, path: string, credential: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; data: unknown }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`${BASE}api/device-alerts${path}`, {
        method,
        credentials: 'same-origin',
        signal: abort.signal,
        headers: { authorization: `Device ${credential}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new DeviceApiError('offline');
    }
    // The body is read under the same deadline: aborting it rejects the read, which is offline too.
    let data: unknown;
    try {
      data = (await res.json()) as unknown;
    } catch {
      if (abort.signal.aborted) throw new DeviceApiError('offline');
      data = null;
    }
    if (res.status >= 500) throw new DeviceApiError('server');
    if (res.status === 429 || res.status === 409 || res.status === 200) return { status: res.status, data };
    throw new DeviceApiError('refused');
  } finally {
    clearTimeout(timer);
  }
}

const object = (v: unknown) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null);

export const deviceApi: DeviceApi = {
  async setup(credential, body, ownerToken) {
    const r = await call('POST', '', credential, body, ownerToken ? { 'x-owner-token': ownerToken } : {});
    return r.status === 429 ? { outcome: 'limited', operation: null } : (r.data as SetupAnswer);
  },
  async rotate(credential, body) {
    const r = await call('POST', '/mine/subscription', credential, body);
    return r.status === 429 ? { outcome: 'limited', operation: null } : (r.data as SetupAnswer);
  },
  async ready(credential, body) {
    const r = await call('POST', '/ready', credential, body);
    return r.status === 429 ? { result: 'limited', activation: null } : (r.data as ReadyAnswer);
  },
  async mine(credential) {
    const r = await call('GET', '/mine', credential);
    if (!isMineAnswer(r.data)) throw new DeviceApiError(r.status === 429 ? 'server' : 'refused');
    return r.data;
  },
  async seen(credential) {
    const r = await call('POST', '/mine/seen', credential, {});
    if (r.status === 429 || !object(r.data)?.state) throw new DeviceApiError('server');
    return r.data as SeenAnswer;
  },
  async change(credential, body) {
    const r = await call('PUT', '/mine', credential, body);
    if (r.status === 429) throw new DeviceApiError('server');
    return r.data as ChangeAnswer;
  },
  async test(credential) {
    const r = await call('POST', '/mine/test', credential, {});
    return r.status === 429 ? { test: 'limited' } : (r.data as TestAnswer);
  },
  async turnOff(credential) {
    const r = await call('DELETE', '/mine', credential, {});
    if (object(r.data)?.deleted !== true) throw new DeviceApiError('server');
    return { deleted: true };
  },
};
