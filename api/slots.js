// GET /api/slots?date=YYYY-MM-DD&tz=Visitor/Timezone
//
// `date` is a calendar day in the VISITOR's timezone (`tz`).
// Returns open 30-minute slots as UTC ISO strings, excluding booked
// or blocked slots and anything inside the 2-hour notice period.

import { redis, sendStorageError } from "./_lib/redis.js";
import {
  loadSchedule, slotsForVisitorDay, parseDateKey, daysFromTodayUtc,
  isValidTimeZone, MAX_DAYS_AHEAD, MIN_NOTICE_MINUTES
} from "./_lib/schedule.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed", message: "Use GET." });
  }

  // ---- Validate input ----
  const date = String(req.query.date || "");
  const day = parseDateKey(date);
  if (!day) {
    return res.status(400).json({ error: "invalid_date", message: "Pass ?date=YYYY-MM-DD." });
  }

  const nowMs = Date.now();
  const daysAhead = daysFromTodayUtc(day, nowMs);
  if (daysAhead < -1 || daysAhead > MAX_DAYS_AHEAD) {
    return res.status(400).json({ error: "date_out_of_range", message: "That date can't be booked." });
  }

  // ---- Load availability ----
  let schedule;
  try {
    schedule = await loadSchedule();
  } catch (err) {
    return sendStorageError(res, err, "api/slots");
  }

  if (!schedule.configured) {
    return res.status(200).json({
      configured: false,
      slots: [],
      adminTimezone: schedule.adminTimezone,
      message: "Availability hasn't been set up yet. Save weekly hours and a timezone in the admin view."
    });
  }

  const visitorTz = isValidTimeZone(req.query.tz) ? req.query.tz : schedule.adminTimezone;

  // ---- Generate slots (already excludes past + 2-hour notice) ----
  let slotList = slotsForVisitorDay({
    availability: schedule.availability,
    adminTimezone: schedule.adminTimezone,
    date,
    visitorTz,
    nowMs
  });

  // ---- Remove booked / blocked slots ----
  if (slotList.length) {
    let booked;
    try {
      booked = await redis(["HMGET", "bookedSlots", ...slotList]);
    } catch (err) {
      return sendStorageError(res, err, "api/slots");
    }
    slotList = slotList.filter((_, i) => !(booked && booked[i]));
  }

  return res.status(200).json({
    configured: true,
    date,
    timeZone: visitorTz,
    adminTimezone: schedule.adminTimezone,
    minNoticeMinutes: MIN_NOTICE_MINUTES,
    slots: slotList.map((slotUtc) => ({ slotUtc }))
  });
}
