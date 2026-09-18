// Upstash Redis over REST, using only the built-in fetch().
//
// Reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
// Also accepts KV_REST_API_URL / KV_REST_API_TOKEN, the names Vercel's
// storage integration sometimes creates, so either setup works.

export class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function cleanEnv(value) {
  return String(value || "").trim().replace(/^["']+|["']+$/g, "").trim();
}

export function readRedisConfig() {
  let url = cleanEnv(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
  const token = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);

  if (!url || !token) {
    throw new StorageError(
      "missing_env",
      "UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is not set for this deployment."
    );
  }

  if (/^rediss?:\/\//i.test(url)) {
    throw new StorageError(
      "wrong_url_format",
      "The Redis URL is a redis:// connection string. Use the REST URL that starts with https:// instead."
    );
  }

  if (!/^https?:\/\//i.test(url)) url = `https://${url}`; // tolerate a bare hostname
  url = url.replace(/\/+$/, "");

  return { url, token };
}

export async function redis(command) {
  const { url, token } = readRedisConfig();

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) {
    throw new StorageError("unreachable", `Could not reach Redis: ${err.message}`);
  }

  let data = null;
  try { data = await response.json(); } catch { /* non-JSON response */ }

  if (response.status === 401 || response.status === 403) {
    throw new StorageError(
      "bad_token",
      (data && data.error) || `Redis rejected the token (HTTP ${response.status}).`
    );
  }

  if (!response.ok || !data || data.error) {
    throw new StorageError("redis_error", (data && data.error) || `Redis responded with HTTP ${response.status}.`);
  }
  return data.result;
}

export function sendStorageError(res, err, where) {
  console.error(`[${where}] storage error:`, err.code, err.message);
  return res.status(503).json({
    error: "storage_unavailable",
    reason: err.code || "unknown",
    message: "The booking database isn't reachable right now."
  });
}
