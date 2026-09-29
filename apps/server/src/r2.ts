// Stores the runs' scan records (record.ts) in Cloudflare R2 (S3 API) as
// gzipped JSON, in Hive-style folders (date=YYYY-MM-DD) that DuckDB, Spark or
// pandas read directly. When R2 is unreachable a record waits in a local spool
// and is uploaded by a later run, so an outage never loses data or blocks alerts.
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AwsClient } from 'aws4fetch';
import type { Logger } from './log.ts';
import type { RecordSink } from './record.ts';

export interface SnapshotSink extends RecordSink {
  /** Store any other object (backups); throws on failure, nothing is spooled. */
  putObject?(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Remove an object; one that is not there counts as removed. */
  deleteObject?(key: string): Promise<void>;
  /** Every key under a prefix. */
  listObjects?(prefix: string): Promise<string[]>;
  /** An object's bytes. */
  getObject?(key: string): Promise<Uint8Array>;
  /**
   * Sends records waiting in the spool, oldest first, for at most `budgetMs`
   * (30 s by default): a slow R2 must not hold up a run. A run calls it after
   * its alerts are out, even when it stores nothing new, which with records
   * only of changes is most runs.
   */
  flush?(budgetMs?: number): Promise<void>;
}

/**
 * Spooled records kept at most. A run stores one only when something changed, and
 * most are a few offices, so this is days of an outage even at every run (a full
 * record, the day's first, is ~5.5 KB).
 */
export const MAX_SPOOL_FILES = 5000;

export interface R2Options {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  spoolDir: string;
  log: Logger;
  fetch?: typeof fetch;
  /** The clock the spool's time budget runs on. */
  now?: () => number;
  /** Told which records a full spool dropped, other than the one being stored (which comes back 'lost'). */
  onDropped?: (keys: string[]) => Promise<void>;
  /** Spooled files retried per run. */
  retryBatch?: number;
  maxSpoolFiles?: number;
}

// Spool files are named after their key, with the folders flattened.
const toSpoolName = (key: string) => key.replaceAll('/', '~');
const fromSpoolName = (name: string) => name.replaceAll('~', '/');
/**
 * Oldest first by when the run started (the file name's last part begins with
 * it), whatever the stream: by the whole name, "scans-abroad~" would come
 * before "scans~".
 */
const byTime = (a: string, b: string) => {
  const ta = a.slice(a.lastIndexOf('~') + 1);
  const tb = b.slice(b.lastIndexOf('~') + 1);
  return ta < tb ? -1 : ta > tb ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** The records waiting in a spool under a key prefix, oldest first (the rebuild reads them too). */
export async function readSpool(spoolDir: string, prefix: string): Promise<{ key: string; body: Uint8Array }[]> {
  let names: string[];
  try {
    names = await readdir(spoolDir);
  } catch (err) {
    // No spool yet is an empty one; anything else must not pass for an empty day.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const wanted = names.filter((n) => n.endsWith('.json.gz') && !n.startsWith('.') && fromSpoolName(n).startsWith(prefix)).sort(byTime);
  const out: { key: string; body: Uint8Array }[] = [];
  for (const name of wanted) {
    try {
      out.push({ key: fromSpoolName(name), body: await readFile(join(spoolDir, name)) });
    } catch (err) {
      // Sent to R2 (and removed) since the listing: a listing of R2 after this finds it.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return out;
}

export function r2Sink(options: R2Options): SnapshotSink {
  const aws = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: 's3',
    region: 'auto',
    retries: 0,
  });
  const send = options.fetch ?? fetch;
  const base = `${options.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(options.bucket)}`;
  const { log, spoolDir } = options;

  // Keys use only [A-Za-z0-9._=/-], which need no escaping in a URL path, and
  // no "." or ".." segment, which the URL would resolve outside the bucket.
  const urlOf = (key: string) => {
    const segments = key.split('/');
    if (!/^[A-Za-z0-9._=/-]+$/.test(key) || segments.some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error(`unsafe object key: ${key}`);
    }
    return `${base}/${key}`;
  };

  async function remove(key: string) {
    const res = await send(await aws.sign(urlOf(key), { method: 'DELETE' }), { signal: AbortSignal.timeout(30_000) });
    if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  async function list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | null = null;
    do {
      const query = new URLSearchParams({ 'list-type': '2', prefix });
      if (token) query.set('continuation-token', token);
      const res = await send(await aws.sign(`${base}?${query}`, { method: 'GET' }), { signal: AbortSignal.timeout(30_000) });
      const xml = await res.text();
      if (!res.ok) throw new Error(`R2 LIST ${res.status}: ${xml.slice(0, 200)}`);
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(m[1]!);
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]*)</.exec(xml)?.[1] ?? null) : null;
    } while (token);
    return keys;
  }

  async function get(key: string): Promise<Uint8Array> {
    const res = await send(await aws.sign(urlOf(key), { method: 'GET' }), { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`R2 GET ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async function upload(key: string, body: Uint8Array, contentType = 'application/gzip', timeoutMs = 30_000) {
    const url = urlOf(key);
    const signed = await aws.sign(url, {
      method: 'PUT',
      body,
      headers: { 'content-type': contentType, 'content-length': String(body.byteLength) },
    });
    const res = await send(signed, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`R2 PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  async function retrySpooled(budgetMs = 30_000) {
    const now = options.now ?? Date.now;
    const started = now();
    let names: string[];
    try {
      names = (await readdir(spoolDir)).filter((n) => n.endsWith('.json.gz') && !n.startsWith('.')).sort(byTime);
    } catch {
      return;
    }
    for (const name of names.slice(0, options.retryBatch ?? 20)) {
      // Each upload gets only what is left of the budget, so the flush cannot run over it.
      const left = budgetMs - (now() - started);
      if (left <= 0) return;
      const path = join(spoolDir, name);
      try {
        await upload(fromSpoolName(name), await readFile(path), 'application/gzip', Math.min(30_000, left));
        await unlink(path);
        log.info('spooled record uploaded', { key: fromSpoolName(name) });
      } catch (err) {
        log.warn('spooled record still not uploaded', { err: err as Error });
        return;
      }
    }
  }

  return {
    async store(key, body, timeoutMs = 30_000) {
      try {
        if (timeoutMs <= 0) throw new Error('no time left to upload it before the next run');
        await upload(key, body, 'application/gzip', Math.min(timeoutMs, 30_000));
      } catch (err) {
        log.warn('record upload failed; spooling it', { key, err: err as Error });
        try {
          await mkdir(spoolDir, { recursive: true, mode: 0o700 });
          const tmp = join(spoolDir, `.${toSpoolName(key)}.tmp`);
          await writeFile(tmp, body, { mode: 0o600 });
          await rename(tmp, join(spoolDir, toSpoolName(key)));
          // A long outage must not fill the disk: past the cap, the oldest records go
          // (a rebuild reports the gap they leave: record.ts).
          const spooled = (await readdir(spoolDir)).filter((n) => n.endsWith('.json.gz') && !n.startsWith('.')).sort(byTime);
          const excess = spooled.length - (options.maxSpoolFiles ?? MAX_SPOOL_FILES);
          if (excess > 0) {
            const dropped = spooled.slice(0, excess);
            const others = dropped.filter((n) => n !== toSpoolName(key)).map(fromSpoolName);
            // Noted as lost first: a record must not disappear without a trace. If that
            // fails, the spool stays over its cap until a later run can note them.
            try {
              if (others.length > 0) await options.onDropped?.(others);
            } catch (noteErr) {
              log.error('spool full, but the records it would drop could not be noted as lost; keeping them', { err: noteErr as Error });
              return 'spooled';
            }
            for (const name of dropped) await unlink(join(spoolDir, name));
            log.warn('spool full; dropped the oldest records', { dropped: excess });
            // After the clock was set back, this record can sort first and be the one dropped.
            if (dropped.includes(toSpoolName(key))) return 'lost';
          }
        } catch (spoolErr) {
          log.error('could not spool the record either', { err: spoolErr as Error });
          return 'lost';
        }
        return 'spooled';
      }
      return 'uploaded';
    },
    putObject: (key, body, contentType) => upload(key, body, contentType),
    deleteObject: remove,
    listObjects: list,
    getObject: get,
    flush: retrySpooled,
  };
}
