import { Hono } from "hono";
import type { Context, Next } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { PRODUCT_NAME, REGISTRY_VERSION } from "./config";
import { getAllowedOrigins, hasWildcardOrigin, isProductionLike } from "./utils/environment";
import type { Env } from "./types";

export const app = new Hono<{ Bindings: Env }>();

// Security headers and CORS with an exact-match origin allowlist
app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  c.header("Vary", "Origin");
  if (isProductionLike(c.env)) {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  if (hasWildcardOrigin(c.env)) {
    return c.json(
      {
        error: {
          code: "CONFIG_ERROR",
          message: "CORS wildcard '*' is not allowed when credentials are enabled."
        }
      },
      500
    );
  }

  const allowedOrigins = getAllowedOrigins(c.env);
  const originHeader = c.req.header("Origin");
  const isAllowed = originHeader ? allowedOrigins.includes(originHeader) : false;

  return cors({
    origin: (origin) => (isAllowed ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    exposeHeaders: ["ETag", "Retry-After"],
    credentials: true,
    maxAge: 86400
  })(c, next);
});

// Standard JSON error handling
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  const requestId = c.req.header("cf-ray") || crypto.randomUUID();
  const isProd = isProductionLike(c.env);
  return c.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: isProd
          ? "An unexpected server error occurred."
          : (err instanceof Error ? err.message : "An unexpected server error occurred."),
        requestId
      }
    },
    500
  );
});

// Standard 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: {
        code: "NOT_FOUND",
        message: `Endpoint ${c.req.method} ${c.req.path} not found.`
      }
    },
    404
  );
});

// Health check route
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    product: PRODUCT_NAME,
    version: REGISTRY_VERSION,
    timestamp: new Date().toISOString()
  });
});

app.get("/v1/health", (c) => {
  return c.json({
    status: "ok",
    product: PRODUCT_NAME,
    version: REGISTRY_VERSION,
    timestamp: new Date().toISOString()
  });
});

import { formatLlmsTxt } from "./utils/text";
import { skillsRouter } from "./routes/skills";
import { authRouter } from "./routes/auth";
import { tokensRouter, meRouter } from "./routes/tokens";
import { reportsRouter } from "./routes/reports";
import { statsRouter } from "./routes/stats";
import { adminRouter } from "./routes/admin";
import { dashboardRouter } from "./routes/dashboard";
import { categoriesRouter } from "./routes/categories";
import { rateLimit, getClientIp } from "./middleware/rate-limit";

// Agent-facing guide, served at the root and under /v1.
const llmsHandler = (c: Context<{ Bindings: Env }>) => {
  const origin = c.env?.PUBLIC_ORIGIN || new URL(c.req.url).origin;
  c.header("Cache-Control", "public, max-age=3600");
  return c.text(formatLlmsTxt(origin.replace(/\/$/, "")));
};
app.get("/llms.txt", llmsHandler);
app.get("/v1/llms.txt", llmsHandler);

// General API Rate Limit: 300 requests / minute per IP or Token
app.use(
  "/v1/*",
  rateLimit({
    windowMs: 60 * 1000,
    maxRequests: 300,
    keyGenerator: (c) => `general:${getClientIp(c)}`
  })
);

// Read-only maintenance mode: reads, health checks and logout keep working.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAINTENANCE_ALLOWED_POSTS = new Set(["/v1/auth/logout", "/dashboard/logout"]);
const maintenanceGuard = async (c: Context<{ Bindings: Env }>, next: Next) => {
  if (
    c.env?.MAINTENANCE_MODE === "true" &&
    !SAFE_METHODS.has(c.req.method) &&
    !MAINTENANCE_ALLOWED_POSTS.has(c.req.path)
  ) {
    c.header("Retry-After", "600");
    return c.json(
      {
        error: {
          code: "MAINTENANCE",
          message: "Registry is in scheduled read-only maintenance mode."
        }
      },
      503
    );
  }
  return next();
};
app.use("/v1/*", maintenanceGuard);
app.use("/dashboard/*", maintenanceGuard);

// Cap request bodies on everything except the package upload (which streams
// through its own 5 MB limit): JSON endpoints never need more than a few KB.
const jsonBodyLimit = bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) =>
    c.json(
      { error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the 64 KB limit." } },
      413
    )
});
app.use("/v1/*", async (c, next) => {
  if (c.req.method === "POST" && c.req.path === "/v1/skills") return next();
  return jsonBodyLimit(c, next);
});
app.use("/dashboard/*", jsonBodyLimit);

// Mount API routes
app.route("/v1/skills", skillsRouter);
app.route("/v1/auth", authRouter);
app.route("/v1/tokens", tokensRouter);
app.route("/v1/me", meRouter);
app.route("/v1/reports", reportsRouter);
app.route("/v1/stats", statsRouter);
app.route("/v1/categories", categoriesRouter);
app.route("/v1/admin", adminRouter);
app.route("/dashboard", dashboardRouter);

export { RateLimiterDO } from "./rate-limiter/do";

export async function handleScheduled(
  _event: { cron?: string; scheduledTime?: number },
  env: Env,
  _ctx?: ExecutionContext
): Promise<{ purgedSessions: number; purgedDedupe: number; purgedTokens: number }> {
  const now = new Date().toISOString();
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // 1. Purge expired sessions
  const sessionRes = await env.DB.prepare(
    "DELETE FROM sessions WHERE datetime(expires_at) < datetime(?)"
  ).bind(now).run();
  const purgedSessions = sessionRes.meta?.changes ?? 0;

  // 2. Purge old download_dedupe rows older than 2 days
  const dedupeRes = await env.DB.prepare(
    "DELETE FROM download_dedupe WHERE day < ?"
  ).bind(twoDaysAgo).run();
  const purgedDedupe = dedupeRes.meta?.changes ?? 0;

  // 3. Purge expired tokens
  const tokenRes = await env.DB.prepare(
    "DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime(?)"
  ).bind(now).run();
  const purgedTokens = tokenRes.meta?.changes ?? 0;

  return { purgedSessions, purgedDedupe, purgedTokens };
}

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    await handleScheduled(
      { cron: controller.cron, scheduledTime: controller.scheduledTime },
      env,
      ctx
    );
  }
};
