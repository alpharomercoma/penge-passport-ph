import { describe, expect, it } from 'vitest';
import { buildPayload } from '../src/push/payload.ts';

describe('an alert notification', () => {
  it('says when its dates were checked, in Manila time', () => {
    const p = JSON.parse(buildPayload({ openings: [{ id: 486, name: 'Antipolo', dates: ['2026-10-09'] }], applicants: 2, decisionId: 'd1', checkedAt: Date.parse('2026-10-06T02:42:00Z') }));
    expect(p).toMatchObject({ v: 1, title: 'Dates open at Antipolo', tag: 'alert-d1', url: { office: 486, date: '2026-10-09', people: 2 } });
    expect(p.body).toBe('Fri 9 Oct · for 2 people · Checked 10:42');
  });

  it('keeps the largest real alert under 3,000 bytes: 10 offices abroad with long names, 5 people, 30 dates', () => {
    const name = 'Ciudad Autónoma de Buenos Aires (Philippine Embassy in the Argentine Republic, Argentina)';
    const openings = Array.from({ length: 10 }, (_, i) => ({ id: 9000 + i, name: `${name} ${i}`, dates: Array.from({ length: 3 }, (_, j) => `2026-11-${String(i * 3 + j + 1).padStart(2, '0')}`) }));
    const p = buildPayload({ openings, applicants: 5, decisionId: 'x'.repeat(22), checkedAt: Date.parse('2026-10-06T02:42:00Z') });
    expect(Buffer.byteLength(p)).toBeLessThan(3000);
    expect(JSON.parse(p).title).toBe('Dates open at 10 offices');
  });
});
