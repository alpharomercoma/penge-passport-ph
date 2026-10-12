// Where the device scripts are tested: always MemoryKv (running the real Lua through wasmoon), and a real Valkey when
// DEVICE_TEST_VALKEY names a throwaway one on 127.0.0.1 that carries the disposable mark. Each make() wipes that one
// database, so a run against it uses --no-file-parallelism (CI does; so must a local run of several files).
import { K } from '../src/keys.ts';
import { connectRedis, type Kv, MemoryKv } from '../src/kv.ts';

async function disposableValkey(url: string): Promise<Kv> {
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1') throw new Error('DEVICE_TEST_VALKEY must be a throwaway Valkey on 127.0.0.1');
  const kv = await connectRedis(url, () => {});
  if ((await kv.get(K.testMark)) !== '1') throw new Error('this Valkey is not marked disposable; refusing to wipe it');
  await kv.script({ name: 'wipe', lua: "#!lua flags=allow-oom\nredis.call('FLUSHDB') redis.call('SET', KEYS[1], '1') return 'ok'" }, [K.testMark], []);
  return kv;
}

export function valkeyTargets(): [string, () => Promise<Kv>][] {
  const url = process.env.DEVICE_TEST_VALKEY;
  if (!url && process.env.DEVICE_TEST_VALKEY_REQUIRED === '1') throw new Error('DEVICE_TEST_VALKEY is required here');
  const targets: [string, () => Promise<Kv>][] = [['MemoryKv', async () => new MemoryKv()]];
  if (url) targets.push(['Valkey', () => disposableValkey(url)]);
  return targets;
}
