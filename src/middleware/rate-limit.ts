import type { Context, Next } from "hono";
import type { Env } from "../types";

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

// In-memory sliding-window store
const rateLimitStore = new Map<string, RateLimitRecord>();

// Periodic cleanup to avoid memory leak
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitStore.entries()) {
      if (now > record.resetAt) {
        rateLimitStore.delete(key);
      }
    }
  }, 60000).unref?.();
}

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (c: Context<{ Bindings: Env }>) => string;
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, maxRequests, keyGenerator } = options;

  return async (c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> => {
    const clientIp =
      c.req.header("cf-connecting-ip") ||
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      "127.0.0.1";

    const key = keyGenerator ? keyGenerator(c) : `${c.req.path}:${clientIp}`;
    const now = Date.now();

    let record = rateLimitStore.get(key);

    if (!record || now > record.resetAt) {
      record = {
        count: 1,
        resetAt: now + windowMs
      };
      rateLimitStore.set(key, record);
    } else {
      record.count++;
    }

    if (record.count > maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
      c.header("Retry-After", retryAfterSeconds.toString());
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Rate limit exceeded. Please try again later."
          }
        },
        429
      );
    }

    return next();
  };
}

export function resetRateLimits(): void {
  rateLimitStore.clear();
}
