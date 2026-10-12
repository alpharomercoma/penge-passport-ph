// How far apart two alerts to one person (email) or one alert (notifications) may be; see checker.ts for why.
import type { Pace } from '@penge/contracts';

export const PACE_SPACING_MS: Record<Pace, number> = { hourly: 60 * 60_000, asap: 2 * 60_000 };
