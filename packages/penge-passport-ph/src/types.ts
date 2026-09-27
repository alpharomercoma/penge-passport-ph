export interface Region {
  id: number;
  name: string;
}

export interface Country {
  id: number;
  name: string;
}

export interface Site {
  id: number;
  name: string;
  /** e.g. "DFA Regional Consular Office - Antipolo" */
  description: string | null;
  address: string | null;
  telephone: string | null;
  /** Free-text office hours as published, e.g. "7:30 AM to 3:30 PM". */
  hours: string | null;
  mapUrl: string | null;
  /** Site's UTC offset in minutes (480 for the Philippines). */
  utcOffsetMinutes: number | null;
}

export interface DayAvailability {
  /** Calendar date at the site, `YYYY-MM-DD`. */
  date: string;
  /** True when the day still has room for the requested number of applicants. */
  available: boolean;
}

export interface AvailabilityQuery {
  siteId: number;
  /** First date to check, `YYYY-MM-DD`. Defaults to the server's "today". */
  from?: string;
  /** Last date to check, `YYYY-MM-DD`. Defaults to the server's booking horizon. */
  to?: string;
  /** People in the booking: 1 for an individual appointment, more for a group. Default 1. */
  applicants?: number;
  signal?: AbortSignal;
}

export interface Availability {
  siteId: number;
  from: string;
  to: string;
  applicants: number;
  /** Earliest date with availability, or null when fully booked. */
  earliest: string | null;
  availableDates: string[];
  /**
   * Every date the server has opened for booking in the range. Dates it has
   * not opened yet (weekends, holidays, beyond the release window) are absent.
   */
  days: DayAvailability[];
  /** When this data was fetched from the server (ISO 8601). */
  fetchedAt: string;
  /** True when served from the local cache without a network request. */
  cached: boolean;
}

export interface TimeSlotQuery {
  siteId: number;
  /** `YYYY-MM-DD` */
  date: string;
  /** People in the booking. Default 1. */
  applicants?: number;
  signal?: AbortSignal;
}

/** One hourly time slot on a date. "Slot" in this package always means this. */
export interface TimeSlot {
  /** `HH:MM`, site-local */
  start: string;
  /** `HH:MM`, site-local */
  end: string;
  available: boolean;
  /** Places left in this slot, when the server says. */
  remaining: number | null;
  /** Status text as shown on the site, e.g. "Available Slots: 1" or "Fully Booked". */
  status: string;
  /** Extra note the site attaches to some slots. */
  note: string | null;
}
