import { Hono } from "hono";
import { cors } from "hono/cors";
import { PRODUCT_NAME, REGISTRY_VERSION } from "./config";
import type { Env } from "./types";

export const app = new Hono<{ Bindings: Env }>();

// Enable CORS with origin checking & security headers
app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Vary", "Origin");

  const rawOrigins = c.env?.CORS_ORIGIN || "http://localhost:3000,http://localhost:5173,https://skillapt.dev";
  const originsList = rawOrigins.split(",").map((o) => o.trim()).filter(Boolean);

  if (originsList.includes("*")) {
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

  let allowedOrigins = originsList;
  if (c.env?.ENVIRONMENT === "production") {
    allowedOrigins = originsList.filter((o) => !o.includes("localhost") && !o.includes("127.0.0.1"));
  }

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
  const isProd = c.env?.ENVIRONMENT === "production";
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

import { skillsRouter } from "./routes/skills";
import { authRouter } from "./routes/auth";
import { tokensRouter, meRouter } from "./routes/tokens";
import { reportsRouter } from "./routes/reports";
import { statsRouter } from "./routes/stats";
import { adminRouter } from "./routes/admin";

// Mount API routes
app.route("/v1/skills", skillsRouter);
app.route("/v1/auth", authRouter);
app.route("/v1/tokens", tokensRouter);
app.route("/v1/me", meRouter);
app.route("/v1/reports", reportsRouter);
app.route("/v1/stats", statsRouter);
app.route("/v1/admin", adminRouter);

export default app;
