import { Hono } from "hono";
import { cors } from "hono/cors";
import { PRODUCT_NAME, REGISTRY_VERSION } from "./config";
import type { Env } from "./types";

export const app = new Hono<{ Bindings: Env }>();

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

app.notFound((c) => {
  return c.json(
    {
      error: {
        code: "NOT_FOUND",
        message: 
      }
    },
    404
  );
});

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

export default app;
