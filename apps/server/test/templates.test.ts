import { describe, expect, it } from 'vitest';
import { confirmationEmail } from '../src/templates.ts';

describe('confirmation email', () => {
  it('says the channels, and the asking device, before the link', () => {
    const m = confirmationEmail({
      confirmUrl: 'https://penge.example/confirm#token=x', sites: [{ id: 486, name: 'Antipolo (SM Center)' }], applicants: 1, pace: 'asap',
      channels: { emailOn: false, pushOn: true, device: 'Chrome on Android', requestedAt: '2026-10-05T02:02:00.000Z', devicesKept: 0 },
    });
    expect(m.text).toMatch(/Email: off/);
    expect(m.text).toMatch(/Notifications: on, for the device and browser that asked \(Chrome on Android, Mon 5 Oct, 10:02\)/);
    expect(m.text.indexOf('Notifications: on')).toBeLessThan(m.text.indexOf('https://penge.example/confirm'));
    expect(m.html).toContain('Chrome on Android');
    expect(m.text).toMatch(/If you did not ask for this, ignore this email/);
  });

  it('reads as before for a request from a page without channels', () => {
    const m = confirmationEmail({ confirmUrl: 'u', sites: [], applicants: 1, pace: 'hourly' });
    expect(m.text).not.toMatch(/Notifications:/);
  });

  it('says email is on, and that devices with notifications keep them, for an email-only request', () => {
    const m = confirmationEmail({ confirmUrl: 'u', sites: [], applicants: 1, pace: 'hourly', channels: { emailOn: true, pushOn: false, device: null, requestedAt: '2026-10-05T02:02:00.000Z', devicesKept: 1 } });
    expect(m.text).toMatch(/Email: on/);
    expect(m.text).toMatch(/Notifications: none added by this request\./);
    expect(m.text).toMatch(/The 1 device that already gets notifications keeps them\./);
    expect(m.text).not.toMatch(/Notifications: off/);
  });

  it('escapes the device label in the HTML', () => {
    const m = confirmationEmail({ confirmUrl: 'u', sites: [], applicants: 1, pace: 'hourly', channels: { emailOn: true, pushOn: true, device: "O'Brien's", requestedAt: '2026-10-05T02:02:00.000Z', devicesKept: 0 } });
    expect(m.html).toContain('O&#39;Brien&#39;s');
  });

  it('never promises email for a request that turns email off', () => {
    const push = confirmationEmail({ confirmUrl: 'u', sites: [], applicants: 1, pace: 'asap', channels: { emailOn: false, pushOn: true, device: 'Chrome on Android', requestedAt: '2026-10-05T02:02:00.000Z', devicesKept: 0 } });
    for (const part of [push.text, push.html]) {
      expect(part).not.toMatch(/email this address|We email/);
      expect(part).toMatch(/notifications/);
    }
    const both = confirmationEmail({ confirmUrl: 'u', sites: [], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: true, device: 'Chrome on Android', requestedAt: '2026-10-05T02:02:00.000Z', devicesKept: 0 } });
    expect(both.text).toMatch(/email this address/);
    // A page from before channels, for an address that has email off: worded as notifications too.
    const old = confirmationEmail({ confirmUrl: 'u', sites: [], applicants: 1, pace: 'asap', emailOn: false });
    expect(old.text).not.toMatch(/email this address|We email/);
  });

  it('never says nothing will be sent, since alerts already on go on', () => {
    for (const m of [
      confirmationEmail({ confirmUrl: 'u', sites: [], applicants: 1, pace: 'hourly' }),
      confirmationEmail({ confirmUrl: 'u', sites: [], applicants: 1, pace: 'hourly', channels: { emailOn: true, pushOn: false, device: null, requestedAt: '2026-10-05T02:02:00.000Z', devicesKept: 1 } }),
    ]) {
      expect(m.text).not.toMatch(/nothing will be sent/);
      expect(m.html).not.toMatch(/nothing will be sent/);
      expect(m.text).toMatch(/ignore this email: nothing changes/);
    }
  });
});
