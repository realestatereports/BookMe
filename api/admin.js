// POST /api/admin  { password, action, payload }
//
// The password is checked against process.env.ADMIN_PASSWORD on every request.
//
// Actions:
//   getBookings      → { bookings:[...], blocks:[...] }   (last 30 days + upcoming, sorted by time)
//   getAvailability  → { configured, availability, adminTimezone }
//   setAvailability  payload { availability:{mon:[{start,end}],...}, timezone }
//   blockSlot        payload { slotUtc }   marks an open slot unavailable without a booking
//   unblockSlot      payload { slotUtc }   removes a block (never touches real bookings)
//
// Redis keys used:
//   bookings          sorted set: score = slot ms, member = booking id
//   booking:<id>      JSON booking record
//   bookedSlots       hash: slotUtc → booking id, or "blocked"
//   blocks            sorted set: score = slot ms, member = slotUtc
//   availability, adminTimezone
//   adminFails:<ip>   failed sign-in counter (expires after 15 minutes)

import { createHash, timingSafeEqual } from "node:crypto";
import { redis, StorageError, sendStorageError } from "./_lib/redis.js";
import { loadSchedule, checkSlot, isValidTimeZone, MIN_NOTICE_MINUTES } from "./_lib/schedule.js";

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday"
};
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 30;
const MAX_WINDOWS_PER_DAY = 6;
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_SECONDS = 15 * 60;

const BLOCK_MESSAGES = {
  invalid: "Pick a time from your open slots.",
  too_soon: `That time is less than ${MIN_NOTICE_MINUTES / 60} hours away, so visitors already can't book it.`,
  too_far: "That time is too far ahead to block.",
  not_open: "That time isn't one of your open slots."
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed", message: "Use POST." });
  }

  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return res.status(500).json({
      error: "admin_not_configured",
      message: "Admin isn't set up yet. Add ADMIN_PASSWORD in your Vercel environment variables, then redeploy."
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "invalid_body", message: "Send a JSON body." });
  }

  try {
    await verifyPassword(req, body.password, expected);
    const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
    const result = await runAction(String(body.action || ""), payload);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    if (err instanceof StorageError) {
      return sendStorageError(res, err, "api/admin");
    }
    console.error("[api/admin] unexpected error:", err);
    return res.status(500).json({ error: "internal_error", message: "Something went wrong. Try again." });
  }
}

/* ============================================================
   Auth
   ============================================================ */

async function verifyPassword(req, given, expected) {
  const failKey = `adminFails:${clientIp(req)}`;
  const fails = Number(await redis(["GET", failKey])) || 0;

  if (fails >= MAX_FAILED_ATTEMPTS) {
    throw new HttpError(429, "too_many_attempts", "Too many wrong passwords. Try again in 15 minutes.");
  }

  if (!passwordMatches(given, expected)) {
    const count = await redis(["INCR", failKey]);
    if (count === 1) await redis(["EXPIRE", failKey, String(LOCKOUT_SECONDS)]);
    throw new HttpError(401, "wrong_password", "That password isn't right.");
  }

  if (fails > 0) await redis(["DEL", failKey]);
}

// Constant-time comparison (hashing first makes both sides equal length).
function passwordMatches(given, expected) {
  if (typeof given !== "string" || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || String(req.headers["x-real-ip"] || "unknown");
}

/* ============================================================
   Actions
   ============================================================ */

async function runAction(action, payload) {
  switch (action) {
    case "getBookings":     return getBookings();
    case "getAvailability": return getAvailability();
    case "setAvailability": return setAvailability(payload);
    case "blockSlot":       return blockSlot(payload);
    case "unblockSlot":     return unblockSlot(payload);
    default:
      throw new HttpError(400, "unknown_action",
        "Unknown action. Use getBookings, getAvailability, setAvailability, blockSlot or unblockSlot.");
  }
}

async function getBookings() {
  const since = String(Date.now() - HISTORY_DAYS * DAY_MS);

  const [ids, blockedSlots] = await Promise.all([
    redis(["ZRANGEBYSCORE", "bookings", since, "+inf", "LIMIT", "0", "1000"]),
    redis(["ZRANGEBYSCORE", "blocks", since, "+inf", "LIMIT", "0", "1000"])
  ]);

  let bookings = [];
  if (Array.isArray(ids) && ids.length) {
    const raws = await redis(["MGET", ...ids.map((id) => `booking:${id}`)]);
    bookings = (raws || [])
      .map(parseJson)
      .filter((b) => b && b.slotUtc)
      .map((b) => ({
        id: b.id,
        slotUtc: b.slotUtc,
        name: b.name,
        email: b.email,
        visitorTimeZone: b.visitorTimeZone || null,
        bookedAt: b.bookedAt || b.createdAt || null
      }))
      .sort((a, b) => Date.parse(a.slotUtc) - Date.parse(b.slotUtc));
  }

  const blocks = (Array.isArray(blockedSlots) ? blockedSlots : []).map((slotUtc) => ({ slotUtc }));
  return { bookings, blocks };
}

async function getAvailability() {
  const schedule = await loadSchedule();
  return {
    configured: schedule.configured,
    availability: schedule.availability || {},
    adminTimezone: schedule.adminTimezone
  };
}

async function setAvailability({ availability, timezone }) {
  if (!isValidTimeZone(timezone)) {
    throw new HttpError(400, "invalid_timezone", "Pick a valid timezone.");
  }
  if (!availability || typeof availability !== "object" || Array.isArray(availability)) {
    throw new HttpError(400, "invalid_availability", "Send weekly hours as {mon:[{start,end}], ...}.");
  }

  const unknown = Object.keys(availability).filter((k) => !DAY_KEYS.includes(k));
  if (unknown.length) {
    throw new HttpError(400, "invalid_availability", `"${unknown[0]}" isn't a day. Use mon, tue, wed, thu, fri, sat, sun.`);
  }

  const clean = {};
  for (const day of DAY_KEYS) {
    const raw = availability[day] ?? [];
    if (!Array.isArray(raw)) {
      throw new HttpError(400, "invalid_availability", `${DAY_NAMES[day]} must be a list of time ranges.`);
    }
    if (raw.length > MAX_WINDOWS_PER_DAY) {
      throw new HttpError(400, "invalid_availability", `${DAY_NAMES[day]} has too many time ranges.`);
    }

    const windows = raw.map((w) => {
      const start = String((w && w.start) ?? "");
      const end = String((w && w.end) ?? "");
      const s = toMinutes(start);
      const e = toMinutes(end);
      if (s === null || e === null) {
        throw new HttpError(400, "invalid_time", `${DAY_NAMES[day]}: use times like 09:00 and 17:30.`);
      }
      if (e - s < 30) {
        throw new HttpError(400, "invalid_range", `${DAY_NAMES[day]} needs at least 30 minutes between start and end.`);
      }
      return { start, end, s, e };
    }).sort((a, b) => a.s - b.s);

    for (let i = 1; i < windows.length; i++) {
      if (windows[i].s < windows[i - 1].e) {
        throw new HttpError(400, "invalid_range", `${DAY_NAMES[day]} has overlapping time ranges.`);
      }
    }

    clean[day] = windows.map(({ start, end }) => ({ start, end }));
  }

  await redis(["MSET", "availability", JSON.stringify(clean), "adminTimezone", timezone]);
  return { availability: clean, adminTimezone: timezone };
}

async function blockSlot({ slotUtc }) {
  slotUtc = String(slotUtc || "");

  const schedule = await loadSchedule();
  if (!schedule.configured) {
    throw new HttpError(409, "not_configured", "Save your weekly hours before blocking times.");
  }

  const check = checkSlot(slotUtc, { ...schedule, nowMs: Date.now() });
  if (!check.ok) {
    throw new HttpError(check.reason === "invalid" ? 400 : 409, "cannot_block", BLOCK_MESSAGES[check.reason]);
  }

  // Same atomic lock as bookings, so a block and a booking can never both win.
  const claimed = await redis(["HSETNX", "bookedSlots", slotUtc, "blocked"]);
  if (claimed !== 1) {
    const existing = await redis(["HGET", "bookedSlots", slotUtc]);
    if (existing === "blocked") return { slotUtc, alreadyBlocked: true };
    throw new HttpError(409, "slot_booked", "Someone has already booked that time.");
  }

  try {
    await redis(["ZADD", "blocks", String(check.ms), slotUtc]);
  } catch (err) {
    try { await redis(["HDEL", "bookedSlots", slotUtc]); } catch { /* best effort */ }
    throw err;
  }

  return { slotUtc };
}

async function unblockSlot({ slotUtc }) {
  slotUtc = String(slotUtc || "");
  if (!slotUtc) throw new HttpError(400, "invalid_slot", "Say which time to unblock.");

  const existing = await redis(["HGET", "bookedSlots", slotUtc]);

  if (existing === null) {
    await redis(["ZREM", "blocks", slotUtc]); // tidy a stale entry
    return { slotUtc, alreadyFree: true };
  }
  if (existing !== "blocked") {
    throw new HttpError(409, "slot_booked", "That time has a real booking, so it can't be unblocked here.");
  }

  await redis(["HDEL", "bookedSlots", slotUtc]);
  await redis(["ZREM", "blocks", slotUtc]);
  return { slotUtc };
}

/* ============================================================
   Helpers
   ============================================================ */

function toMinutes(hhmm) {
  const match = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(hhmm);
  if (!match) return null;
  const total = Number(match[1]) * 60 + Number(match[2]);
  return total <= 1440 ? total : null;
}

function parseJson(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}
