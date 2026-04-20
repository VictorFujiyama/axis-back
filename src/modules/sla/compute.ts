/**
 * SLA + business hours compute. Config lives in `inbox.config` as:
 *
 *   businessHours: {
 *     timezone: 'America/Sao_Paulo',
 *     weekdays: [{ day: 1, from: '09:00', to: '18:00' }, ...],  // 0=Sunday
 *     holidays: ['2026-12-25', ...],  // ISO dates
 *     outOfHoursReply?: string,
 *   }
 *   sla: {
 *     firstResponseSec: number,
 *     resolutionSec: number,
 *   }
 *
 * Compute is synchronous and takes a snapshot of the conversation + inbox config.
 * Status is one of: 'ok' | 'warning' | 'breached' | null.
 *  - null: no SLA configured (or conversation resolved/snoozed)
 *  - ok: progress < 80% of target
 *  - warning: 80% <= progress < 100%
 *  - breached: progress >= 100%
 */

export interface SlaConfig {
  firstResponseSec?: number;
  resolutionSec?: number;
}

export interface BusinessHoursConfig {
  timezone?: string;
  weekdays?: Array<{ day: number; from: string; to: string }>;
  holidays?: string[];
  outOfHoursReply?: string;
}

export interface SlaInput {
  status: string;
  createdAt: Date;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
}

export interface SlaResult {
  status: 'ok' | 'warning' | 'breached' | null;
  target: 'first_response' | 'resolution' | null;
  deadlineAt: string | null;
  elapsedSec: number | null;
  targetSec: number | null;
}

function bucket(elapsed: number, target: number): SlaResult['status'] {
  if (target <= 0) return null;
  const pct = elapsed / target;
  if (pct >= 1) return 'breached';
  if (pct >= 0.8) return 'warning';
  return 'ok';
}

/** Compute SLA snapshot at `now`. Does NOT adjust for business hours —
 *  intentional simplification: SLA clock runs wall-clock. Upgrade later. */
export function computeSla(
  input: SlaInput,
  sla: SlaConfig | undefined,
  now: Date = new Date(),
): SlaResult {
  const none: SlaResult = { status: null, target: null, deadlineAt: null, elapsedSec: null, targetSec: null };
  if (!sla) return none;
  if (input.status === 'resolved' || input.status === 'snoozed') return none;

  // First response: from createdAt → firstResponseAt (when agent sent first msg)
  if (!input.firstResponseAt && sla.firstResponseSec) {
    const elapsed = (now.getTime() - input.createdAt.getTime()) / 1000;
    const deadline = new Date(input.createdAt.getTime() + sla.firstResponseSec * 1000);
    return {
      status: bucket(elapsed, sla.firstResponseSec),
      target: 'first_response',
      deadlineAt: deadline.toISOString(),
      elapsedSec: Math.floor(elapsed),
      targetSec: sla.firstResponseSec,
    };
  }

  // Resolution target
  if (sla.resolutionSec) {
    const elapsed = (now.getTime() - input.createdAt.getTime()) / 1000;
    const deadline = new Date(input.createdAt.getTime() + sla.resolutionSec * 1000);
    return {
      status: bucket(elapsed, sla.resolutionSec),
      target: 'resolution',
      deadlineAt: deadline.toISOString(),
      elapsedSec: Math.floor(elapsed),
      targetSec: sla.resolutionSec,
    };
  }

  return none;
}

/** Returns true iff `when` falls within configured business hours. */
export function isWithinBusinessHours(
  when: Date,
  cfg: BusinessHoursConfig | undefined,
): boolean {
  if (!cfg?.weekdays?.length) return true; // no config = always "in hours"
  const tz = cfg.timezone ?? 'UTC';
  // Use Intl.DateTimeFormat to get parts in configured timezone.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(when);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayStr = get('weekday');
  const iso = `${get('year')}-${get('month')}-${get('day')}`;
  if (cfg.holidays?.includes(iso)) return false;

  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const day = weekdayMap[weekdayStr];
  const todaysHours = cfg.weekdays.filter((w) => w.day === day);
  if (todaysHours.length === 0) return false;
  const hourMin = `${get('hour')}:${get('minute')}`;
  return todaysHours.some((w) => hourMin >= w.from && hourMin < w.to);
}
