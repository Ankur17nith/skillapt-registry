import type { Context, Next } from "hono";
import type { Env } from "../types";
import {
  type RateLimiter,
  InMemoryRateLimiter,
  DurableObjectRateLimiter
} from "../rate-limiter/do";

export const defaultInMemoryLimiter = new InMemoryRateLimiter();

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (c: Context<{ Bindings: Env }>) => string;
}

export function getClientIp(c: Context<{ Bindings: Env }>): string {
  // Use ONLY cf-connecting-ip for client IP (never x-forwarded-for or x-real-ip)
  return c.req.header("cf-connecting-ip") || "unknown-ip";
}

function resolveRateLimiter(c: Context<{ Bindings: Env }>): RateLimiter {
  if (c.env?.RATE_LIMITER) {
    return c.env.RATE_LIMITER;
  }
  if (c.env?.RATE_LIMITER_DO) {
    return new DurableObjectRateLimiter(c.env.RATE_LIMITER_DO);
  }
  return defaultInMemoryLimiter;
}

/**
 * Imperative rate-limit check for handlers that cannot use the middleware
 * (for example because the key depends on the authenticated user).
 * Returns true when the request is allowed.
 */
export async function checkRateLimit(
  c: Context<{ Bindings: Env }>,
  key: string,
  windowMs: number,
  maxRequests: number
): Promise<boolean> {
  const result = await resolveRateLimiter(c).check(key, windowMs, maxRequests);
  return result.allowed;
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, maxRequests, keyGenerator } = options;

  return async (c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> => {
    const limiter = resolveRateLimiter(c);
    const clientIp = getClientIp(c);
    const key = keyGenerator ? keyGenerator(c) : `${c.req.path}:${clientIp}`;

    const result = await limiter.check(key, windowMs, maxRequests);

    c.header("X-RateLimit-Limit", maxRequests.toString());

    if (!result.allowed) {
      c.header("Retry-After", result.retryAfterSeconds.toString());
      c.header("X-RateLimit-Remaining", "0");
      c.header("X-RateLimit-Reset", Math.ceil(result.resetAt / 1000).toString());
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Rate limit exceeded. Please try again later.",
            retryAfter: result.retryAfterSeconds
          }
        },
        429
      );
    }

    c.header("X-RateLimit-Remaining", Math.max(0, maxRequests - result.count).toString());
    c.header("X-RateLimit-Reset", Math.ceil(result.resetAt / 1000).toString());

    return next();
  };
}

export function resetRateLimits(): void {
  defaultInMemoryLimiter.reset();
}
