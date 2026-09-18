// GET /api/health — confirms the API is running and diagnoses setup.
// Reports only whether settings exist (never their values) and whether
// Redis answers a PING.

import { redis } from "./_lib/redis.js";

const HINTS = {
  missing_env: "Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel (Production environment), then redeploy.",
  wrong_url_format: "You pasted the redis:// connection string. Use the REST URL (https://…upstash.io) from the Upstash console.",
  bad_token: "Redis rejected the token. Copy the REST token (not the read-only one) from the Upstash console, then redeploy.",
  unreachable: "The Redis URL couldn't be reached. Check it's the REST URL from the Upstash console and has no typos.",
  redis_error: "Redis returned an error. See 'detail'."
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const env = {
    redisUrl: Boolean(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL),
    redisToken: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN),
    adminPassword: Boolean(process.env.ADMIN_PASSWORD)
  };

  let storage;
  try {
    const pong = await redis(["PING"]);
    storage = { ok: pong === "PONG" };
  } catch (err) {
    storage = {
      ok: false,
      reason: err.code || "unknown",
      detail: err.message,
      fix: HINTS[err.code] || "Check the Vercel function logs for details."
    };
  }

  res.status(200).json({
    ok: true,
    time: new Date().toISOString(),
    env,
    redis: storage
  });
}
