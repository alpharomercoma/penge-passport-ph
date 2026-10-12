import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeleteData } from '../src/pages/DeleteData.tsx';
import * as S from '../src/devices/state.js';
import { fakeApi } from './helpers.tsx';

vi.mock('../src/notify/worker.ts', () => ({ registration: async () => null, readyWorker: async () => null, register: () => {}, workerFailed: () => false }));

/** One holder at a time, in order: enough for these steps. */
const fakeLocks = () => {
  let last: Promise<unknown> = Promise.resolve();
  return { request: (_: string, fn: () => Promise<unknown>) => (last = last.then(fn, fn)), query: async () => ({ held: [] }) };
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("delete-data's part for this device", () => {
  it('says it cannot check (and offers to try again) when this device\'s storage cannot be read', async () => {
    const broken = new IDBFactory();
    (broken as unknown as { open: () => never }).open = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.stubGlobal('indexedDB', broken);
    window.history.replaceState(null, '', '/delete-data');
    render(<DeleteData api={fakeApi()} />);
    expect(await screen.findByText(/can't be checked right now/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('This device has no notification alert.')).toBeNull();
  });

  it('keeps a way to try again while the turn-off is not complete', async () => {
    const idb = new IDBFactory();
    vi.stubGlobal('indexedDB', idb);
    Object.defineProperty(navigator, 'locks', { value: fakeLocks(), configurable: true });
    const env = { indexedDB: idb, locks: navigator.locks, crypto: window.crypto } as unknown as S.Env;
    await S.update(env, (s) => ({ state: { ...s, credential: 'c'.repeat(43) }, result: undefined }));
    // The server cannot be reached: the deletion stays pending.
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    window.history.replaceState(null, '', '/delete-data');
    render(<DeleteData api={fakeApi()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off notifications on this device' }));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
