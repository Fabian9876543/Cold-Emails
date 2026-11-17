import { DateTime } from "luxon";

// Zeitplanung für den Versand: Versandfenster, Follow-up-Termine und Abstände zwischen Mails.

export interface SendWindow {
  timezone: string;
  /** ISO-Wochentage: 1 = Montag … 7 = Sonntag */
  sendDays: number[];
  /** "HH:MM" */
  start: string;
  end: string;
}

export const MIN_GAP_MS = 2 * 60 * 1000;

function hm(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(":").map((x) => Number(x));
  return { hour: Math.min(23, Math.max(0, h ?? 0)), minute: Math.min(59, Math.max(0, m ?? 0)) };
}

function windowBounds(day: DateTime, w: SendWindow): { start: DateTime; end: DateTime } {
  const s = hm(w.start);
  const e = hm(w.end);
  return {
    start: day.set({ hour: s.hour, minute: s.minute, second: 0, millisecond: 0 }),
    end: day.set({ hour: e.hour, minute: e.minute, second: 0, millisecond: 0 }),
  };
}

export function isValidWindow(w: SendWindow): boolean {
  const s = hm(w.start);
  const e = hm(w.end);
  return w.sendDays.length > 0 && e.hour * 60 + e.minute - (s.hour * 60 + s.minute) >= 30;
}

export function isWithinWindow(now: number, w: SendWindow): boolean {
  const dt = DateTime.fromMillis(now, { zone: w.timezone });
  if (!w.sendDays.includes(dt.weekday)) return false;
  const { start, end } = windowBounds(dt, w);
  return dt >= start && dt < end;
}

/** Ende des heutigen Versandfensters (ms). */
export function windowEndMs(now: number, w: SendWindow): number {
  return windowBounds(DateTime.fromMillis(now, { zone: w.timezone }), w).end.toMillis();
}

/** Beginn des heutigen Versandfensters (ms). */
export function windowStartMs(now: number, w: SendWindow): number {
  return windowBounds(DateTime.fromMillis(now, { zone: w.timezone }), w).start.toMillis();
}

/** Nächster Zeitpunkt, an dem das Fenster offen ist (oder jetzt, wenn es gerade offen ist). */
export function nextWindowOpening(now: number, w: SendWindow): number {
  if (isWithinWindow(now, w)) return now;
  let day = DateTime.fromMillis(now, { zone: w.timezone }).startOf("day");
  for (let i = 0; i < 8; i++) {
    if (w.sendDays.includes(day.weekday)) {
      const { start } = windowBounds(day, w);
      if (start.toMillis() > now) return start.toMillis();
    }
    day = day.plus({ days: 1 });
  }
  return now + 86_400_000;
}

/**
 * Termin für den nächsten Schritt: Kalendertag + Wartetage, nächster erlaubter Wochentag,
 * zufällige Uhrzeit innerhalb des Fensters (nicht in den letzten 15 Minuten).
 */
export function scheduleFollowUp(base: number, waitDays: number, w: SendWindow, random: () => number): number {
  let day = DateTime.fromMillis(base, { zone: w.timezone }).startOf("day").plus({ days: Math.max(0, waitDays) });
  for (let i = 0; i < 8 && !w.sendDays.includes(day.weekday); i++) day = day.plus({ days: 1 });
  const { start, end } = windowBounds(day, w);
  const span = Math.max(0, end.toMillis() - start.toMillis() - 15 * 60 * 1000);
  const at = start.toMillis() + Math.floor(random() * span);
  return Math.max(at, base + 60 * 60 * 1000);
}

/**
 * Abstand bis zur nächsten Mail desselben Postfachs: verbleibende Fensterzeit geteilt durch die
 * verbleibende Tagesquote (einschließlich der gerade gesendeten Mail), ±30 % Zufall, mindestens
 * 2 Minuten. So verteilen sich die Mails natürlich über den Tag, und die letzte Mail landet
 * noch vor Fensterende.
 */
export function computeGapMs(now: number, windowEnd: number, remainingQuota: number, random: () => number): number {
  const remainingWindow = Math.max(0, windowEnd - now);
  const avg = remainingQuota > 0 ? remainingWindow / remainingQuota : remainingWindow;
  const jitter = 0.7 + random() * 0.6;
  return Math.max(MIN_GAP_MS, Math.round(avg * jitter));
}

/** Kleiner, deterministischer Versatz je Postfach und Tag, damit nicht alle Postfächer um Punkt 8 Uhr starten. */
export function dailyStartOffsetMs(mailboxId: number, dayKey: string): number {
  let h = 2166136261;
  for (const ch of `${mailboxId}:${dayKey}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 20) * 60 * 1000;
}

export function dayKey(now: number, timezone: string): string {
  return DateTime.fromMillis(now, { zone: timezone }).toISODate() ?? "";
}

/** Beginn des nächsten Kalendertags in der Zeitzone. */
export function startOfNextDay(now: number, timezone: string): number {
  return DateTime.fromMillis(now, { zone: timezone }).startOf("day").plus({ days: 1 }).toMillis();
}
