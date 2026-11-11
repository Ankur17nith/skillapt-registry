#!/usr/bin/env node
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const isProduction =
  process.env.ENVIRONMENT === "production" ||
  process.env.NODE_ENV === "production";

if (isProduction) {
  console.error("Refusing to seed database: ENVIRONMENT is production!");
  process.exit(1);
}

if (args.includes("--remote")) {
  console.error("Refusing to seed database: --remote flag is prohibited for seed script!");
  process.exit(1);
}

console.log("Seeding local D1 database from migrations/seed.sql...");
execSync("npx wrangler d1 execute DB --local --file=migrations/seed.sql", {
  stdio: "inherit"
});
