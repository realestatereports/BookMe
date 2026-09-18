// Upstash Redis over REST, using only the built-in fetch().

export class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new StorageError("missing_env", "UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is not set.");
  }

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
