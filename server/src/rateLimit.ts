interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 5;
const buckets = new Map<string, RateLimitEntry>();

function getClientKey(ip: string | undefined) {
  return ip?.trim() || 'unknown';
}

export function resetRateLimits() {
  buckets.clear();
}

export function consumeRateLimit(ip: string | undefined) {
  const key = getClientKey(ip);
  const now = Date.now();
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    const next = {
      count: 1,
      resetAt: now + WINDOW_MS,
    };
    buckets.set(key, next);
    return {
      allowed: true,
      remaining: MAX_REQUESTS - next.count,
      resetAt: next.resetAt,
    };
  }

  if (current.count >= MAX_REQUESTS) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: current.resetAt,
    };
  }

  current.count += 1;
  return {
    allowed: true,
    remaining: MAX_REQUESTS - current.count,
    resetAt: current.resetAt,
  };
}
