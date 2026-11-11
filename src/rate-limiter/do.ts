import type { DurableObjectNamespace, DurableObjectState } from "@cloudflare/workers-types";
import type { Env } from "../types";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string, windowMs: number, maxRequests: number): Promise<RateLimitResult>;
}

export class InMemoryRateLimiter implements RateLimiter {
  private store = new Map<string, { count: number; resetAt: number }>();

  async check(key: string, windowMs: number, maxRequests: number): Promise<RateLimitResult> {
    const now = Date.now();
    let record = this.store.get(key);

    if (!record || now > record.resetAt) {
      record = {
        count: 1,
        resetAt: now + windowMs
      };
      this.store.set(key, record);
    } else {
      record.count++;
    }

    const allowed = record.count <= maxRequests;
    const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));

    return {
      allowed,
      count: record.count,
      resetAt: record.resetAt,
      retryAfterSeconds
    };
  }

  reset(): void {
    this.store.clear();
  }
}

export class DurableObjectRateLimiter implements RateLimiter {
  private namespace: DurableObjectNamespace;

  constructor(namespace: DurableObjectNamespace) {
    this.namespace = namespace;
  }

  async check(key: string, windowMs: number, maxRequests: number): Promise<RateLimitResult> {
    const id = this.namespace.idFromName("rate-limiter");
    const stub = this.namespace.get(id);

    const res = await stub.fetch("http://rate-limiter/limit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, windowMs, maxRequests })
    });

    if (!res.ok) {
      return {
        allowed: true,
        count: 1,
        resetAt: Date.now() + windowMs,
        retryAfterSeconds: 1
      };
    }

    return (await res.json()) as RateLimitResult;
  }
}

export class RateLimiterDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    try {
      this.state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS rate_limits (
          key TEXT PRIMARY KEY,
          count INTEGER NOT NULL,
          reset_at INTEGER NOT NULL
        )
      `);
    } catch {
      // Fallback
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/limit" && request.method === "POST") {
      const { key, windowMs, maxRequests } = (await request.json()) as {
        key: string;
        windowMs: number;
        maxRequests: number;
      };
      const now = Date.now();

      let count = 1;
      let resetAt = now + windowMs;

      try {
        const rows = this.state.storage.sql.exec(
          "SELECT count, reset_at FROM rate_limits WHERE key = ?",
          key
        ).toArray() as { count: number; reset_at: number }[];

        const row = rows[0];
        if (row && now <= row.reset_at) {
          count = row.count + 1;
          resetAt = row.reset_at;
          this.state.storage.sql.exec(
            "UPDATE rate_limits SET count = ? WHERE key = ?",
            count,
            key
          );
        } else {
          this.state.storage.sql.exec(
            "INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)",
            key,
            count,
            resetAt
          );
        }
      } catch {
        // Fallback for non-SQL storage
        const stored = (await this.state.storage.get<{ count: number; resetAt: number }>(key)) || null;
        if (stored && now <= stored.resetAt) {
          count = stored.count + 1;
          resetAt = stored.resetAt;
        }
        await this.state.storage.put(key, { count, resetAt });
      }

      const allowed = count <= maxRequests;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));

      return Response.json({
        allowed,
        count,
        resetAt,
        retryAfterSeconds
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
