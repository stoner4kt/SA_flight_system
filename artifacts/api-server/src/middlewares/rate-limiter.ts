import type { RequestHandler } from "express";
import { createHmac } from "node:crypto";
import { getAdminClient, safeDatabaseErrorCode } from "../lib/supabase-admin";

function getClientIp(req: Parameters<RequestHandler>[0]): string {
  const cfIp = req.header("cf-connecting-ip");
  if (cfIp) return cfIp.trim();

  const forwarded = req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",").at(-1)?.trim() || "unknown";

  return req.socket.remoteAddress ?? "unknown";
}

export function rateLimiter(maxRequests: number, windowMs: number): RequestHandler {
  return async (req, res, next): Promise<void> => {
    try {
      const hmacKey = process.env.POPIA_RATE_LIMIT_HMAC_KEY;
      if (!hmacKey || hmacKey.length < 32) {
        res.status(503).json({
          error: "RATE_LIMIT_NOT_CONFIGURED",
          message: "Privacy request protection is not configured.",
        });
        return;
      }
      const keyHash = createHmac("sha256", hmacKey).update(getClientIp(req)).digest("hex");
      const { data, error } = await getAdminClient().rpc("popia_consume_rate_limit", {
        p_key_hash: keyHash,
        p_max_requests: maxRequests,
        p_window_seconds: Math.max(1, Math.ceil(windowMs / 1000)),
      });
      if (error) throw error;
      const result = Array.isArray(data) ? data[0] as { allowed?: unknown; retry_after_seconds?: unknown } | undefined : undefined;
      if (!result || typeof result.allowed !== "boolean") {
        throw new Error("RATE_LIMIT_RPC_INVALID_RESPONSE");
      }
      if (!result.allowed) {
        const retryAfter = typeof result.retry_after_seconds === "number" ? Math.max(1, result.retry_after_seconds) : Math.ceil(windowMs / 1000);
        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({
          error: "RATE_LIMITED",
          message: "Too many requests. Please try again later.",
        });
        return;
      }

      next();
    } catch (error) {
      req.log.error({ code: safeDatabaseErrorCode(error) }, "Privacy rate limiter storage failed");
      res.status(503).json({
        error: "RATE_LIMIT_UNAVAILABLE",
        message: "This request cannot be processed right now.",
      });
    }
  };
}
