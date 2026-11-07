import { Hono } from "hono";
import { cors } from "hono/cors";
import { PRODUCT_NAME, REGISTRY_VERSION } from "./config";
import type { Env } from "./types";

export const app = new Hono<{ Bindings: Env }>();

// Enable CORS with origin checking
app.use("*", async (c, next) => {
  const allowedOrigins = (c.env?.CORS_ORIGIN || "http://localhost:3000,http://localhost:5173,https://skillapt.dev")
    .split(",")
    .map((o) => o.trim());

  const originHeader = c.req.header("Origin");
  const isAllowed = originHeader && (allowedOrigins.includes(originHeader) || allowedOrigins.includes("*"));

  return cors({
    origin: isAllowed ? originHeader : allowedOrigins[0],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    exposeHeaders: ["ETag", "Retry-After"],
    credentials: true,
    maxAge: 86400
  })(c, next);
});

// Standard JSON error handling
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : "An unexpected server error occurred."
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

// Mount API routes
app.route("/v1/skills", skillsRouter);
app.route("/v1/auth", authRouter);
app.route("/v1/tokens", tokensRouter);
app.route("/v1/me", meRouter);
app.route("/v1/reports", reportsRouter);
app.route("/v1/stats", statsRouter);

export default app;
