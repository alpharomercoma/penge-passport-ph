import { describe, expect, it } from 'vitest';
import { DEVICE_SCRIPTS } from '../src/devices/lua.ts';
import { DEVICE_COUNTERS } from '../src/devices/counters.ts';

/** Every count() a script makes: literal names, and families built as 'prefix_' .. something. */
function countsIn(lua: string): string[] {
  const out = new Set<string>();
  for (const m of lua.matchAll(/count\('([a-z_]+)'(\s*\.\.)?/g)) out.add(m[2] ? `${m[1]}*` : m[1]!);
  return [...out];
}

describe('the counters', () => {
  it('are each listed with a unit and the transition that increments them, and every listed one is used', async () => {
    await import('../src/devices/scripts-api.ts');
    await import('../src/devices/scripts-delivery.ts');
    await import('../src/devices/limits.ts');
    await import('../src/devices/lock.ts');
    const used = new Set(DEVICE_SCRIPTS.flatMap((s) => countsIn(s.def.lua)));
    const listed = new Set(DEVICE_COUNTERS.map((c) => c.name));
    // A literal name is covered by its own row or by a family's ("claims_*" covers "claims_recovered").
    const covered = (name: string) => listed.has(name) || (!name.endsWith('*') && [...listed].some((l) => l.endsWith('*') && name.startsWith(l.slice(0, -1))));
    for (const name of used) expect([name, covered(name)]).toEqual([name, true]);
    const outsideScripts = [
      'requests_refused_mode', 'requests_refused_owner', 'requests_refused_endpoint', 'requests_refused_memory', 'cleanup_failures', 'tests_*',
      'fanout_skipped_size', 'fanout_skipped_memory', 'fanout_skipped_failed', 'fanout_skipped_entries', 'fanout_second_failures',
    ];
    for (const name of listed) expect([name, used.has(name) || outsideScripts.includes(name)]).toEqual([name, true]);
    for (const c of DEVICE_COUNTERS) expect(c.when.length).toBeGreaterThan(10);
  });

  it('cover every transition the spec\'s "Reporting" section names', () => {
    const required = [
      'ops_started', 'ops_active', 'ops_expired', 'ops_changed', 'ops_full', 'changes_applied', 'changes_refused',
      'requests_refused_dev-setup-ip', 'requests_refused_mode', 'requests_refused_owner', 'requests_refused_endpoint', 'requests_refused_memory', 'refused_full',
      'alerts_created', 'alerts_changed', 'alerts_off', 'alerts_ended', 'alerts_gone', 'alerts_replaced', 'rotations_completed',
      'claims_accepted', 'claims_gone', 'claims_refused', 'claims_unattempted', 'claims_rejected', 'claims_bug', 'claims_uncertain', 'claims_recovered',
      'dates_dropped_window', 'dates_dropped_tries', 'dates_dropped_overflow', 'dates_dropped_unknown_age', 'dates_held_cap', 'tests_accepted',
      'dispatch_accepted', 'dispatch_retryable', 'dispatch_uncertain',
    ];
    const listed = DEVICE_COUNTERS.map((c) => c.name);
    const covered = (name: string) => listed.includes(name) || listed.some((l) => l.endsWith('*') && name.startsWith(l.slice(0, -1)));
    for (const name of required) expect([name, covered(name)]).toEqual([name, true]);
  });
});

describe('telemetry in the background', () => {
  it('starts at most 50 pieces at once, never starting new ones past that', async () => {
    const { later, pendingCount } = await import('../src/devices/counters.ts');
    let started = 0;
    for (let i = 0; i < 60; i++) later(() => ((started += 1), new Promise(() => {})));
    expect([started, pendingCount()]).toEqual([50, 50]);
  });
});
