// Shared slot rules for /api/slots, /api/book and /api/admin.
//
// Redis keys:
//   availability   JSON string: {"mon":[{"start":"10:00","end":"17:00"}], ...}
//   adminTimezone  IANA name, e.g. "Asia/Kolkata"
//   bookedSlots    hash: field = slotUtc (ISO string), value = booking id or "blocked"

import { redis } from "./redis.js";

export const SLOT_MINUTES = 30;
export const MIN_NOTICE_MINUTES = 120; // bookings need at least 2 hours' notice
export const MAX_DAYS_AHEAD = 60;

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_MS = 24 * 60 * 60 * 1000;

export function earliestBookableMs(nowMs) {
  return nowMs + MIN_NOTICE_MINUTES * 60 * 1000;
}

/* ============================================================
   Load availability from Redis
   ============================================================ */

export async function loadSchedule() {
  const [rawAvailability, rawAdminTz] = (await redis(["MGET", "availability", "adminTimezone"])) || [];
  const adminTimezone = isValidTimeZone(rawAdminTz) ? rawAdminTz : null;
  const availability = parseAvailability(rawAvailability);
  return {
    configured: Boolean(availability && adminTimezone),
    availability,
    adminTimezone
  };
}

/* ============================================================
   Generate open slots for one day in the VISITOR's timezone
   (before removing booked ones). Returns sorted UTC ISO strings.
   ============================================================ */

export function slotsForVisitorDay({ availability, adminTimezone, date, visitorTz, nowMs }) {
  const day = parseDateKey(date);
  if (!day) return [];

  const cutoff = earliestBookableMs(nowMs);
  const candidates = new Set();

  // Timezones can differ by up to 26 hours, so check admin days D-2..D+2
  // and keep only slots that fall on the visitor's requested day.
  for (let offset = -2; offset <= 2; offset++) {
    const adminDay = addDays(day, offset);
    for (const { start, end } of windowsFor(availability, adminDay)) {
      for (let m = start; m + SLOT_MINUTES <= end; m += SLOT_MINUTES) {
        const utcMs = zonedTimeToUtc(adminDay.y, adminDay.m, adminDay.d, Math.floor(m / 60), m % 60, adminTimezone);
        if (utcMs === null) continue;                          // skipped by a DST jump
        if (utcMs < cutoff) continue;                          // past, or inside the notice period
        if (dateKeyInZone(utcMs, visitorTz) !== date) continue; // not on the visitor's day
        candidates.add(new Date(utcMs).toISOString());
      }
    }
  }

  return [...candidates].sort(); // ISO strings sort chronologically
}

/* ============================================================
   Check that one slotUtc is a genuine open slot (ignores bookings).
   Returns { ok: true, ms } or { ok: false, reason }.
   ============================================================ */

export function checkSlot(slotUtc, { availability, adminTimezone, nowMs }) {
  if (typeof slotUtc !== "string") return { ok: false, reason: "invalid" };

  const ms = Date.parse(slotUtc);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== slotUtc) {
    return { ok: false, reason: "invalid" };
  }
  if (ms < earliestBookableMs(nowMs)) return { ok: false, reason: "too_soon" };
  if (ms > nowMs + (MAX_DAYS_AHEAD + 1) * DAY_MS) return { ok: false, reason: "too_far" };

  const p = zonedParts(ms, adminTimezone);
  if (p.s !== 0) return { ok: false, reason: "not_open" };

  const minute = p.h * 60 + p.min;
  const fits = windowsFor(availability, p).some(({ start, end }) =>
    minute >= start &&
    minute + SLOT_MINUTES <= end &&
    (minute - start) % SLOT_MINUTES === 0
  );
  if (!fits) return { ok: false, reason: "not_open" };

  // Must match exactly what the slot generator would produce (DST edge cases).
  if (zonedTimeToUtc(p.y, p.m, p.d, p.h, p.min, adminTimezone) !== ms) {
    return { ok: false, reason: "not_open" };
  }
  return { ok: true, ms };
}

/* ============================================================
   Parsing helpers
   ============================================================ */

function windowsFor(availability, { y, m, d }) {
  const weekday = DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const raw = Array.isArray(availability[weekday]) ? availability[weekday] : [];
  return raw
    .map((win) => ({ start: toMinutes(win && win.start), end: toMinutes(win && win.end) }))
    .filter(({ start, end }) => start !== null && end !== null && end > start);
}

export function parseDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d };
}

export function daysFromTodayUtc({ y, m, d }, nowMs) {
  const now = new Date(nowMs);
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return (Date.UTC(y, m - 1, d) - todayUtc) / DAY_MS;
}

function addDays({ y, m, d }, offset) {
  const t = new Date(Date.UTC(y, m - 1, d + offset));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function toMinutes(hhmm) {
  const match = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(String(hhmm || ""));
  if (!match) return null;
  const total = Number(match[1]) * 60 + Number(match[2]);
  return total <= 1440 ? total : null;
}

function parseAvailability(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/* ============================================================
   Timezone math with Intl only (no libraries)
   ============================================================ */

const formatterCache = new Map();

function formatterFor(tz) {
  if (!formatterCache.has(tz)) {
    formatterCache.set(tz, new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }));
  }
  return formatterCache.get(tz);
}

// Wall-clock parts of a UTC instant in a given timezone.
function zonedParts(ms, tz) {
  const p = {};
  for (const { type, value } of formatterFor(tz).formatToParts(new Date(ms))) p[type] = value;
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    h: Number(p.hour) % 24, min: Number(p.minute), s: Number(p.second)
  };
}

// How far ahead of UTC the timezone is at that instant, in ms.
function offsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  const wallAsUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

// Admin wall-clock time → UTC ms. Returns null if that local time
// doesn't exist (skipped by a daylight-saving jump).
function zonedTimeToUtc(y, m, d, h, min, tz) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let utc = guess - offsetMs(guess, tz);
  utc = guess - offsetMs(utc, tz); // re-check across DST boundaries

  const back = zonedParts(utc, tz);
  if (back.y !== y || back.m !== m || back.d !== d || back.h !== h || back.min !== min) return null;
  return utc;
}

function dateKeyInZone(ms, tz) {
  const p = zonedParts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
