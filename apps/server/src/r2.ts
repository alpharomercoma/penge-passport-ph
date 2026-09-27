// Stores each run's scan in Cloudflare R2 (S3 API) as gzipped JSON, in
// Hive-style folders (date=YYYY-MM-DD) that DuckDB, Spark or pandas read
// directly. When R2 is unreachable the file waits in a local spool and is
// uploaded by a later run, so an outage never loses data or blocks alerts.
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { AwsClient } from 'aws4fetch';
import type { Logger } from './log.ts';
import type { Scan } from './snapshot.ts';

export interface SnapshotSink {
  /** True when the scan reached R2 now; false when it was spooled for later. */
  put(scan: Scan): Promise<boolean>;
  /** Store any other object (backups); throws on failure, nothing is spooled. */
  putObject?(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Remove an object; one that is not there counts as removed. */
  deleteObject?(key: string): Promise<void>;
  /** Every key under a prefix. */
  listObjects?(prefix: string): Promise<string[]>;
}

/** Spooled scans kept at most (~5.5 KB each, ~27 MB): about 52 days of scans every 15 minutes. */
export const MAX_SPOOL_FILES = 5000;

export interface R2Options {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  spoolDir: string;
  log: Logger;
  fetch?: typeof fetch;
  /** Spooled files retried per run. */
  retryBatch?: number;
  maxSpoolFiles?: number;
}

/** `scans/v1/date=2026-09-27/2026-09-27T10-15-00-000Z_<runId>.json.gz` */
export function scanKey(scan: Scan): string {
  const day = scan.startedAt.slice(0, 10);
  const stamp = scan.startedAt.replace(/[:.]/g, '-');
  return `scans/v${scan.schema}/date=${day}/${stamp}_${scan.runId}.json.gz`;
}

// Spool files are named after their key, with the folders flattened.
const toSpoolName = (key: string) => key.replaceAll('/', '~');
const fromSpoolName = (name: string) => name.replaceAll('~', '/');

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

  async function upload(key: string, body: Uint8Array, contentType = 'application/gzip') {
    const url = urlOf(key);
    const signed = await aws.sign(url, {
      method: 'PUT',
      body,
      headers: { 'content-type': contentType, 'content-length': String(body.byteLength) },
    });
    const res = await send(signed, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`R2 PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  async function retrySpooled() {
    let names: string[];
    try {
      names = (await readdir(spoolDir)).filter((n) => n.endsWith('.json.gz')).sort();
    } catch {
      return;
    }
    for (const name of names.slice(0, options.retryBatch ?? 20)) {
      const path = join(spoolDir, name);
      try {
        await upload(fromSpoolName(name), await readFile(path));
        await unlink(path);
        log.info('spooled scan uploaded', { key: fromSpoolName(name) });
      } catch (err) {
        log.warn('spooled scan still not uploaded', { err: err as Error });
        return;
      }
    }
  }

  return {
    async put(scan) {
      const key = scanKey(scan);
      const body = gzipSync(JSON.stringify(scan));
      try {
        await upload(key, body);
      } catch (err) {
        log.warn('scan upload failed; spooling it', { key, err: err as Error });
        try {
          await mkdir(spoolDir, { recursive: true, mode: 0o700 });
          const tmp = join(spoolDir, `.${toSpoolName(key)}.tmp`);
          await writeFile(tmp, body, { mode: 0o600 });
          await rename(tmp, join(spoolDir, toSpoolName(key)));
          // A long outage must not fill the disk: past the cap, the oldest scans go.
          const spooled = (await readdir(spoolDir)).filter((n) => n.endsWith('.json.gz')).sort();
          const excess = spooled.length - (options.maxSpoolFiles ?? MAX_SPOOL_FILES);
          if (excess > 0) {
            for (const name of spooled.slice(0, excess)) await unlink(join(spoolDir, name));
            log.warn('spool full; dropped the oldest scans', { dropped: excess });
          }
        } catch (spoolErr) {
          log.error('could not spool the scan either', { err: spoolErr as Error });
        }
        return false;
      }
      await retrySpooled();
      return true;
    },
    putObject: (key, body, contentType) => upload(key, body, contentType),
    deleteObject: remove,
    listObjects: list,
  };
}
