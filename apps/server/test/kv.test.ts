import { describe, expect, it } from 'vitest';
import { MemoryKv } from '../src/kv.ts';
import { clock } from './helpers.ts';

describe('MemoryKv persist', () => {
  it('removes a key expiry, as PERSIST does', async () => {
    const t = clock();
    const kv = new MemoryKv(t.now);
    await kv.set('k', 'v', { ttlSeconds: 10 });
    await kv.write([{ op: 'persist', key: 'k' }]);
    t.advance(60_000);
    expect(await kv.get('k')).toBe('v');
  });
});
