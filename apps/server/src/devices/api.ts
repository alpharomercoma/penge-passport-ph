// The notification-alert routes (spec: "API", "What each mode allows", "Limits against abuse"). Every request passes
// the ingress gate, then is classified read-only by its credential's hash, then charged to its class (global pool
// first, all or nothing). Changes need the site's Origin and a JSON body; the credential travels only in the
// Authorization header. Nothing here logs a subscription, credential, nonce, header or payload.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type AlertChoices,
  type ApiError,
  type ChangeAnswer,
  isChangeRequest,
  isReadyRequest,
  isRotateRequest,
  isSetupRequest,
  type MineAnswer,
  type PushSubscriptionInput,
  type ReadyAnswer,
  type SeenAnswer,
  type SetupAnswer,
  type SetupOutcome,
  type SiteSummary,
  type TestAnswer,
  validateChoices,
} from '@penge/contracts';
import type { Context, Hono } from 'hono';
import type { PushConfig } from '../config.ts';
import { newId, randomToken } from '../crypto.ts';
import { K } from '../keys.ts';
import type { Kv } from '../kv.ts';
import type { Limit } from '../limits.ts';
import type { Logger } from '../log.ts';
import { checkPushSubscription } from '../push/endpoint.ts';
import { endpointHmac } from '../push/endpoint.ts';
import { setupPayload } from '../push/payload.ts';
import type { Keys } from '../subscribers.ts';
import { charge, DEVICE_LIMITS, ingressBucket, rateKeys } from './limits.ts';
import { admit, change, dispatchBegin, dispatchEnd, markGone, type Prepared, readMine, ready, reclaim, renew, setBackoff, testCapture, turnOff } from './scripts-api.ts';
import { credentialHash, digest, fingerprint, type OpRecord, openSetup, openSubscription, opView, pushService, sealSetup, sealSubscription, SETUP_MS } from './store.ts';
import { loggable, type SendResult, type SendSlots, type Transport } from './transport.ts';

export interface DeviceRouteDeps {
  kv: Kv;
  keys: Keys;
  log: Logger;
  now: () => number;
  push: PushConfig;
  limits: { alertLimit: number; recordLimit: number };
  transport: Transport | null;
  slots: SendSlots;
  ipOf: (c: Context) => string;
  sites: () => Promise<SiteSummary[] | null>;
  /** The site's own origin, and the local stack's in its build. */
  origins: string[];
}

type Class = 'alert' | 'pending' | 'unknown';
const SETUP_TTL_SECONDS = 300;
const ALERT_TTL_SECONDS = 1800;
const sha = (s: string) => createHash('sha256').update(s).digest('base64url');
const choicesOf = (a: Record<string, string>): AlertChoices => ({ siteIds: a.offices!.split(',').map(Number), applicants: Number(a.group), pace: a.pace as AlertChoices['pace'] });

export function mountDeviceRoutes(app: Hono, d: DeviceRouteDeps): void {
  const { kv, keys, log } = d;
  const limited = (c: Context) => c.json<ApiError>({ error: 'Too many requests. Try again later.', code: 'limited' }, 429);
  const bad = (c: Context) => c.json<ApiError>({ error: 'That request is not valid.' }, 400);

  /** badBody: a change whose body is not a JSON object; the route charges its class first, then answers 400. */
  type Gate = { ok: true; hash: string; cls: Class; alertId: string | null; body: Record<string, unknown>; badBody: boolean } | { ok: false; res: Response };

  /** Ingress, Origin and body (for changes), credential, classification. Charging is per route (below). */
  /** Over maxmemory, Valkey refuses the counters' script; a turn-off, which only removes, goes through uncounted. */
  const overMemory = (err: unknown) => /OOM/.test(String((err as Error)?.message ?? err));
  async function pay(c: Context, items: [Limit, string][], reclaim = false): Promise<boolean> {
    try {
      return (await charge(kv, items, d.now())).ok;
    } catch (err) {
      if (reclaim && overMemory(err)) return true;
      throw err;
    }
  }

  async function gate(c: Context, change: boolean, reclaim = false): Promise<Gate> {
    const bucket = String(ingressBucket(d.ipOf(c), keys.index));
    if (!(await pay(c, [[DEVICE_LIMITS.ingress, bucket]], reclaim))) return { ok: false, res: limited(c) };
    let body: Record<string, unknown> = {};
    let badBody = false;
    if (change) {
      const origin = c.req.header('origin');
      if (!origin || origin === 'null' || !d.origins.includes(origin)) return { ok: false, res: c.json<ApiError>({ error: 'Not allowed from there.' }, 403) };
      if (!/^application\/json\s*(?:;|$)/i.test(c.req.header('content-type') ?? '')) return { ok: false, res: c.json<ApiError>({ error: 'Send JSON.' }, 415) };
      try {
        const parsed = (await c.req.json()) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) badBody = true;
        else body = parsed as Record<string, unknown>;
      } catch {
        badBody = true;
      }
    }
    const m = /^Device ([A-Za-z0-9_-]{43})$/.exec(c.req.header('authorization') ?? '');
    if (!m) return { ok: false, res: c.json<ApiError>({ error: 'This device has no notification key.' }, 401) };
    const hash = credentialHash(m[1]!);
    const alertId = await kv.get(K.devCred(hash));
    let cls: Class = 'unknown';
    if (alertId) cls = 'alert';
    else if ((await kv.hGetAll(K.devOp(hash))).op || (await kv.hGetAll(K.devEnded(hash))).reason) cls = 'pending';
    return { ok: true, hash, cls, alertId, body, badBody };
  }

  // Per-network counters are keyed by the ingress bucket (one of 4,096), so their number is bounded whatever the traffic.
  const ip = (c: Context) => `b${ingressBucket(d.ipOf(c), keys.index)}`;
  const unknownPool = (c: Context): [Limit, string][] => [[DEVICE_LIMITS.unknownAll, 'all'], [DEVICE_LIMITS.unknownIp, ip(c)]];
  const readPool = (c: Context, g: { hash: string; cls: Class }): [Limit, string][] =>
    g.cls === 'alert'
      ? [[DEVICE_LIMITS.knownReadAll, 'all'], [DEVICE_LIMITS.knownReadIp, ip(c)], [DEVICE_LIMITS.knownReadCred, g.hash]]
      : g.cls === 'pending'
        ? [[DEVICE_LIMITS.pendingReadAll, 'all'], [DEVICE_LIMITS.pendingReadIp, ip(c)], [DEVICE_LIMITS.pendingReadCred, g.hash]]
        : unknownPool(c);

  const modeAllowsSetups = () => d.push.mode !== 'off' && d.transport !== null;

  async function siteNames(ids: number[]): Promise<string[]> {
    const list = (await d.sites()) ?? [];
    return ids.map((id) => list.find((s) => s.id === id)?.name ?? `Office ${id}`);
  }

  /** Sends the setup push for the credential's current operation, if its gate lets it (spec step 4). */
  async function dispatch(hash: string, o: OpRecord): Promise<OpRecord> {
    if (!d.transport) return o;
    const release = await d.slots.take();
    try {
      const now = d.now();
      const ep = rateKeys(DEVICE_LIMITS.setupPushEndpoint, o.ep!, now);
      const items = (l: Limit, id: string) => ({ ...rateKeys(l, id, now), bucket: l.bucket });
      const did = newId();
      const begin = await dispatchBegin(kv, {
        now, cred: hash, op: o.op!, did, svc: o.svc!, ep: o.ep!, modeOk: modeAllowsSetups(),
        epItems: [{ ...ep, bucket: DEVICE_LIMITS.setupPushEndpoint.bucket }],
        maintItems: [items(DEVICE_LIMITS.maintenanceAll, 'all'), items(DEVICE_LIMITS.maintenanceAlert, o.alert || 'none')],
      });
      if (!begin.go) return begin.o;
      // Everything between the gate and the settlement is inside one handler: a failure before the request leaves
      // as failed (a bug, never sent), not as "sending", which would read as uncertain.
      let result: SendResult;
      try {
        const secret = openSetup(keys, begin.o.sealed!);
        let offices = secret.choices?.siteIds ?? [];
        if (offices.length === 0 && o.alert) offices = ((await kv.hGetAll(K.devAlert(o.alert))).offices ?? '').split(',').filter(Boolean).map(Number);
        const payload = setupPayload({ op: o.op!, nonce: secret.nonce, expiresAt: Number(o.exp), offices: await siteNames(offices) });
        // Endpoint checks again, just before the send.
        const sub = checkPushSubscription({ endpoint: secret.subscription.endpoint, keys: { p256dh: secret.subscription.p256dh, auth: secret.subscription.auth } });
        result = sub ? await d.transport.send(sub, payload, { ttl: SETUP_TTL_SECONDS, urgency: 'high' }) : { kind: 'bug', status: null };
      } catch {
        result = { kind: 'bug', status: null };
      }
      if (result.kind !== 'accepted') log.warn('setup push not accepted', { route: 'setup', push: loggable(result) });
      const outcome = result.kind === 'accepted' || result.kind === 'uncertain' ? result.kind : result.kind === 'gone' ? 'gone' : result.kind === 'bug' ? 'failed' : 'retryable';
      const backoffUntil = result.kind === 'throttled' ? d.now() + result.retryAfterMs : null;
      await dispatchEnd(kv, { now: d.now(), cred: hash, op: o.op!, did, svc: o.svc!, outcome, backoffUntil });
      return await kv.hGetAll(K.devOp(hash));
    } finally {
      release();
    }
  }

  const answer = (c: Context, outcome: SetupOutcome, o?: OpRecord) => c.json<SetupAnswer>({ outcome, operation: o ? opView(o, d.now()) : null });

  /** A setup or a rotation, from the gate to the dispatch. */
  async function start(c: Context, kind: 'setup' | 'rotate') {
    const g = await gate(c, true);
    if (!g.ok) return g.res;
    const body = g.body;
    // The class's pools come first, on every request, repeats and malformed ones included (spec: "Classification"): a
    // first setup, or a repeat of it, uses the setup pools whatever the credential has; the others their class's.
    const first = kind === 'setup' && (body.captured ?? null) === null;
    const pool: [Limit, string][] = first ? [[DEVICE_LIMITS.unknownSetupAll, 'all'], [DEVICE_LIMITS.unknownSetupIp, ip(c)]] : readPool(c, g);
    if (!(await pay(c, pool))) return limited(c);
    if (g.badBody) return bad(c);
    const valid = kind === 'setup' ? isSetupRequest(body) : isRotateRequest(body);
    if (!valid) return bad(c);
    const captured = (body.captured ?? null) as { incarnation: string; generation: number; revision?: number } | null;
    const sub = checkPushSubscription(body.subscription);
    if (!sub) return bad(c);
    // Choices normalised by shape only here (the digest must not depend on today's office list).
    let choices: AlertChoices | null = null;
    if (kind === 'setup') {
      const shaped = validateChoices(body.choices);
      if (!shaped.ok) return bad(c);
      choices = shaped.value;
    }
    const requestDigest = digest(kind, sub, choices, captured);
    // An identical repeat of this credential's current or last operation answers that operation before anything else a
    // new setup must pass (the office list, the mode, the owner token, the stop, a backoff, memory): it was admitted.
    const last = await kv.hGetAll(K.devOp(g.hash));
    if (last.op === body.op) {
      if (last.digest !== requestDigest) return answer(c, 'invalid');
      let o = last;
      if (o.result === '' && (o.dsp === 'unsent' || o.dsp === 'retryable')) o = await dispatch(g.hash, o);
      return answer(c, o.result === '' ? 'pending' : 'done', o);
    }
    // A setup with a captured alert, or a rotation, needs an alert this credential owns.
    if (!first && g.cls !== 'alert') return answer(c, 'changed');
    if (choices) {
      const sites = await d.sites();
      if (!sites) return answer(c, 'unavailable');
      if (!validateChoices(choices, new Set(sites.map((x) => x.id))).ok) return bad(c);
    }
    // Mode (spec: "What each mode allows").
    if (d.push.mode === 'off' || !d.transport || !d.push.vapid) return answer(c, first ? 'off' : 'unavailable');
    let tok = '';
    if (first && d.push.mode === 'owner') {
      const given = c.req.header('x-owner-token') ?? '';
      const want = d.push.ownerToken ?? '';
      const same = want !== '' && timingSafeEqual(Buffer.from(sha(given)), Buffer.from(sha(want)));
      if (!same) return answer(c, 'owner-only');
      tok = sha(want);
    }
    const svc = pushService(sub.endpoint);
    if (await kv.get(K.pushPaused)) return answer(c, 'unavailable');
    if (Number((await kv.get(K.pushBackoff(svc))) ?? 0) > d.now()) return answer(c, 'unavailable');
    // Memory is read live, just before the admission step (the step itself cannot read it: INFO is not a script
    // command we use). Over maxmemory, Valkey refuses the admission script anyway; between 70% and 100% this guard
    // can admit one request that started a moment before the line was crossed, which the 25% budget absorbs.
    const mem = await kv.memory();
    if (mem.max > 0 && mem.used / mem.max > 0.7) return answer(c, 'full');
    const now = d.now();
    // Clean-up is all or nothing, so one damaged record would fail it every time: logged, and admission (which checks
    // what it touches itself) goes ahead. The message is generic: the script's names a deadline's credential hash.
    await reclaim(kv, now).catch(() => log.error('clean-up before a setup failed', { route: 'setup' }));
    const nonce = randomToken();
    const item = (l: Limit, id: string) => ({ ...rateKeys(l, id, now), bucket: l.bucket });
    const r = await admit(kv, {
      now, cred: g.hash, op: body.op as string, seq: body.seq as number, kind,
      cap: captured ?? false,
      digest: requestDigest, ep: endpointHmac(keys.index, sub.endpoint), fp: fingerprint(sub), svc,
      sealed: sealSetup(keys, { subscription: sub, choices, nonce }), nh: sha(nonce), tok, exp: now + SETUP_MS,
      stored: first ? [item(DEVICE_LIMITS.storedSetupAll, 'all'), item(DEVICE_LIMITS.storedSetupIp, ip(c))] : [],
      ...d.limits,
    });
    if (r.outcome === 'limited') return limited(c);
    if (r.outcome !== 'pending' && r.outcome !== 'repeat') return answer(c, r.outcome);
    let o = r.o!;
    if (o.result === '' && (o.dsp === 'unsent' || o.dsp === 'retryable')) o = await dispatch(g.hash, o);
    return answer(c, o.result === '' ? 'pending' : 'done', o);
  }

  app.post('/api/device-alerts', (c) => start(c, 'setup'));
  app.post('/api/device-alerts/mine/subscription', (c) => start(c, 'rotate'));

  app.post('/api/device-alerts/ready', async (c) => {
    const g = await gate(c, true);
    if (!g.ok) return g.res;
    // Charged first, then the body checked: a malformed request costs its class like any other.
    if (!(await pay(c, g.cls === 'unknown' ? unknownPool(c) : [[DEVICE_LIMITS.ackAll, 'all'], [DEVICE_LIMITS.ackIp, ip(c)]]))) return limited(c);
    if (g.badBody || !isReadyRequest(g.body)) return bad(c);
    if (g.cls === 'unknown') return c.json<ReadyAnswer>({ result: 'unknown', activation: null });
    const o = await kv.hGetAll(K.devOp(g.hash));
    let prep: Prepared | false = false;
    if (o.op === g.body.op && o.sealed) {
      const secret = openSetup(keys, o.sealed);
      prep = { sub: sealSubscription(keys, secret.subscription), ep: o.ep!, fp: o.fp!, svc: o.svc! };
      if (secret.choices) Object.assign(prep, { offices: secret.choices.siteIds.join(','), group: String(secret.choices.applicants), pace: secret.choices.pace });
    }
    const r = await ready(kv, {
      now: d.now(), cred: g.hash, op: g.body.op as string, nh: sha(g.body.nonce as string), prep, newId: newId(), newInc: newId(),
      ownerMode: d.push.mode === 'owner', ownerTok: d.push.ownerToken ? sha(d.push.ownerToken) : '', alertLimit: d.limits.alertLimit,
    });
    if (r.result === 'limited') return limited(c);
    return c.json<ReadyAnswer>({ result: r.result, activation: r.activation });
  });

  app.get('/api/device-alerts/mine', async (c) => {
    const g = await gate(c, false);
    if (!g.ok) return g.res;
    if (!(await pay(c, readPool(c, g)))) return limited(c);
    if (g.cls === 'unknown') return c.json<MineAnswer>({ state: 'none', operation: null });
    const now = d.now();
    const r = await readMine(kv, { now, cred: g.hash });
    const operation = r.o ? opView(r.o, now) : null;
    if (r.a && r.id) {
      const a = r.a;
      return c.json<MineAnswer>({
        state: 'active',
        operation,
        alert: { alertId: r.id, incarnation: a.inc!, generation: Number(a.gen), revision: Number(a.rev), choices: choicesOf(a), fingerprint: a.fp!, endsAt: new Date(Number(a.end)).toISOString(), updating: Boolean(a.gone) },
      });
    }
    if (r.e) {
      const endedAt = new Date(Number(r.e.at)).toISOString();
      return c.json<MineAnswer>(r.e.reason === 'gone' ? { state: 'gone', endedAt, fingerprint: r.e.fp!, operation } : { state: 'ended', endedAt, operation });
    }
    return c.json<MineAnswer>({ state: 'none', operation });
  });

  app.post('/api/device-alerts/mine/seen', async (c) => {
    const g = await gate(c, true);
    if (!g.ok) return g.res;
    if (!(await pay(c, readPool(c, g)))) return limited(c);
    if (g.badBody) return bad(c);
    if (g.cls === 'unknown') return c.json<SeenAnswer>({ state: 'none' });
    const r = await renew(kv, { now: d.now(), cred: g.hash });
    return c.json<SeenAnswer>(r.state === 'active' ? { state: 'active', endsAt: new Date(r.endsAt).toISOString() } : r);
  });

  app.put('/api/device-alerts/mine', async (c) => {
    const g = await gate(c, true);
    if (!g.ok) return g.res;
    const pool: [Limit, string][] = g.cls === 'alert' ? [[DEVICE_LIMITS.changeAll, 'all'], [DEVICE_LIMITS.changeCred, g.hash]] : g.cls === 'pending' ? readPool(c, g) : unknownPool(c);
    if (!(await pay(c, pool))) return limited(c);
    if (g.badBody || !isChangeRequest(g.body)) return bad(c);
    const sites = await d.sites();
    const checked = validateChoices(g.body.choices, new Set((sites ?? []).map((s) => s.id)));
    if (!checked.ok || !sites) return bad(c);
    if (g.cls === 'unknown') return c.json<ChangeAnswer>({ result: 'changed' }, 409);
    const v = checked.value;
    const r = await change(kv, {
      now: d.now(), cred: g.hash, op: g.body.op as string, seq: g.body.seq as number, digest: sha(JSON.stringify([g.body.incarnation, g.body.baseRevision, v])),
      inc: g.body.incarnation as string, baseRev: g.body.baseRevision as number, offices: v.siteIds.join(','), group: String(v.applicants), pace: v.pace, recordLimit: d.limits.recordLimit,
    });
    if (r.result === 'active') return c.json<ChangeAnswer>({ result: 'active', revision: r.revision! });
    // The brief's contract: every answer of the script is 200, but changed and busy (409).
    return c.json<ChangeAnswer>({ result: r.result }, r.result === 'changed' || r.result === 'busy' ? 409 : 200);
  });

  app.post('/api/device-alerts/mine/test', async (c) => {
    const g = await gate(c, true);
    if (!g.ok) return g.res;
    // One charge, all or nothing: the class's read pools, and for an alert the test pools too.
    const testPools: [Limit, string][] = g.cls === 'alert' && g.alertId ? [[DEVICE_LIMITS.testAll, 'all'], [DEVICE_LIMITS.testIp, ip(c)], [DEVICE_LIMITS.testAlert, g.alertId]] : [];
    if (!(await pay(c, [...readPool(c, g), ...testPools]))) return limited(c);
    if (g.badBody) return bad(c);
    if (d.push.mode === 'off' || !d.transport || (await kv.get(K.pushPaused))) return c.json<TestAnswer>({ test: 'unavailable' });
    if (g.cls !== 'alert' || !g.alertId) return c.json<TestAnswer>({ test: 'none' });
    // An ended alert is ended here (and answers none).
    const r = await readMine(kv, { now: d.now(), cred: g.hash });
    if (!r.a || !r.id) return c.json<TestAnswer>({ test: 'none' });
    const id = r.id;
    // The slot first; then one atomic step reads the alert (subscription, generation, end, gone) with the stop and the
    // backoff, just before the send. The generation sent to is the one a "gone" answer settles.
    const release = await d.slots.take();
    let result: SendResult;
    let a: Record<string, string>;
    try {
      const cap = await testCapture(kv, { now: d.now(), id, inc: r.a.inc! });
      if (cap.state !== 'ok') return c.json<TestAnswer>(cap.state === 'gone' ? { test: 'gone', updating: true } : { test: cap.state });
      a = cap.alert;
      let sub: PushSubscriptionInput | null = null;
      try {
        // A missing sealed subscription is a damaged record: refused below, like one that fails the checks.
        if (typeof a.sub !== 'string') throw new Error('no subscription stored');
        const opened = openSubscription(keys, a.sub);
        sub = checkPushSubscription({ endpoint: opened.endpoint, keys: { p256dh: opened.p256dh, auth: opened.auth } });
      } catch {
        sub = null;
      }
      if (!sub) {
        log.error('a notification alert could not be opened or failed the endpoint checks', { route: 'test', alert: id });
        return c.json<TestAnswer>({ test: 'refused' });
      }
      const payload = JSON.stringify({ v: 1, title: 'Test notification', body: 'Notifications work on this device.', tag: `test-${randomBytes(6).toString('base64url')}`, url: {} });
      result = await d.transport.send(sub, payload, { ttl: ALERT_TTL_SECONDS, urgency: 'high' }).catch((): SendResult => ({ kind: 'bug', status: null }));
    } finally {
      release();
    }
    const r2 = { id };
    if (result.kind !== 'accepted') log.warn('test push not accepted', { route: 'test', alert: r2.id, push: loggable(result) });
    if (result.kind === 'accepted' || result.kind === 'uncertain') return c.json<TestAnswer>({ test: result.kind });
    if (result.kind === 'throttled') await setBackoff(kv, a.svc!, d.now() + result.retryAfterMs);
    if (result.kind === 'gone') {
      const gone = await markGone(kv, { now: d.now(), id: r2.id, inc: a.inc!, gen: Number(a.gen) });
      if (gone.gone === 'deleted') return c.json<TestAnswer>({ test: 'gone' });
      if (gone.gone === 'kept') return c.json<TestAnswer>({ test: 'gone', updating: true });
    }
    if (result.kind === 'rejected' || result.kind === 'bug') log.error('test push refused by us or the push service', { route: 'test', alert: r2.id, push: loggable(result) });
    return c.json<TestAnswer>({ test: 'refused' });
  });

  app.delete('/api/device-alerts/mine', async (c) => {
    const g = await gate(c, true, true);
    if (!g.ok) return g.res;
    if (!(await pay(c, g.cls === 'unknown' ? unknownPool(c) : [[DEVICE_LIMITS.offAll, 'all'], [DEVICE_LIMITS.offIp, ip(c)]], true))) return limited(c);
    if (g.badBody) return bad(c);
    if (g.cls === 'unknown') return c.json({ deleted: true });
    return c.json(await turnOff(kv, { now: d.now(), cred: g.hash }));
  });
}
