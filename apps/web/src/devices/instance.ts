// One controller per page, for the row and the form.
import type { StatusResponse } from '@penge/contracts';
import { deviceApi } from './api.ts';
import { browserEnv, realBrowser } from './browser.ts';
import { DeviceController } from './controller.ts';
import { forgetOwner, ownerToken } from './owner.ts';

let one: DeviceController | null = null;
/** The latest status any caller gave: the one controller always reads the current VAPID key. */
let latest: () => StatusResponse | null = () => null;

export function deviceController(status: () => StatusResponse | null): DeviceController {
  latest = status;
  one ??= new DeviceController({
    env: browserEnv(),
    api: deviceApi,
    browser: realBrowser(),
    now: Date.now,
    mono: () => performance.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ownerToken: () => ownerToken(),
    forgetOwner: () => forgetOwner(),
    vapidKey: () => latest()?.vapidPublicKey ?? null,
  });
  return one;
}
