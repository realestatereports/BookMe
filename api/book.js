// POST /api/book  { slotUtc, name, email, timeZone? }
//
// 1. Validates the input (name, email, slotUtc as a real future ISO timestamp).
// 2. Confirms slotUtc is a genuine open slot, at least 2 hours ahead.
// 3. Checks-and-claims the slot in ONE atomic Redis step (HSETNX):
//    if it's already booked, the request is refused. Two simultaneous
//    requests can never both win, unlike a separate read-then-write.
// 4. Saves {slotUtc, name, email, bookedAt} and returns {ok:true}.
//
// Redis keys written:
//   bookedSlots       hash: slotUtc → booking id   (the double-booking lock)
//   booking:<id>      JSON booking record
//   bookings          sorted set: score = slot time (ms), member = booking id

import { redis, sendStorageError } from "./_lib/redis.js";
import { loadSchedule, checkSlot, isValidTimeZone, MIN_NOTICE_MINUTES } from "./_lib/schedule.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SLOT_MESSAGES = {
  invalid: "That time isn't valid. Pick a time from the list.",
  too_soon: `Bookings need at least ${MIN_NOTICE_MINUTES / 60} hours' notice. Pick a later time.`,
  too_far: "That time is too far ahead to book. Pick an earlier date.",
  not_open: "That time isn't available. Pick another from the list."
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed", message: "Use POST." });
  }

  // ---- Parse + validate body ----
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "invalid_body", message: "Send a JSON body." });
  }

  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const slotUtc = String(body.slotUtc ?? "");
  const visitorTimeZone = isValidTimeZone(body.timeZone) ? body.timeZone : null;

  if (!name || name.length > 100) {
    return res.status(400).json({ error: "invalid_name", message: "Enter your name (up to 100 characters)." });
  }
  if (email.length > 200 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "invalid_email", message: "Enter a valid email address." });
  }

  // ---- Is this a real, bookable slot? (valid ISO, future, 2h notice, inside availability) ----
  let schedule;
  try {
    schedule = await loadSchedule();
  } catch (err) {
    return sendStorageError(res, err, "api/book");
  }

  if (!schedule.configured) {
    return res.status(409).json({ error: "not_accepting", message: "Bookings aren't open yet. Check back soon." });
  }

  const check = checkSlot(slotUtc, { ...schedule, nowMs: Date.now() });
  if (!check.ok) {
    return res.status(check.reason === "invalid" ? 400 : 409).json({
      error: "slot_unavailable",
      reason: check.reason,
      message: SLOT_MESSAGES[check.reason]
    });
  }

  // ---- Check + claim the slot atomically (server-side, at booking time) ----
  const id = globalThis.crypto.randomUUID();
  let claimed;
  try {
    claimed = await redis(["HSETNX", "bookedSlots", slotUtc, id]);
  } catch (err) {
    return sendStorageError(res, err, "api/book");
  }

  if (claimed !== 1) {
    return res.status(409).json({
      error: "slot_taken",
      message: "Sorry, someone booked that time just before you. Please pick another."
    });
  }

  // ---- Save the booking record ----
  const booking = {
    id,
    slotUtc,
    name,
    email,
    visitorTimeZone,
    bookedAt: new Date().toISOString()
  };

  try {
    await redis(["SET", `booking:${id}`, JSON.stringify(booking)]);
    await redis(["ZADD", "bookings", String(check.ms), id]);
  } catch (err) {
    // Release the slot so it doesn't stay blocked by a half-saved booking.
    try {
      await redis(["HDEL", "bookedSlots", slotUtc]);
      await redis(["DEL", `booking:${id}`]);
    } catch (rollbackErr) {
      console.error("[api/book] rollback failed:", rollbackErr.message);
    }
    return sendStorageError(res, err, "api/book");
  }

  return res.status(201).json({ ok: true, booking: { id, slotUtc } });
}
