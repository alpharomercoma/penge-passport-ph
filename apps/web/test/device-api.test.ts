import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceApiError, deviceApi, REQUEST_TIMEOUT_MS } from '../src/devices/api.ts';

describe('the device routes client', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('gives up on a request that never answers, so no caller waits on it', async () => {
    vi.useFakeTimers();
    // A server that never answers, but stops when the request is aborted (as fetch does).
    vi.stubGlobal('fetch', (_: string, init: { signal: AbortSignal }) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    const pending = deviceApi.mine('c'.repeat(43));
    const caught = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await caught).toMatchObject({ kind: 'offline' });
    expect(await caught).toBeInstanceOf(DeviceApiError);
  });

  it('gives up on an answer whose body never ends', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async (_: string, init: { signal: AbortSignal }) => ({
      status: 200,
      json: () => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    }));
    const caught = deviceApi.mine('c'.repeat(43)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await caught).toMatchObject({ kind: 'offline' });
  });
});
