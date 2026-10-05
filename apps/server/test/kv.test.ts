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

  it('rounds a script TTL to the nearest second, as Valkey does', async () => {
    const t = clock();
    const kv = new MemoryKv(t.now);
    await kv.set('k', 'v', { ttlSeconds: 2 });
    t.advance(1600);
    const ttl = await kv.script({ name: 'ttl', lua: '', memory: (tx, k) => String(tx.ttl(k[0]!)) }, ['k'], []);
    expect(ttl).toBe('0');
  });

  it('holds time still while a script runs, as Valkey does, so a key cannot expire halfway through', async () => {
    let ms = 0;
    const kv = new MemoryKv(() => (ms += 1)); // the clock moves on every read
    await kv.write([{ op: 'hSet', key: 'h', fields: { a: '1' } }]);
    await kv.script({ name: 'px', lua: '', memory: (tx) => (tx.expire('h', 0.005), 'ok') }, [], []);
    const out = await kv.script(
      {
        name: 'slow',
        lua: '',
        memory: (tx) => {
          const seen = tx.hGet('h', 'a');
          for (let i = 0; i < 20; i++) tx.exists('h');
          tx.hSet('h', 'b', '2');
          return `${seen}|${tx.pttl('h') > 0}`;
        },
      },
      [],
      [],
    );
    expect(out).toBe('1|true');
  });
});
