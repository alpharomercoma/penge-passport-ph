import { describe, expect, it } from 'vitest';
import { forgetOwner, ownerToken, takeOwnerLink } from '../src/devices/owner.ts';

class MemoryStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
function fakeWindow(hash: string, storage: unknown = new MemoryStorage()) {
  const calls: string[] = [];
  const w = {
    location: { hash, pathname: '/pengepassportph/', search: '?office=486' },
    history: { state: null, replaceState: (_: unknown, __: string, url: string) => calls.push(url) },
    localStorage: storage,
  } as unknown as Window;
  return { w, calls };
}
const TOKEN = 'a'.repeat(40);

describe('the owner link', () => {
  it('keeps the token and removes it from the address bar', () => {
    const { w, calls } = fakeWindow(`#owner=${TOKEN}`);
    expect(takeOwnerLink(w)).toEqual({ kept: true });
    expect(ownerToken(w)).toBe(TOKEN);
    expect(calls).toEqual(['/pengepassportph/?office=486']);
  });

  it('trims and decodes a pasted link once (spaces, percent-encoding)', () => {
    const { w } = fakeWindow(`#owner=%20${TOKEN}%20`);
    takeOwnerLink(w);
    expect(ownerToken(w)).toBe(TOKEN);
    const twice = fakeWindow(`#owner=${encodeURIComponent(encodeURIComponent(' '))}${TOKEN}`);
    takeOwnerLink(twice.w);
    expect(ownerToken(twice.w)).toBeNull(); // "%20…" after one decode is not a token: refused, never decoded again
  });

  it('keeps other fragment parts, such as a confirmation token', () => {
    const { w, calls } = fakeWindow(`#token=abc&owner=${TOKEN}`);
    takeOwnerLink(w);
    expect(calls).toEqual(['/pengepassportph/?office=486#token=abc']);
  });

  it('says when the browser would not keep it', () => {
    const refusing = { getItem: () => null, setItem: () => { throw new DOMException('no', 'SecurityError'); }, removeItem: () => {} };
    const { w, calls } = fakeWindow(`#owner=${TOKEN}`, refusing);
    expect(takeOwnerLink(w)).toEqual({ kept: false });
    expect(calls).toHaveLength(1); // removed from the address bar all the same
  });

  it('takes every owner= part out of the address bar, and keeps none when there is more than one', () => {
    const { w, calls } = fakeWindow(`#owner=${TOKEN}&x=1&owner=${'b'.repeat(40)}`);
    expect(takeOwnerLink(w)).toEqual({ kept: false });
    expect(calls).toEqual(['/pengepassportph/?office=486#x=1']);
    expect(ownerToken(w)).toBeNull();
  });

  it('does nothing without an owner link, and forgets the token on request', () => {
    const { w, calls } = fakeWindow('#token=abc');
    expect(takeOwnerLink(w)).toBeNull();
    expect(calls).toEqual([]);
    const s = fakeWindow(`#owner=${TOKEN}`);
    takeOwnerLink(s.w);
    forgetOwner(s.w);
    expect(ownerToken(s.w)).toBeNull();
  });
});
