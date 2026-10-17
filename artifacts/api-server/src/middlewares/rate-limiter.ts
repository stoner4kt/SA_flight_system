import type { RequestHandler } from "express";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface CloudflareKvBinding {
  get(key: string, options: { type: "json" }): Promise<RateLimitEntry | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
}

const memoryEntries = new Map<string, RateLimitEntry>();
let requestCount = 0;

function getClientIp(req: Parameters<RequestHandler>[0]): string {
  const cfIp = req.header("cf-connecting-ip");
  if (cfIp) return cfIp.trim();

  const forwarded = req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";

  return req.socket.remoteAddress ?? "unknown";
}

function getKvBinding(): CloudflareKvBinding | undefined {
  return (globalThis as typeof globalThis & {
    __CF_KV_RATE_LIMIT__?: CloudflareKvBinding;
  }).__CF_KV_RATE_LIMIT__;
}

function cleanupExpired(now: number): void {
  for (const [key, entry] of memoryEntries) {
    if (entry.resetAt <= now) memoryEntries.delete(key);
  }
}

export function rateLimiter(maxRequests: number, windowMs: number): RequestHandler {
  return async (req, res, next): Promise<void> => {
    const now = Date.now();
    const ip = getClientIp(req);
    const key = `rl:${ip}`;
    const kv = getKvBinding();

    try {
      let entry: RateLimitEntry | null;
      if (kv) {
        entry = await kv.get(key, { type: "json" });
        if (!entry || entry.resetAt <= now) {
          entry = { count: 0, resetAt: now + windowMs };
        }
      } else {
        entry = memoryEntries.get(key) ?? null;
        if (!entry || entry.resetAt <= now) {
          entry = { count: 0, resetAt: now + windowMs };
        }
      }

      entry.count += 1;
      const ttlSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      if (kv) {
        await kv.put(key, JSON.stringify(entry), { expirationTtl: ttlSeconds });
      } else {
        memoryEntries.set(key, entry);
        requestCount += 1;
        if (requestCount % 100 === 0) cleanupExpired(now);
      }

      if (entry.count > maxRequests) {
        res.setHeader("Retry-After", String(ttlSeconds));
        res.status(429).json({
          error: "RATE_LIMITED",
          message: "Too many requests. Please try again later.",
        });
        return;
      }

      next();
    } catch {
      req.log.error({ code: "RATE_LIMIT_STORAGE_ERROR" }, "Rate limiter storage failed");
      res.status(503).json({
        error: "RATE_LIMIT_UNAVAILABLE",
        message: "This request cannot be processed right now.",
      });
    }
  };
}
